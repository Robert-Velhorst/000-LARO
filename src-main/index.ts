import { app, BrowserWindow, ipcMain, dialog, shell, Menu, session } from 'electron';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import log from 'electron-log';
import { IPC_CHANNELS, Platform, ScanConfig, AgentConfig } from '../shared/types';
import {
  initDatabase as initAgentDb,
  closeDatabase as closeAgentDb,
  createScan,
  getScanFiles,
  setScanFileSelection,
} from './database';
import { FileScanner } from './scanner';
import { FileUploader } from './uploader';
import { isDesktopDevelopmentMode, resolveDesktopServerPort } from './desktopPort';
import { acquireSingleInstanceLock } from './singleInstance';
import { installDenyByDefaultPermissions } from './sessionPermissions';
import { ensureDesktopSecrets } from './desktopSecrets';
// NOTE: server/index.ts reads `.env` (dotenv) at import time, so it is imported
// lazily in startApp() AFTER we pin NODE_ENV from app.isPackaged. This guarantees
// a packaged build runs the server in production mode even if the bundled .env
// (or DOTENV secret) mistakenly contains NODE_ENV=development.

const DEFAULT_PORT = 3000;
let laroUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
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
const oauthWindows = new Set<BrowserWindow>();
let currentScanner: FileScanner | null = null;
let currentUploader: FileUploader | null = null;
const approvedScanFolders = new Set<string>();

let agentConfig: AgentConfig = {
  caseId: null,
  apiUrl: laroUrl,
  token: null,
  deviceId: null,
  deviceName: os.hostname(),
  userId: null,
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
    return isDev && (origin === 'http://localhost:5173' || origin === 'http://127.0.0.1:5173');
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

function isAllowedOAuthWindowUrl(rawUrl: string): boolean {
  if (isOAuthProviderUrl(rawUrl)) return true;
  try {
    const url = new URL(rawUrl);
    return url.origin === new URL(laroUrl).origin && url.pathname.startsWith('/api/oauth/');
  } catch {
    return false;
  }
}

async function openOAuthWindow(rawUrl: string, parent: BrowserWindow): Promise<void> {
  if (!isOAuthProviderUrl(rawUrl)) throw new Error('Blocked unapproved OAuth provider URL');
  const oauthWindow = new BrowserWindow({
    parent,
    width: 520,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Connect account to LARO',
    backgroundColor: '#f4f6f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  oauthWindows.add(oauthWindow);
  oauthWindow.once('ready-to-show', () => oauthWindow.show());
  oauthWindow.on('closed', () => oauthWindows.delete(oauthWindow));
  oauthWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedOAuthWindowUrl(url)) return;
    event.preventDefault();
    void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked OAuth navigation:', error));
  });
  oauthWindow.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (isAllowedOAuthWindowUrl(url)) {
      void oauthWindow.loadURL(url);
      return { action: 'deny' };
    }
    void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked OAuth popup:', error));
    return { action: 'deny' };
  });
  await oauthWindow.loadURL(rawUrl);
}

function hardenWindowNavigation(window: BrowserWindow): void {
  window.webContents.on('will-navigate', (event, url) => {
    if (url.includes('/api/oauth/') || !isTrustedAppUrl(url)) {
      event.preventDefault();
      void openExternalUrl(url).catch((error) => console.error('[Electron] Blocked navigation:', error));
    }
  });
  window.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    if (isOAuthProviderUrl(url)) {
      void openOAuthWindow(url, window).catch((error) => console.error('[Electron] OAuth window failed:', error));
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

  if (isDev) {
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

  if (isDev) {
    scanPanel.loadURL('http://localhost:5173/?mode=scanner');
  } else {
    scanPanel.loadURL(`${laroUrl}/?mode=scanner`);
  }
  scanPanel.on('closed', () => {
    currentScanner?.stop();
    currentUploader?.stop();
    scanPanel = null;
    approvedScanFolders.clear();
    agentConfig = { ...agentConfig, token: null, deviceId: null, userId: null, caseId: null };
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
    return { ...agentConfig };
  });
  ipcMain.handle(IPC_CHANNELS.CONFIG_SET, (event, c: Partial<AgentConfig>) => {
    assertTrustedIpc(event);
    const next: Partial<AgentConfig> = {};
    if (c.token === null || (typeof c.token === 'string' && c.token.length <= 4096)) next.token = c.token;
    if (c.userId === null || (typeof c.userId === 'string' && c.userId.length <= 200)) next.userId = c.userId;
    if (c.deviceId === null || (typeof c.deviceId === 'string' && c.deviceId.length <= 200)) next.deviceId = c.deviceId;
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
  ipcMain.handle(IPC_CHANNELS.SCAN_FILES_SELECT, (event, id: string, fileIds: string[]) => {
    assertTrustedIpc(event);
    const safeIds = Array.isArray(fileIds) ? fileIds.map(String).filter((value) => value.length <= 200) : [];
    const selected = setScanFileSelection(String(id).slice(0, 200), safeIds);
    return { selected };
  });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_START, (event, id: string) => { assertTrustedIpc(event); return startUpload(id); });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_PAUSE, (event) => { assertTrustedIpc(event); currentUploader?.pause(); return { success: true }; });
  ipcMain.handle(IPC_CHANNELS.UPLOAD_RESUME, (event) => { assertTrustedIpc(event); currentUploader?.resume(); return { success: true }; });
}

async function startUpload(scanId: string): Promise<{ success: boolean }> {
  if (currentUploader) throw new Error('Upload in progress');
  if (!agentConfig.token || !agentConfig.userId) throw new Error('Sign in to LARO before uploading evidence');
  if (!isTrustedAppUrl(agentConfig.apiUrl)) throw new Error('Scanner API URL is not trusted');
  const safeScanId = String(scanId).slice(0, 200);
  currentUploader = new FileUploader({
    scanId: safeScanId,
    apiUrl: agentConfig.apiUrl,
    token: agentConfig.token,
    concurrency: 3,
    maxRetries: 3,
  });
  currentUploader.on('progress', (p) => scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, { scanId: safeScanId, ...p }));
  currentUploader.on('completed', (r) => {
    scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, { scanId: safeScanId, done: true, ...r });
    mainWindow?.webContents.send(IPC_CHANNELS.EVIDENCE_UPDATED, { scanId: safeScanId });
    currentUploader = null;
  });
  currentUploader.on('file-failed', (failure) => {
    scanPanel?.webContents.send(IPC_CHANNELS.UPLOAD_PROGRESS, {
      scanId: safeScanId,
      fileId: failure.fileId,
      failed: true,
      errorMessage: failure.error,
    });
  });
  currentUploader.on('cancelled', () => { currentUploader = null; });
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
}
