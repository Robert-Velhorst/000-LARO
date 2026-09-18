import { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import { randomBytes } from 'crypto';
import log from 'electron-log';
import { IPC_CHANNELS, Platform, ScanConfig, AgentConfig } from '../shared/types';
import {
  initDatabase as initAgentDb,
  closeDatabase as closeAgentDb,
  createScan,
  cancelPausedScanUpload,
  getScan,
  getScanFiles,
  setScanFileSelection,
} from './database';
import { FileScanner } from './scanner';
import { FileUploader } from './uploader';
import { isDesktopDevelopmentMode, resolveDesktopServerPort } from './desktopPort';
import { acquireSingleInstanceLock } from './singleInstance';
import { installDenyByDefaultPermissions } from './sessionPermissions';
import { ensureDesktopSecrets } from './desktopSecrets';
import { loadProtectedProviderConfig } from './providerConfig';
import { getDesktopScannerAuth, getRemoteUploadAuth, createDesktopScannerHeaders } from './scannerAuth';
import { resolveDesktopConnection } from './remoteConnection';
import { pickAndStartLocalSource } from './documentSources';
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '../server/routers';
// NOTE: server/index.ts reads `.env` (dotenv) at import time, so it is imported
// lazily in startApp() AFTER we pin NODE_ENV from app.isPackaged. This guarantees
// a packaged build runs the server in production mode even if the bundled .env
// (or DOTENV secret) mistakenly contains NODE_ENV=development.

const DEFAULT_PORT = 3000;
let laroUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
let remoteServerUrl: string | null = null;
let stopIntegratedServer: (() => Promise<void>) | null = null;
let shutdownStarted = false;
const isDev = isDesktopDevelopmentMode(app.isPackaged, process.env.NODE_ENV);
let mainWindow: BrowserWindow | null = null;
const ownsDesktopProfile = acquireSingleInstanceLock(app, () => mainWindow);

// ─── Error Handling ─────────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  console.error('[Electron] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Electron] Unhandled Rejection:', reason);
});

let scanPanel: BrowserWindow | null = null;
let currentScanner: FileScanner | null = null;
let currentUploader: FileUploader | null = null;
let uploadStarting = false;
const approvedScanFolders = new Set<string>();

let agentConfig: AgentConfig = {
  caseId: null,
  apiUrl: laroUrl,
  deviceName: os.hostname(),
};

function getPlatform(): Platform {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function isTrustedAppUrl(rawUrl: string): boolean {
  try {
    const origin = new URL(rawUrl).origin;
    if (origin === new URL(laroUrl).origin) return true;
    return !remoteServerUrl && isDev && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
  } catch {
    return false;
  }
}

function assertTrustedIpc(event: Electron.IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedAppUrl(senderUrl)) throw new Error('Blocked IPC from an untrusted renderer');
}

function isOAuthProviderUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return url.hostname === 'accounts.google.com' || url.hostname === 'login.microsoftonline.com';
  } catch {
    return false;
  }
}

function isOAuthStartUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === new URL(laroUrl).origin &&
      /\/api\/oauth\/(gmail|outlook)\/start$/.test(url.pathname) &&
      Boolean(url.searchParams.get('state')) &&
      Boolean(url.searchParams.get('ticket'));
  } catch {
    return false;
  }
}

function hardenWindowNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (url.includes('/api/oauth/') || !isTrustedAppUrl(url)) {
      event.preventDefault();
      void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked navigation:', error));
    }
  });
  window.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (isOAuthProviderUrl(url) || isOAuthStartUrl(url)) {
      // Google forbids OAuth inside embedded user agents. Use the operating
      // system browser and let the renderer poll the saved connection state.
      void openExternalUrl(url).catch((error) => console.error('[Electron] OAuth browser failed:', error));
      return { action: 'deny' };
    }
    if (url.includes('/api/oauth/')) {
      void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked OAuth URL:', error));
      return { action: 'deny' };
    }
    if (isTrustedAppUrl(url)) return { action: 'allow' };
    void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked external URL:', error));
    return { action: 'deny' };
  });
}

