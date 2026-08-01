import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('production readiness regressions', () => {
  it('treats direct preflight as production unless development is explicit', () => {
    const script = join(ROOT, 'scripts/prod-preflight.mjs');
    const missingSecrets = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: '',
        JWT_SECRET: '',
        COOKIE_SECRET: '',
        DOTENV_CONFIG_PATH: join(tmpdir(), 'laro-preflight-no-env-file'),
      },
    });
    expect(missingSecrets.status).toBe(1);
    expect(missingSecrets.stdout).toContain('NODE_ENV=production (default)');
    expect(missingSecrets.stdout).toContain('[FAIL] [BLOCKER] JWT_SECRET strong');
    expect(missingSecrets.stdout).toContain('[FAIL] [BLOCKER] COOKIE_SECRET strong');

    const strongSecrets = spawnSync(process.execPath, [script], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        JWT_SECRET: 'preflight-jwt-secret-with-32-characters',
        COOKIE_SECRET: 'preflight-cookie-secret-with-32-characters',
      },
    });
    expect(strongSecrets.status).toBe(0);
    expect(strongSecrets.stdout).toContain('No blockers. Warnings, if any, are advisory.');
  });

  it('keeps the recovery drill isolated from target production credentials and storage', () => {
    const drill = readFileSync(join(ROOT, 'scripts/recovery-drill.ts'), 'utf8');
    expect(drill).toContain('process.env.LOCAL_STORAGE_DIR = storagePath');
    expect(drill).toContain('delete process.env.JWT_SECRET');
    expect(drill).toContain('delete process.env.COOKIE_SECRET');
    expect(drill).toContain('delete process.env.AWS_S3_BUCKET');
  });

  it('fails closed when provider-backed AI is not configured', async () => {
    delete process.env.FORGE_API_KEY;
    vi.resetModules();
    const { invokeLLM } = await import('../../server/llm');
    await expect(invokeLLM({ messages: [{ role: 'user', content: 'Analyze this.' }] }))
      .rejects.toThrow('FORGE_API_KEY is not configured');
  });

  it('ships persisted source-grounded document analysis instead of a renderer-only stub', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const router = readFileSync(join(ROOT, 'server/routers/documentAnalysis.ts'), 'utf8');
    const intelligence = readFileSync(join(ROOT, 'server/documentIntelligence.ts'), 'utf8');
    const collector = readFileSync(join(ROOT, 'server/autoCollectionService.ts'), 'utf8');
    const analysisUi = readFileSync(join(ROOT, 'src/renderer/components/AutomatedDocumentAnalysis.tsx'), 'utf8');
    const caseUi = readFileSync(join(ROOT, 'src/renderer/components/EnhancedCaseDetailsDialog.tsx'), 'utf8');
    const timelineUi = readFileSync(join(ROOT, 'src/renderer/components/CaseTimeline.tsx'), 'utf8');
    const reconstructionUi = readFileSync(join(ROOT, 'src/renderer/components/CaseReconstruction.tsx'), 'utf8');
    const migration = readFileSync(join(ROOT, 'drizzle/0002_unknown_silver_samurai.sql'), 'utf8');
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');

    expect(pkg.dependencies['pdf-parse']).toBeTruthy();
    expect(pkg.dependencies.mammoth).toBeTruthy();
    expect(pkg.dependencies['tesseract.js']).toBe('7.0.0');
    expect(pkg.dependencies['@tesseract.js-data/nld']).toBe('1.0.0');
    expect(pkg.dependencies['@tesseract.js-data/eng']).toBe('1.0.0');
    for (const workerRuntime of [
      'node_modules/bmp-js/**/*',
      'node_modules/is-url/**/*',
      'node_modules/regenerator-runtime/**/*',
      'node_modules/tesseract.js/**/*',
      'node_modules/tesseract.js-core/**/*',
      'node_modules/wasm-feature-detect/**/*',
    ]) {
      expect(pkg.build.asarUnpack).toContain(workerRuntime);
    }
    expect(router).toContain('analyzeStoredEvidence');
    expect(router).toContain('generateCaseTimeline');
    expect(router).not.toContain('documentAnalysis stub');
    expect(intelligence).toContain('Every finding must cite one or more supplied source IDs');
    expect(intelligence).toContain('validCitationIds.has(id)');
    expect(collector).toContain('storageKey: storedMessage.key');
    expect(collector).toContain('contentHash: storedAttachment.sha256');
    expect(collector).toContain('analyzeImportedEvidence');
    expect(analysisUi).toContain('evidenceFiles.upload.useMutation');
    expect(analysisUi).toContain('documentAnalysis.analyzeEvidence.useMutation');
    expect(caseUi).toContain('{ id: "analysis", label: "Analysis"');
    expect(caseUi).toContain('<CaseTimeline caseId={caseId} />');
    expect(timelineUi).toContain('title="Open source document"');
    expect(caseUi).toContain('<CaseReconstruction caseId={caseId} />');
    expect(reconstructionUi).toContain('Suggested links');
    expect(reconstructionUi).toContain('Open source document');
    expect(reconstructionUi).toContain('Trace selection');
    expect(reconstructionUi).toContain('All participants and topics');
    expect(reconstructionUi).toContain('Dated actions in this document');
    expect(analysisUi).toContain('Analyze all pending');
    expect(analysisUi).toContain('documentAnalysis.byCase.useQuery');
    expect(migration).toContain('CREATE TABLE `document_analyses`');
    expect(migration).not.toContain('__new_');
    const migrationFiles = readdirSync(join(ROOT, 'drizzle')).filter((file) => /^(?:000[2-9]|00[1-9]\d).*\.sql$/.test(file));
    for (const file of migrationFiles) {
      expect(readFileSync(join(ROOT, 'drizzle', file), 'utf8')).not.toContain('__new_');
    }
    expect(main).toContain("url.protocol === 'file:'");
    expect(main).toContain("filePath.startsWith(storageBase + path.sep)");
    expect(main).toContain('IPC_CHANNELS.RENDERER_ERROR_REPORT');
    const novaDirectory = readFileSync(join(ROOT, 'server/novaDirectory.ts'), 'utf8');
    expect(novaDirectory).not.toContain('caseData.clientAddress');
    const boundary = readFileSync(join(ROOT, 'src/renderer/components/PageErrorBoundary.tsx'), 'utf8');
    expect(boundary).toContain('reportRendererError');
    expect(boundary).not.toContain('TODO: Send to error tracking service');
    const dashboardRoutes = readFileSync(join(ROOT, 'src/renderer/DashboardApp.tsx'), 'utf8');
    const dashboardLayout = readFileSync(join(ROOT, 'src/renderer/components/DashboardLayout.tsx'), 'utf8');
    expect(dashboardRoutes).toContain('<Route path="/evidence" component={Evidence} />');
    expect(dashboardLayout).toContain('label: "Evidence", path: "/evidence"');
  });

  it('uses encrypted PKCE state for Google OAuth', async () => {
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.COOKIE_SECRET = 'test-cookie-secret-that-is-long-and-random-1234';
    vi.resetModules();
    const { beginOAuthFlow, consumeOAuthState } = await import('../../server/oauth2');
    const authUrl = new URL(beginOAuthFlow('gmail', 'USER_TEST'));
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();
    expect(consumeOAuthState(state!, 'gmail').userId).toBe('USER_TEST');
  });

  it('requests evidence-read OAuth permissions without delegated mail sending or label writes', async () => {
    const { getOAuth2Config } = await import('../../server/oauth2');
    const { getGmailOAuthConfig } = await import('../../server/gmailService');
    const google = getOAuth2Config('gmail');
    const microsoft = getOAuth2Config('outlook');
    const legacyGoogle = getGmailOAuthConfig();
    const refreshSource = readFileSync(join(ROOT, 'server/emailOAuth.ts'), 'utf8');

    expect(google.scopes).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/drive.readonly',
    ]);
    expect(legacyGoogle.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly']);
    expect(microsoft.scopes).toEqual([
      'https://graph.microsoft.com/Mail.Read',
      'https://graph.microsoft.com/User.Read',
      'offline_access',
    ]);
    expect(refreshSource).not.toContain('Mail.Send');
    expect(JSON.stringify({ google, microsoft, legacyGoogle })).not.toMatch(/gmail\.send|gmail\.labels|Mail\.Send/);
  });

  it('opens OAuth in a sandboxed closeable desktop window and refreshes connection state', () => {
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const callback = readFileSync(join(ROOT, 'server/oauth2Callbacks.ts'), 'utf8');
    const connections = readFileSync(join(ROOT, 'src/renderer/components/EvidenceConnectionsCard.tsx'), 'utf8');
    expect(main).toContain('async function openOAuthWindow');
    expect(main).toContain("url.hostname === 'accounts.google.com'");
    expect(main).toContain("url.hostname === 'login.microsoftonline.com'");
    expect(main).toContain('nodeIntegration: false');
    expect(main).toContain('contextIsolation: true');
    expect(main).toContain('sandbox: true');
    expect(callback).toContain("document.getElementById('close').addEventListener('click', closePage)");
    expect(callback).toContain('window.close()');
    expect(connections).toContain('refetchInterval: connectingPlatform === "gmail" ? 1_500 : false');
    expect(connections).toContain('refetchInterval: connectingPlatform === "google-drive" ? 1_500 : false');
  });

  it('refreshes the evidence query used by the case workspace after a keyword pull', () => {
    const caseDetails = readFileSync(
      join(ROOT, 'src/renderer/components/EnhancedCaseDetailsDialog.tsx'),
      'utf8',
    );
    const collection = readFileSync(join(ROOT, 'server/autoCollectionService.ts'), 'utf8');
    expect(caseDetails).toContain('utils.evidenceFiles.search.invalidate({ caseId })');
    expect(caseDetails).toContain('getElectronAPI().selectFolder()');
    expect(caseDetails).not.toContain('evidenceFiles as any)?.byCase');
    expect(collection).toContain("process.env.LOCAL_SCAN_ROOTS");
    expect(collection).toContain('await fs.realpath(folderPath)');
    expect(collection).toContain('Local scan path is outside LOCAL_SCAN_ROOTS');
  });

  it('keeps sensitive mutations behind protected or admin procedures', () => {
    const messages = readFileSync(join(ROOT, 'server/routers/messages.ts'), 'utf8');
    const lawyers = readFileSync(join(ROOT, 'server/routers/lawyers.ts'), 'utf8');
    const email = readFileSync(join(ROOT, 'server/routers/email.ts'), 'utf8');
    expect(messages).not.toContain('publicProcedure');
    expect(lawyers).not.toContain('publicProcedure');
    expect(lawyers).toContain('create: adminProcedure');
    expect(email).not.toContain('publicProcedure');
  });

  it('accepts documented loopback development origins without weakening CSRF', async () => {
    const { isAllowedOrigin } = await import('../../server/_core/csrf');
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('https://attacker.example')).toBe(false);
  });

  it('loads matcher datasets from packaged assets', () => {
    const matching = readFileSync(join(ROOT, 'server/matching.ts'), 'utf8');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const packagedAssets = pkg.build.extraResources.find((entry: { from?: string }) => entry.from === 'assets');
    expect(matching).toContain('assets');
    expect(packagedAssets.filter).toEqual([
      'legal-taxonomy-mapping.json',
      'legal-keywords.json',
    ]);
    expect(packagedAssets.filter).not.toContain('**/*');
    expect(readFileSync(join(ROOT, 'assets/legal-taxonomy-mapping.json'), 'utf8')).toContain('specializationToCourtCategories');
    const keywordData = JSON.parse(readFileSync(join(ROOT, 'assets/legal-keywords.json'), 'utf8'));
    expect(keywordData.schemaVersion).toBe(1);
    const categoryNames = Object.keys(keywordData.categories);
    expect(categoryNames).toEqual([
      'Civiel procesrecht',
      'Bestuursrecht',
      'Strafrecht',
      'Arbeidsrecht',
      'Belastingrecht',
      'Huurrecht',
      'Insolventierecht',
    ]);
    expect(Object.values(keywordData.categories).every(
      (category: any) => Array.isArray(category.keywords) && category.keywords.length > 0,
    )).toBe(true);
    const taxonomy = JSON.parse(readFileSync(join(ROOT, 'assets/legal-taxonomy-mapping.json'), 'utf8'));
    expect(Object.keys(taxonomy.courtCategoryToSpecializations).every(
      (category) => categoryNames.includes(category),
    )).toBe(true);
    const matchingSource = readFileSync(join(ROOT, 'server/matching.ts'), 'utf8');
    expect(matchingSource).toContain('matchingDataPath("legal-keywords.json")');
    expect(matchingSource).not.toContain('877k court cases');
  });

  it('supports owner-selected unsigned releases while blocking unaccepted or mismatched tags', async () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/build.yml'), 'utf8');
    const acceptance = JSON.parse(readFileSync(join(ROOT, 'release-acceptance.json'), 'utf8'));
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(workflow).toContain('WINDOWS_SIGNING_PROVIDER must be unsigned, microsoft-store, pfx, azure-artifact-signing, or sslcom-esigner');
    expect(workflow).toContain("$env:WINDOWS_SIGNING_PROVIDER -eq 'unsigned'");
    expect(workflow).toContain('Tagged release is unsigned by owner-selected policy.');
    expect(workflow).toContain('Portable tagged releases are prohibited');
    expect(workflow).toContain('WINDOWS_CSC_LINK is required when WINDOWS_SIGNING_PROVIDER=pfx');
    expect(workflow).toContain('Azure Artifact Signing configuration is incomplete');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('uses: azure/login@v3');
    expect(workflow).toContain('uses: azure/artifact-signing-action@v2');
    expect(workflow).toContain('timestamp-rfc3161: http://timestamp.acs.microsoft.com');
    expect(workflow).toContain('SSL.com eSigner configuration is incomplete');
    expect(workflow).toContain('uses: sslcom/esigner-codesign@cf5f6c1d38ad10f47e3ed9aca873f429b1a8d85b');
    expect(workflow).toContain('malware_block: true');
    expect(workflow).toContain('override: true');
    expect(workflow).toContain("Tag ${{ github.ref_name }} does not match package version");
    expect(workflow).toContain('release-acceptance.mjs --require-approved --tag');
    expect(workflow).toContain("$signature.Status -ne 'Valid'");
    expect(workflow).toContain("$provider -ne 'unsigned'");
    expect(workflow).toContain('verify-single-instance.ps1');
    const singleInstanceProbe = readFileSync(join(ROOT, 'scripts/verify-single-instance.ps1'), 'utf8');
    expect(singleInstanceProbe).toContain("Join-Path $profile 'laro-server.sqlite'");
    expect(singleInstanceProbe).toContain('Compare-Object $beforeIds $afterIds');
    expect(singleInstanceProbe).toContain("Join-Path $profile 'laro-secrets.json'");
    expect(singleInstanceProbe).toContain('$secretHashAfterRestart -ne $secretHashBeforeRestart');
    expect(workflow).toContain('release-artifacts/*');
    expect(workflow).not.toContain('path: release/**/*.exe');
    const storeWorkflow = readFileSync(join(ROOT, '.github/workflows/store.yml'), 'utf8');
    expect(storeWorkflow).toContain('Partner Center identity is incomplete');
    expect(storeWorkflow).toContain('release-acceptance.mjs --require-approved');
    expect(storeWorkflow).toContain('npm run dist:store');
    expect(storeWorkflow).toContain("$identity.Name -ne $env:STORE_IDENTITY_NAME");
    expect(storeWorkflow).toContain("$identity.Publisher -ne $env:STORE_PUBLISHER");
    expect(storeWorkflow).toContain("$publisherDisplayName -ne $env:STORE_PUBLISHER_DISPLAY_NAME");
    expect(storeWorkflow).toContain('LARO-Microsoft-Store-Submission');
    expect(pkg.scripts['dist:store']).toContain('electron-builder.store.cjs --win appx');
    const storeConfig = readFileSync(join(ROOT, 'electron-builder.store.cjs'), 'utf8');
    expect(storeConfig).toContain("requiredEnvironment('STORE_IDENTITY_NAME')");
    expect(storeConfig).toContain("requiredEnvironment('STORE_PUBLISHER')");
    expect(storeConfig).toContain("requiredEnvironment('STORE_PUBLISHER_DISPLAY_NAME')");
    expect(acceptance.version).toBe(pkg.version);
    expect(['pending', 'approved']).toContain(acceptance.gates.publicBrand.status);
    expect(['pending', 'approved']).toContain(acceptance.gates.liveProviders.status);

    const tempDirectory = mkdtempSync(join(tmpdir(), 'laro-release-acceptance-'));
    try {
      const pendingPath = join(tempDirectory, 'pending.json');
      writeFileSync(pendingPath, JSON.stringify({
        schemaVersion: 1,
        version: pkg.version,
        gates: {
          publicBrand: { status: 'pending' },
          liveProviders: { status: 'pending', providerScope: [] },
        },
      }));
      const rejected = spawnSync(process.execPath, [
        join(ROOT, 'scripts/release-acceptance.mjs'),
        '--require-approved',
        '--tag', `v${pkg.version}`,
        '--file', pendingPath,
      ], { encoding: 'utf8' });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('release acceptance pending: publicBrand, liveProviders');
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('does not invent an active dashboard case or preserve unverified OAuth status', () => {
    const dashboard = readFileSync(join(ROOT, 'frontend/dashboard_dark.html'), 'utf8');
    expect(dashboard).toContain('No case selected');
    expect(dashboard).not.toContain('params.get("case") || 1');
    expect(dashboard).not.toContain('Live status refresh is temporarily unavailable');
    expect(dashboard).toContain('localStorage.removeItem("auth_token")');
    expect(dashboard).toContain('localStorage.removeItem("access_token")');
    expect(dashboard).toContain('const token = localStorage.getItem("laroAuthToken") || localStorage.getItem("auth_token") || localStorage.getItem("access_token")');
  });

  it('keeps API-only deployments explicit and runs compatibility schema repair after migrations', () => {
    const server = readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
    const database = readFileSync(join(ROOT, 'server/db.ts'), 'utf8');
    const compose = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const ngrokLauncher = readFileSync(join(ROOT, 'scripts/start-ngrok-api.ps1'), 'utf8');
    const ngrokStopper = readFileSync(join(ROOT, 'scripts/stop-ngrok-api.ps1'), 'utf8');
    const providerSetup = readFileSync(join(ROOT, 'scripts/configure-live-providers.ps1'), 'utf8');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    const emailConfig = readFileSync(join(ROOT, 'server/emailConfig.ts'), 'utf8');
    const emailRouter = readFileSync(join(ROOT, 'server/routers/email.ts'), 'utf8');
    const adminRouter = readFileSync(join(ROOT, 'server/routers/admin.ts'), 'utf8');
    const systemRouter = readFileSync(join(ROOT, 'server/_core/systemRouter.ts'), 'utf8');
    expect(server).toContain('!ENV.SERVER_ONLY');
    expect(database.indexOf('migrate(_db')).toBeLessThan(database.lastIndexOf('ensureSupportTicketsTable(sqlite)'));
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('LARO_APP_VERSION: ${LARO_APP_VERSION:-unknown}');
    expect(compose).toContain('ALLOWED_ORIGINS: ${LARO_PUBLIC_ORIGIN:-}');
    expect(compose).toContain('OAUTH_REDIRECT_BASE_URL: ${LARO_PUBLIC_BASE_URL:-http://127.0.0.1:3000}');
    expect(compose).toContain('PUBLIC_PATH_PREFIX: ${LARO_PUBLIC_PATH_PREFIX:-}');
    expect(compose).toContain('GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET:-}');
    expect(compose).toContain('SMTP_PASS: ${SMTP_PASS:-}');
    expect(ngrokLauncher).toContain('http://127.0.0.1:4040/api/tunnels');
    expect(ngrokLauncher).toContain('Wait-ForHttpsTunnel `');
    expect(ngrokLauncher).toContain('-ExpectedUrl $(if ($useDirectTunnel) { "" } else { $InternalUrl })');
    expect(ngrokLauncher).toContain('Copy-Item -LiteralPath $examplePath -Destination $envPath');
    expect(ngrokLauncher).not.toContain('npm.cmd run setup');
    expect(ngrokLauncher).toContain('$env:LARO_PUBLIC_ORIGIN = $publicOrigin');
    expect(ngrokLauncher).toContain('$env:LARO_PUBLIC_BASE_URL = $publicBaseUrl');
    expect(ngrokLauncher).toContain('$env:LARO_APP_VERSION = $packageMetadata.version');
    expect(ngrokLauncher).toContain('[switch]$DirectPublicTunnel');
    expect(ngrokLauncher).toContain('LARO_NGROK_MODE');
    expect(ngrokLauncher).toContain('DirectPublicTunnel cannot be combined');
    expect(ngrokLauncher).toContain('$publicBaseUrl = $publicOrigin');
    expect(ngrokLauncher).toContain('mode = if ($useDirectTunnel) { "direct" } else { "gateway" }');
    expect(ngrokLauncher).toContain('LARO_NGROK_GATEWAY_URL');
    expect(ngrokLauncher).toContain('if (-not $httpsTunnel)');
    expect(ngrokLauncher).toContain('Wait-ForJsonEndpoint -Uri "$publicBaseUrl/api/health"');
    expect(ngrokLauncher).toContain('Import-ProtectedProviderConfig');
    expect(ngrokLauncher).toContain('Unprotect-Secret -ProtectedValue');
    expect(ngrokStopper).toContain('$process.ProcessName -ne "ngrok"');
    expect(ngrokStopper).toContain('$processDetails.CommandLine -notmatch "laro-api"');
    expect(ngrokStopper).not.toContain('docker compose stop laro-server');
    expect(providerSetup).toContain('Read-Host "Google web OAuth client secret" -AsSecureString');
    expect(providerSetup).toContain('Assert-GoogleClientSecret -Value $GoogleClientSecret');
    expect(providerSetup).toContain('not a URL, path, or placeholder');
    expect(ngrokLauncher).toContain('Assert-GoogleProviderConfig');
    expect(ngrokLauncher).toContain('Reconfigure Google before deployment');
    expect(ngrokLauncher).toContain('@("compose", "-p", $ComposeProjectName, "up", "-d")');
    expect(ngrokLauncher).toContain('composeProjectName = $ComposeProjectName');
    expect(ngrokLauncher).toContain('Remove-Item -LiteralPath $runtimePath -Force -ErrorAction SilentlyContinue');
    expect(ngrokStopper).toContain('docker compose -p $ComposeProjectName stop laro-server');
    expect(providerSetup).toContain('Read-Host "SMTP password or Gmail app password" -AsSecureString');
    expect(providerSetup).toContain('ConvertFrom-SecureString -SecureString $Value');
    expect(providerSetup).toContain('/inheritance:r');
    expect(gitignore).toContain('.laro-provider-config.json');
    expect(emailConfig).toContain('required.filter((name) => !present(environment[name]))');
    expect(emailRouter).toContain('resolveOutboundEmailConfiguration()');
    expect(adminRouter).toContain('email: resolveOutboundEmailConfiguration().configured');
    expect(systemRouter).toContain('configured: outboundEmail.configured');
    expect(readFileSync(join(ROOT, 'server/systemEmail.ts'), 'utf8')).toContain('tls: { minVersion: "TLSv1.2" }');
    expect(providerSetup).toContain('$normalized = $plainText -replace "\\s", ""');
  });

  it('allows an isolated development API port instead of hardcoding the proxy target', () => {
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(vite).toContain("process.env.VITE_LARO_API_URL || 'http://127.0.0.1:3000'");
    expect(vite.match(/target: devApiUrl/g)).toHaveLength(2);
  });

  it('binds packaged Desktop to an available loopback port', () => {
    const server = readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const provider = readFileSync(join(ROOT, 'src/renderer/providers/TrpcProvider.tsx'), 'utf8');
    expect(main).toContain('resolveDesktopServerPort(process.env.OAUTH_REDIRECT_BASE_URL)');
    expect(main).toContain('const actualPort = await startServer(requestedPort)');
    expect(main).toContain('agentConfig.apiUrl = laroUrl');
    expect(main).toContain('process.env.OAUTH_REDIRECT_BASE_URL = laroUrl');
    expect(main).toContain("process.env.LARO_PACKAGED_DESKTOP = app.isPackaged ? 'true' : 'false'");
    expect(server).toContain("const packagedDesktop = process.env.LARO_PACKAGED_DESKTOP === 'true'");
    expect(server.indexOf("path.join(process.cwd(), '.env')"))
      .toBeGreaterThan(server.indexOf(': ['));
    expect(provider).toContain('window.location.origin');
    expect(provider).not.toContain('window.location.port !== "5173"');
    expect(main).not.toContain('await startServer(PORT)');
  });

  it('does not inherit development-only behavior in a packaged executable', () => {
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const desktopRuntime = readFileSync(join(ROOT, 'src-main/desktopPort.ts'), 'utf8');
    expect(main).toContain('isDesktopDevelopmentMode(app.isPackaged, process.env.NODE_ENV)');
    expect(main).not.toContain("const isDev = process.env.NODE_ENV === 'development'");
    expect(desktopRuntime).toContain("return !isPackaged && nodeEnv === 'development'");
  });

  it('reports the package version consistently across operational endpoints', () => {
    const health = readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
    const system = readFileSync(join(ROOT, 'server/_core/systemRouter.ts'), 'utf8');
    const admin = readFileSync(join(ROOT, 'server/routers/admin.ts'), 'utf8');
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    expect(health).toContain('version: APP_VERSION');
    expect(system.match(/version: APP_VERSION/g)).toHaveLength(2);
    expect(admin).toContain('appVersion: APP_VERSION');
    expect(main).toContain('process.env.LARO_APP_VERSION = app.getVersion()');
  });

  it('keeps operator readiness deterministic after Electron packaging', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const readiness = readFileSync(join(ROOT, 'scripts/operator-readiness.mjs'), 'utf8');
    expect(pkg.scripts.readiness).toContain('npm run rebuild:node');
    expect(pkg.scripts['readiness:production']).toContain('npm run rebuild:node');
    expect(pkg.scripts['db:readiness']).toContain('scripts/data-readiness.ts');
    expect(readiness).toContain("name: 'target database readiness'");
    expect(readiness).toContain("'scripts/data-readiness.ts'");
    expect(readiness).toContain('[result.stdout, result.stderr]');
  });

  it('denies unneeded Electron browser permissions before creating windows', () => {
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const permissions = readFileSync(join(ROOT, 'src-main/sessionPermissions.ts'), 'utf8');
    const policyInstall = main.indexOf('installDenyByDefaultPermissions(session.defaultSession)');
    const windowCreation = main.indexOf('await createMainWindow()');

    expect(policyInstall).toBeGreaterThan(-1);
    expect(windowCreation).toBeGreaterThan(policyInstall);
    expect(permissions).toContain('setPermissionCheckHandler(() => false)');
    expect(permissions).toContain('setPermissionRequestHandler');
    expect(permissions).toContain('callback(false)');
  });

  it('fails closed on undurable desktop encryption secrets before opening SQLite', () => {
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const secrets = readFileSync(join(ROOT, 'src-main/desktopSecrets.ts'), 'utf8');
    const secretSetup = main.indexOf('ensureDesktopSecrets(userDataPath)');
    const databaseOpen = main.indexOf('initAgentDb()');

    expect(secretSetup).toBeGreaterThan(-1);
    expect(databaseOpen).toBeGreaterThan(secretSetup);
    expect(main).toContain("LARO will close without opening the database.");
    expect(secrets).toContain("flag: 'wx'");
    expect(secrets).toContain('fs.renameSync(temporaryPath, secretsPath)');
    expect(secrets).not.toContain('using in-memory values');
  });

  it('binds recovery backups to encryption keys and managed evidence bytes', () => {
    const backupSet = readFileSync(join(ROOT, 'server/backupSet.ts'), 'utf8');
    const backupStorage = readFileSync(join(ROOT, 'server/backupStorage.ts'), 'utf8');
    const backupCore = readFileSync(join(ROOT, 'server/backup.ts'), 'utf8');
    const backupCli = readFileSync(join(ROOT, 'scripts/backup.ts'), 'utf8');
    const recoveryDrill = readFileSync(join(ROOT, 'scripts/recovery-drill.ts'), 'utf8');

    expect(backupSet).toContain('createHmac("sha256", jwtSecret)');
    expect(backupSet).toContain('bundled-desktop-secret');
    expect(backupSet).toContain('external-environment');
    expect(backupSet).toContain('fs.renameSync(temporaryManifest, manifestPath)');
    expect(backupSet).toContain('secretInstall?.rollback()');
    expect(backupSet).toContain('storageInstall?.rollback()');
    expect(backupSet).toContain('allowMissingStorage');
    expect(backupSet).toContain('Staged desktop secrets do not match');
    expect(backupCore).toContain('staged database does not match the backup-set manifest');
    expect(backupStorage).toContain('bundled-local');
    expect(backupStorage).toContain('external-s3');
    expect(backupStorage).toContain('assertLocalStorageUnchanged');
    expect(backupStorage).toContain('managed local evidence object(s)');
    expect(backupCli).toContain('Refusing a database-only restore');
    expect(backupCli).toContain('parsed.allowLegacy');
    expect(backupCli).toContain('parsed.allowMissingStorage');
    expect(recoveryDrill).toContain('backup.createBackupSet');
    expect(recoveryDrill).toContain('backupOfPreviousSecrets');
    expect(recoveryDrill).toContain('backupOfPreviousStorage');
  });

  it('ships coordinated Flask ledger, auth, token-vault, and upload recovery', () => {
    const recovery = readFileSync(join(ROOT, 'flask_recovery.py'), 'utf8');
    const flaskApp = readFileSync(join(ROOT, 'app.py'), 'utf8');
    const cli = readFileSync(join(ROOT, 'scripts/flask_recovery.py'), 'utf8');
    const drill = readFileSync(join(ROOT, 'scripts/flask_recovery_drill.py'), 'utf8');
    const gate = readFileSync(join(ROOT, 'scripts/stabilization-gate.mjs'), 'utf8');
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');

    expect(recovery).toContain('PRAGMA data_version');
    expect(recovery).toContain('upload_references');
    expect(recovery).toContain('bundled-vault-key');
    expect(recovery).toContain('session-reset-required');
    expect(recovery).toContain('confirm_stopped');
    expect(recovery).toContain('previous[index]');
    expect(recovery).toContain('_default_upload_root');
    expect(flaskApp).toContain("os.path.join(app.instance_path, 'uploads')");
    expect(flaskApp).toContain("os.path.join(app.instance_path, 'laro_uploads')");
    expect(cli).toContain('--confirm-stopped');
    expect(cli).toContain('--allow-session-reset');
    expect(drill).toContain('previous_uploads');
    expect(drill).toContain('previous_tokens');
    expect(gate).toContain('scripts/flask_recovery_drill.py');
    expect(gitignore).toContain('db-backups/');
    expect(gitignore).toContain('flask-backups/');
  });

  it('wires case intake draft persistence into the mounted creation flow', () => {
    const wizard = readFileSync(join(ROOT, 'src/renderer/components/CaseCreationWizard.tsx'), 'utf8');
    const cases = readFileSync(join(ROOT, 'src/renderer/components/Cases.tsx'), 'utf8');
    expect(wizard).toContain('trpc.cases.getDraft.useQuery');
    expect(wizard).toContain('trpc.cases.saveDraft.useMutation');
    expect(wizard).toContain('trpc.cases.clearDraft.useMutation');
    expect(wizard).toContain('completed === false');
    expect(cases).toContain('return false');
  });

  it('builds the shipped renderer with production React regardless of local env files', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const rendererBuild = readFileSync(join(ROOT, 'scripts/build-renderer.mjs'), 'utf8');
    expect(pkg.scripts['build:renderer']).toBe('node scripts/build-renderer.mjs');
    expect(rendererBuild.indexOf('process.env.NODE_ENV = "production"'))
      .toBeLessThan(rendererBuild.indexOf('await import("vite")'));
  });

  it('keeps horizontal tabs stacked above their content at every viewport', () => {
    const tabs = readFileSync(join(ROOT, 'src/renderer/components/ui/tabs.tsx'), 'utf8');
    expect(tabs).toContain('data-[orientation=horizontal]:flex-col');
    expect(tabs).not.toContain('data-horizontal:flex-col');
    expect(tabs).not.toContain('group-data-horizontal/tabs');
  });

  it('ships its dashboard mark locally and uses it for Windows packaging', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const constants = readFileSync(join(ROOT, 'shared/const.ts'), 'utf8');
    expect(pkg.build.win.icon).toBe('build/icon.png');
    expect(constants).toContain('APP_LOGO = "/laro-logo.png"');
    expect(constants).not.toContain('manuscdn.com');
    expect(readFileSync(join(ROOT, 'public/laro-logo.png')).byteLength).toBeGreaterThan(1_000);
    expect(readFileSync(join(ROOT, 'build/icon.png')).byteLength).toBeGreaterThan(1_000);
  });

  it('attaches authenticated realtime updates without render-loop reconnects', () => {
    const server = readFileSync(join(ROOT, 'server/index.ts'), 'utf8');
    const realtime = readFileSync(join(ROOT, 'server/realtime.ts'), 'utf8');
    const notifications = readFileSync(join(ROOT, 'server/notifications.ts'), 'utf8');
    const client = readFileSync(join(ROOT, 'src/renderer/contexts/WebSocketContext.tsx'), 'utf8');
    const dashboard = readFileSync(join(ROOT, 'src/renderer/DashboardApp.tsx'), 'utf8');
    const notificationCenter = readFileSync(join(ROOT, 'src/renderer/components/NotificationCenter.tsx'), 'utf8');
    const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8');
    expect(server).toContain('initializeRealtimeServer(httpServer, `${publicPathPrefix}/socket.io`)');
    expect(realtime).toContain('path = "/socket.io"');
    expect(realtime).toContain('jwt.verify(token, ENV.JWT_SECRET)');
    expect(realtime).toContain('isTokenRevoked(decoded.userId, decoded.iat)');
    expect(realtime).toContain('socket.join(userRoom(userId))');
    expect(notifications).toContain('emitRealtimeNotification(params.userId');
    expect(client).toContain('const push = useCallback');
    expect(client).toContain('io(window.location.origin)');
    expect(client).not.toContain('transports: ["websocket", "polling"]');
    expect(client).not.toContain('socketInstance.emit("join"');
    expect(dashboard).toContain('<WebSocketProvider>');
    expect(notificationCenter).toContain('@/contexts/WebSocketContext');
    expect(notificationCenter).not.toContain('@/_core/hooks/useWebSocket');
    expect(vite).toContain("'/socket.io'");
    expect(vite.match(/target: devApiUrl/g)).toHaveLength(2);
  });

  it('generates collision-resistant case identifiers', async () => {
    const { createCaseId } = await import('../../server/ids');
    const ids = Array.from({ length: 1_000 }, createCaseId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('CASE-'))).toBe(true);
  });

  it('uses persisted evidence storage from every renderer upload surface', () => {
    for (const component of ['BulkEvidenceUpload.tsx', 'FileUploadDialog.tsx', 'EnhancedEvidenceUpload.tsx']) {
      const upload = readFileSync(join(ROOT, 'src/renderer/components', component), 'utf8');
      expect(upload).toContain('evidenceFiles.upload');
      expect(upload).not.toContain('storage.example.com');
      expect(upload).not.toMatch(/simulate(d)? upload/i);
    }
  });

  it('keeps production search honest and routes lawyer actions to real records', () => {
    const search = readFileSync(join(ROOT, 'src/renderer/components/SmartSearchFilters.tsx'), 'utf8');
    const lawyers = readFileSync(join(ROOT, 'src/renderer/components/Lawyers.tsx'), 'utf8');
    const dashboard = readFileSync(join(ROOT, 'src/renderer/DashboardApp.tsx'), 'utf8');
    expect(search).not.toContain('divorce lawyer Amsterdam');
    expect(search).not.toContain('employment law urgent');
    expect(search).not.toContain('Math.random()');
    expect(lawyers).toContain('searchType="lawyers"');
    expect(lawyers).toContain('setLocation(`/lawyers/${lawyer.id}`)');
    expect(dashboard).not.toContain('RoutePlaceholder');
    expect(dashboard).not.toContain('/email-automation');
    expect(dashboard).not.toContain('/billing');
    expect(dashboard).not.toContain('/reports');
    expect(dashboard).toContain('lazy(() => import("@/components/Cases"))');
    expect(dashboard).toContain('<Suspense fallback={<DashboardSkeleton />}>');
  });

  it('ships review-gated media and organization matching inside Outreach', () => {
    const routers = readFileSync(join(ROOT, 'server/routers/index.ts'), 'utf8');
    const directory = readFileSync(join(ROOT, 'server/outreachDirectory.ts'), 'utf8');
    const outreach = readFileSync(join(ROOT, 'src/renderer/components/OutreachAnalytics.tsx'), 'utf8');
    const workspace = readFileSync(join(ROOT, 'src/renderer/components/OutreachTargetWorkspace.tsx'), 'utf8');
    const migration = readFileSync(join(ROOT, 'drizzle/0004_warm_corsair.sql'), 'utf8');

    expect(routers).toContain('outreachDirectory: outreachDirectoryRouter');
    expect(outreach).toContain('<TabsTrigger className="min-h-8" value="lawyers">');
    expect(outreach).toContain('<OutreachTargetWorkspace targetType="media" />');
    expect(outreach).toContain('<OutreachTargetWorkspace targetType="organization" />');
    expect(workspace).toContain('status: "approved"');
    expect(workspace).toContain('status: "rejected"');
    expect(workspace).toContain('status: "shortlisted"');
    expect(directory).toContain('rawCaseTextShared: false');
    expect(directory).toContain('eq(outreachDirectoryTargets.status, "approved")');
    expect(directory).toContain('db.delete(caseOutreachTargetMatches)');
    expect(migration).toContain('CREATE TABLE `outreach_directory_targets`');
    expect(migration).toContain('CREATE TABLE `case_outreach_target_matches`');
    expect(migration).not.toContain('__new_');
    expect(migration).not.toContain('DROP TABLE');
  });

  it('keeps the desktop scanner consent-gated and fail-closed', () => {
    const main = readFileSync(join(ROOT, 'src-main/index.ts'), 'utf8');
    const app = readFileSync(join(ROOT, 'src/renderer/App.tsx'), 'utf8');
    const home = readFileSync(join(ROOT, 'src/renderer/pages/HomePage.tsx'), 'utf8');
    const scan = readFileSync(join(ROOT, 'src/renderer/pages/ScanPage.tsx'), 'utf8');
    const uploader = readFileSync(join(ROOT, 'src-main/uploader.ts'), 'utf8');
    const routers = readFileSync(join(ROOT, 'server/routers/index.ts'), 'utf8');

    expect(existsSync(join(ROOT, 'src/renderer/pages/AuthPage.tsx'))).toBe(false);
    expect(app).toContain('getScannerToken');
    expect(app).toContain('scanner never creates an offline or anonymous session');
    expect(home).toContain('Nothing uploads until you review the results');
    expect(home).toContain('folders: scanFolders');
    expect(home).toContain('autoUpload: false');
    expect(scan).toContain('setScanFileSelection');
    expect(scan).toContain('Upload selected');
    expect(main).toContain('approvedScanFolders');
    expect(main).toContain("autoUpload: false");
    expect(main).toContain("process.env.HOST = '127.0.0.1'");
    expect(main).not.toContain("ipcMain.handle('agent:token'");
    expect(uploader).toContain('evidenceFiles.upload.mutate');
    expect(uploader).not.toContain('s3.example.com');
    expect(uploader).not.toMatch(/simulat(?:e|ed|ing) S3 upload/i);
    expect(routers).not.toContain('localFileUpload: router');
    expect(existsSync(join(ROOT, 'src/renderer/components/LocalFileUpload.tsx'))).toBe(false);
  });

  it('accepts only bounded supported evidence files', async () => {
    const rules = await import('../../shared/evidenceFiles');
    expect(rules.MAX_EVIDENCE_FILE_BYTES).toBe(7 * 1024 * 1024);
    expect(rules.isSupportedEvidenceMimeType('application/pdf')).toBe(true);
    expect(rules.isSupportedEvidenceMimeType('image/png')).toBe(true);
    expect(rules.isSupportedEvidenceMimeType('application/x-msdownload')).toBe(false);
    expect(rules.evidenceTypeForMime('message/rfc822')).toBe('email');
  });
});