async function openExternalUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol === 'file:') {
    const storageBase = path.resolve(
      process.env.LOCAL_STORAGE_DIR || path.join(app.getPath('userData'), 'uploads')
    );
    const filePath = path.resolve(fileURLToPath(url));
    if (filePath !== storageBase && !filePath.startsWith(storageBase + path.sep)) {
      throw new Error('Blocked local file outside LARO evidence storage');
    }
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    return;
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'mailto:' && !localHttp) {
    throw new Error(`Blocked external URL protocol: ${url.protocol}`);
  }
  await shell.openExternal(url.toString());
}

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'LARO Desktop',
    backgroundColor: '#0f172a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    scanPanel?.close();
  });

  hardenWindowNavigation(mainWindow);

  console.log(`[Electron] NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`[Electron] isDev: ${isDev}`);

  if (isDev && !remoteServerUrl) {
    const devUrl = 'http://localhost:5173';
    console.log(`[Electron] Attempting to load Vite Dev Server: ${devUrl}`);
    try {
      await mainWindow.loadURL(devUrl);
      console.log('[Electron] Vite Dev Server loaded successfully');
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    } catch (err) {
      console.error('[Electron] Failed to load Vite Dev Server. Is it running? Error:', err);
      // Fallback to production URL if Vite fails in dev
      await mainWindow.loadURL(laroUrl);
    }
  } else {
    console.log(`[Electron] Loading Production URL: ${laroUrl}`);
    try {
      await mainWindow.loadURL(laroUrl);
    } catch (err) {
      console.error('[Electron] Failed to load Production URL. Did you run npm run build? Error:', err);
      if (remoteServerUrl) {
        dialog.showErrorBox('LARO server unavailable', 'The configured LARO server could not be reached. Check your connection and server address, then use LARO > Reload to try again.');
      }
    }
    if (process.env.DEBUG) mainWindow.webContents.openDevTools();
  }
}

function createScanPanel(): void {
  if (scanPanel) {
    scanPanel.focus();
    return;
  }
  scanPanel = new BrowserWindow({
    width: 520,
    height: 700,
    minWidth: 480,
    title: 'LARO Evidence Scanner',
    backgroundColor: '#0f172a',
    parent: mainWindow ?? undefined,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  hardenWindowNavigation(scanPanel);

  if (isDev && !remoteServerUrl) {
    scanPanel.loadURL('http://localhost:5173/?mode=scanner');
  } else {
    scanPanel.loadURL(`${laroUrl}/?mode=scanner`);
  }
  scanPanel.on('closed', () => {
    currentScanner?.stop();
    currentUploader?.stop();
    scanPanel = null;
    approvedScanFolders.clear();
    agentConfig = { ...agentConfig, caseId: null };
  });
}

function buildMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'LARO',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.loadURL(laroUrl) },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'Evidence',
      submenu: [
        { label: 'Scan Local Files', accelerator: 'CmdOrCtrl+Shift+S', click: createScanPanel },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(isDev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const }] : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]));
}

if (ownsDesktopProfile) app.whenReady().then(async () => {
  installDenyByDefaultPermissions(session.defaultSession);

  // Initialize App Data Directory for SQLite
  const userDataPath = app.getPath('userData');
  if (!fs.existsSync(userDataPath)) {
    fs.mkdirSync(userDataPath, { recursive: true });
  }

  try {
    remoteServerUrl = resolveDesktopConnection({
      userDataPath,
      argv: process.argv,
      serverUrl: process.env.LARO_DESKTOP_SERVER_URL,
    });
  } catch (error) {
    dialog.showErrorBox('Server Connection', error instanceof Error ? error.message : String(error));
    app.quit();
    return;
  }

  if (remoteServerUrl) {
    laroUrl = remoteServerUrl;
    agentConfig.apiUrl = remoteServerUrl;
    // Keep native scan/review state local and isolated per server. Cases,
    // evidence, provider tokens, and sign-in are owned by the remote backend.
    initAgentDb(remoteServerUrl);
    buildMenu();
    setupIPC();
    await createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
    return;
  }

  try {
    const providerConfig = loadProtectedProviderConfig({
      userDataPath,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      cwd: process.cwd(),
    });
    if (providerConfig.loaded) {
      log.info(
        `[Electron] Protected provider configuration loaded (${providerConfig.appliedKeys.length} settings).`,
      );
    }
  } catch (error) {
    log.error('[Electron] Protected provider configuration failed:', error);
    dialog.showErrorBox(
      'Provider Configuration Error',
      'LARO could not securely load the configured Google or outbound-email settings. ' +
        'Reconfigure the protected provider store before starting LARO.',
    );
    app.quit();
    return;
  }

  // Set database path for the server (better-sqlite3)
  const serverDbPath = path.join(userDataPath, 'laro-server.sqlite');
  process.env.DATABASE_URL = serverDbPath;
  console.log('[Electron] Server DB Path:', serverDbPath);

  try {
    const secretResult = ensureDesktopSecrets(userDataPath);
    console.log(`[Electron] Desktop secrets ready (${secretResult.source}).`);
  } catch (error) {
    log.error('[Electron] Desktop secret initialization failed:', error);
    dialog.showErrorBox(
      'Security Setup Error',
      "LARO could not securely load or persist this installation's secrets. " +
        'Check the user-data permissions or restore laro-secrets.json. LARO will close without opening the database.',
    );
    app.quit();
    return;
  }

  // Phase 015: local evidence storage lives under userData when S3 is not
  // configured, so file uploads are actually persisted (not dropped).
  if (!process.env.LOCAL_STORAGE_DIR) {
    process.env.LOCAL_STORAGE_DIR = path.join(userDataPath, 'uploads');
  }
  if (!process.env.LARO_BACKUP_DIRECTORY) {
    process.env.LARO_BACKUP_DIRECTORY = path.join(userDataPath, 'backups');
    process.env.LARO_BACKUP_DESTINATION_KIND = 'local';
  }

  // Initialize Agent DB (scanning state)
  initAgentDb();

  // Start the integrated backend server.
  // Pin NODE_ENV from the packaging state BEFORE importing the server (whose
  // module-level dotenv.config() must not be able to override it — dotenv leaves
  // already-set env vars untouched). This is what keeps a packaged build serving
  // the renderer (otherwise NODE_ENV=development disables static serving -> 404).
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = app.isPackaged ? 'production' : 'development';
  } else if (app.isPackaged && process.env.NODE_ENV !== 'production') {
    console.warn(
      `[Electron] Overriding NODE_ENV="${process.env.NODE_ENV}" -> "production" in packaged build`
    );
    process.env.NODE_ENV = 'production';
  }
  process.env.LARO_PACKAGED_DESKTOP = app.isPackaged ? 'true' : 'false';

  process.env.LARO_APP_VERSION = app.getVersion();
  process.env.HOST = '127.0.0.1';
  process.env.LARO_DESKTOP_SCANNER_SECRET = randomBytes(32).toString('base64url');

  try {
    const { startServer, stopServer } = await import('../server/index');
    const requestedPort = app.isPackaged
      ? resolveDesktopServerPort(process.env.OAUTH_REDIRECT_BASE_URL)
      : DEFAULT_PORT;
    const actualPort = await startServer(requestedPort);
    stopIntegratedServer = stopServer;
    laroUrl = `http://127.0.0.1:${actualPort}`;
    agentConfig.apiUrl = laroUrl;
    const allowedOrigins = new Set(
      (process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean)
    );
    allowedOrigins.add(laroUrl);
    process.env.ALLOWED_ORIGINS = [...allowedOrigins].join(',');
    if (!process.env.OAUTH_REDIRECT_BASE_URL) process.env.OAUTH_REDIRECT_BASE_URL = laroUrl;
    console.log('[Electron] Integrated server started on port', actualPort);
  } catch (err) {
    console.error('[Electron] Failed to start integrated server:', err);
    dialog.showErrorBox('Server Error', 'Failed to start the integrated backend server.');
    app.quit();
    return;
  }

  buildMenu();
  setupIPC();
  await createMainWindow();

  console.log('[Electron] Application ready and window created');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  shutdownStarted = true;
  currentScanner?.stop();
  currentUploader?.stop();
  void (stopIntegratedServer?.() ?? Promise.resolve())
    .catch((error) => log.error('[Electron] Integrated server shutdown failed:', error))
    .finally(() => {
      closeAgentDb();
      app.quit();
    });
});

function setupIPC(): void {
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, (event) => {
    assertTrustedIpc(event);
    return { ...agentConfig, localSourcesAvailable: !remoteServerUrl };
  });
  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, (event, c: Partial<AgentConfig>) => {
    assertTrustedIpc(event);
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('Invalid scanner configuration');
    const next: Partial<AgentConfig> = {};
    if (c.caseId === null || (typeof c.caseId === 'string' && c.caseId.length <= 200)) next.caseId = c.caseId;
    agentConfig = { ...agentConfig, ...next };
    return { ...agentConfig };
  });
  ipcMain.handle(IPC_CHANNELS.SYSTEM_INFO, (event) => {
    assertTrustedIpc(event);
    return {
      platform: getPlatform(),
      arch: process.arch,
      hostname: os.hostname(),
      username: os.userInfo().username,
      homeDir: os.homedir(),
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      cpus: os.cpus().length,
      version: app.getVersion(),
    };
  });
  ipcMain.handle(IPC_CHANNELS.APP_VERSION, (event) => { assertTrustedIpc(event); return app.getVersion(); });
  ipcMain.handle(IPC_CHANNELS.OPEN_EXTERNAL, (event, url: string) => {
    assertTrustedIpc(event);
    return openExternalUrl(url);
  });
  ipcMain.handle(IPC_CHANNELS.RENDERER_ERROR_REPORT, (event, report: unknown) => {
    assertTrustedIpc(event);
    if (!report || typeof report !== 'object') throw new Error('Invalid renderer error report');
    const input = report as Record<string, unknown>;
    const bounded = (value: unknown, length: number) => typeof value === 'string' ? value.slice(0, length) : undefined;
    const message = bounded(input.message, 1_000);
    if (!message) throw new Error('Renderer error message is required');
    log.error('[RendererBoundary]', {
      message,
      stack: bounded(input.stack, 8_000),
      componentStack: bounded(input.componentStack, 8_000),
      route: bounded(input.route, 500),
    });
  });
  ipcMain.handle(IPC_CHANNELS.SCAN_OPEN_PANEL, (event) => {
    assertTrustedIpc(event);
    return createScanPanel();
  });
  ipcMain.handle(IPC_CHANNELS.FOLDER_SELECT, async (event) => {
    assertTrustedIpc(event);
    const parent = scanPanel ?? mainWindow;
    if (!parent) return null;
    const result = await dialog.showOpenDialog(parent, {
      properties: ['openDirectory', 'multiSelections'],
      title: 'Select folders to scan',
    });
    if (result.canceled) return null;
    const folders = result.filePaths.map((folder) => path.resolve(folder));
    for (const folder of folders) approvedScanFolders.add(folder);
    return folders;
  });
  
  ipcMain.handle(IPC_CHANNELS.SOURCE_FOLDER_START, async (event) => {
    assertTrustedIpc(event);
    if (!isTrustedAppUrl(agentConfig.apiUrl)) throw new Error('Source API URL is not trusted');
    const cookieUrl = event.sender.getURL();
    const browserSession = event.sender.session;
    const apiUrl = agentConfig.apiUrl;
    return pickAndStartLocalSource({
      apiUrl,
      remote: !!remoteServerUrl,
      pickFolder: async () => {
        const parent = mainWindow ?? scanPanel;
        if (!parent) return null;
        const result = await dialog.showOpenDialog(parent, { properties: ['openDirectory'], title: 'Select source folder' });
        assertTrustedIpc(event);
        return result.canceled ? null : result.filePaths[0] || null;
      },
      start: async (input) => {
        const client = createTRPCProxyClient<AppRouter>({ transformer: superjson, links: [httpBatchLink({
          url: `${apiUrl.replace(/\/$/, '')}/api/trpc`,
          headers: createDesktopScannerHeaders(() => getDesktopScannerAuth({ cookieUrl,
            cookieName: process.env.LARO_SESSION_COOKIE_NAME,
            scannerSecret: process.env.LARO_DESKTOP_SCANNER_SECRET || '', cookieStore: browserSession.cookies })),
        })] });
        return client.documentSources.start.mutate(input);
      },
    });
  });

  ipcMain.handle(IPC_CHANNELS.SCAN_START, async (event, config: ScanConfig) => {
    assertTrustedIpc(event);
    if (currentScanner) throw new Error('Scan already in progress');
    if (!config || typeof config.caseId !== 'string' || !config.caseId.trim()) throw new Error('Select a case first');
    const folders = Array.isArray(config.folders) ? config.folders.map((folder) => path.resolve(String(folder))) : [];
    if (!folders.length) throw new Error('Select at least one folder to scan');
    for (const folder of folders) {
      if (!approvedScanFolders.has(folder)) throw new Error('Every scan folder must be selected through the folder picker');
      if (!fs.statSync(folder).isDirectory()) throw new Error(`Scan path is not a directory: ${folder}`);
    }
    approvedScanFolders.clear();
    const safeConfig: ScanConfig = {
      caseId: config.caseId.trim(),
      caseName: String(config.caseName || config.caseId).slice(0, 500),
      autoUpload: false,
      folders,
      excludedFolders: [],
    };
    const scanId = nanoid();
    createScan(scanId, safeConfig.caseId, safeConfig.caseName, false, []);
    currentScanner = new FileScanner({ scanId, config: safeConfig, platform: getPlatform() });
    currentScanner.on('progress', (p) => scanPanel?.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, { scanId, ...p }));
    currentScanner.on('completed', async (result) => {
      scanPanel?.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, {
        scanId,
        status: 'review',
        ...result,
      });
      mainWindow?.webContents.send(IPC_CHANNELS.EVIDENCE_UPDATED, { scanId });
      currentScanner = null;
    });
    currentScanner.on('cancelled', () => {
      scanPanel?.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, { scanId, status: 'cancelled' });
      currentScanner = null;
    });
    currentScanner.on('error', (e: Error) => {
      scanPanel?.webContents.send(IPC_CHANNELS.SCAN_PROGRESS, { scanId, status: 'failed', errorMessage: e.message });
      currentScanner = null;
    });
    currentScanner.start().catch(console.error);
    return { scanId };
  });

  ipcMain.handle(IPC_CHANNELS.SCAN_STOP, (event) => { assertTrustedIpc(event); currentScanner?.stop(); return { success: true }; });
  ipcMain.handle(IPC_CHANNELS.SCAN_PAUSE, (event) => { assertTrustedIpc(event); currentScanner?.pause(); return { success: true }; });
  ipcMain.handle(IPC_CHANNELS.SCAN_RESUME, (event) => { assertTrustedIpc(event); currentScanner?.resume(); return { success: true }; });
  ipcMain.handle(IPC_CHANNELS.SCAN_FILES_GET, (event, id: string) => {
    assertTrustedIpc(event);
    return { files: getScanFiles(String(id).slice(0, 200)) };
  });
  ipcMain.handle(IPC_CHANNELS.SCAN_PROGRESS_GET, (event, id: string) => {
    assertTrustedIpc(event);
    return { progress: getScan(String(id).slice(0, 200)) };
  });
  ipcMain.handle(IPC_CHANNELS.SCAN_FILES_SELECT, async (event, id: string, fileIds: string[]) => {
    assertTrustedIpc(event);
    const safeIds = Array.isArray(fileIds) ? fileIds.map(String).filter((value) => value.length <= 200) : [];
    return setScanFileSelection(String(id).slice(0, 200), safeIds);
  });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_START, (event, id: string) => {
    assertTrustedIpc(event);
    const rendererUrl = event.senderFrame?.url || event.sender.getURL();
    return startUpload(id, rendererUrl);
  });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_PAUSE, (event) => { assertTrustedIpc(event); currentUploader?.pause(); return { success: true }; });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_RESUME, (event) => {
    assertTrustedIpc(event);
    if (!currentUploader) return { success: false };
    currentUploader.resume();
    return { success: true };
  });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_STOP, (event, id: string) => {
    assertTrustedIpc(event);
    if (currentUploader) {
      currentUploader.stop();
      return { success: true };
    }
    return { success: cancelPausedScanUpload(String(id).slice(0, 200)) };
  });
}

async function startUpload(scanId: string, cookieUrl: string): Promise<{ success: boolean }> {
  if (currentUploader || uploadStarting) throw new Error('Upload in progress');
  if (!isTrustedAppUrl(agentConfig.apiUrl)) throw new Error('Scanner API URL is not trusted');
  uploadStarting = true;
  try {
    const browserSession = (mainWindow ?? scanPanel)?.webContents.session ?? session.defaultSession;
    const resolveAuth = () => remoteServerUrl ? getRemoteUploadAuth({
      cookieUrl: remoteServerUrl,
      cookieStore: browserSession.cookies,
    }) : getDesktopScannerAuth({
      cookieUrl,
      cookieName: process.env.LARO_SESSION_COOKIE_NAME,
      scannerSecret: process.env.LARO_DESKTOP_SCANNER_SECRET || '',
      cookieStore: browserSession.cookies,
    });
    await resolveAuth();
    const safeScanId = String(scanId).slice(0, 200);
    currentUploader = new FileUploader({
      scanId: safeScanId,
      apiUrl: agentConfig.apiUrl,
      resolveAuth,
      remote: !!remoteServerUrl,
      // One raw binary body at a time keeps scanner memory and server request
      // admission bounded even when several files are at the 7 MB limit.
      concurrency: 1,
      maxRetries: 3,
    });
    currentUploader.on('progress', (p) => scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, { scanId: safeScanId, ...p }));
    currentUploader.on('completed', (r) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        done: true,
        status: r.partial ? 'failed' : 'completed',
        ...r,
      });
      mainWindow?.webContents.send(IPC_CHANNELS.EVIDENCE_UPDATED, { scanId: safeScanId });
      currentUploader = null;
    });
    currentUploader.on('file-failed', (failure) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        fileId: failure.fileId,
        failed: true,
        uploadStatus: failure.uploadStatus,
        errorMessage: failure.error,
      });
    });
    currentUploader.on('file-retryable', (failure) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        fileId: failure.fileId,
        retryable: true,
        uploadStatus: failure.uploadStatus,
        authorizationRequired: failure.authorizationRequired,
        errorMessage: failure.error,
      });
    });
    currentUploader.on('file-cancelled', (failure) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        fileId: failure.fileId,
        cancelled: true,
        uploadStatus: failure.uploadStatus,
        errorMessage: failure.error,
      });
    });
    currentUploader.on('file-review-required', (failure) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        fileId: failure.fileId,
        reviewRequired: true,
        uploadStatus: failure.uploadStatus,
        errorMessage: failure.error,
      });
    });
    currentUploader.on('review-required', (result) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        done: true,
        reviewRequired: true,
        ...result,
      });
      currentUploader = null;
    });
    const pauseForRetry = (result: any) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        done: true,
        retryable: true,
        status: 'upload-paused',
        errorMessage: result.error || `${result.retryableFiles || 1} upload(s) can be resumed.`,
        ...result,
      });
      currentUploader = null;
    };
    currentUploader.on('retryable-pending', pauseForRetry);
    currentUploader.on('authorization-required', pauseForRetry);
    currentUploader.on('cancelled', () => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        done: true,
        cancelled: true,
        status: 'cancelled',
        errorMessage: 'Upload cancelled. Approved files can be resumed.',
      });
      currentUploader = null;
    });
    currentUploader.on('error', (error: Error) => {
      scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
        scanId: safeScanId,
        done: true,
        failed: true,
        failedFiles: 1,
        errorMessage: error.message,
      });
      currentUploader = null;
    });
    currentUploader.start().catch(console.error);
    return { success: true };
  } finally {
    uploadStarting = false;
  }
}
