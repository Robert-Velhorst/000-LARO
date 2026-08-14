import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const operations = {
  backup: {
    built: 'dist/server/scripts/backup.js',
    source: 'scripts/backup.ts',
  },
  'data-readiness': {
    built: 'dist/server/scripts/data-readiness.js',
    source: 'scripts/data-readiness.ts',
    preferSourceWhenAvailable: true,
    rebuildNodeForSource: true,
  },
  'acceptance:providers': {
    built: 'dist/server/server/liveProviderAcceptance.js',
    source: 'server/liveProviderAcceptance.ts',
  },
  'acceptance:outbound-live': {
    built: 'dist/server/server/liveOutboundAcceptance.js',
    source: 'server/liveOutboundAcceptance.ts',
  },
  'acceptance:google-evidence-live': {
    built: 'dist/server/server/liveGoogleEvidenceAcceptance.js',
    source: 'server/liveGoogleEvidenceAcceptance.ts',
  },
  'acceptance:google-drive-evidence-live': {
    built: 'dist/server/server/liveGoogleDriveEvidenceAcceptance.js',
    source: 'server/liveGoogleDriveEvidenceAcceptance.ts',
  },
};

const operationName = process.argv[2];
const operation = operations[operationName];
if (!operation) {
  console.error(`Unknown runtime operation: ${operationName || '<missing>'}`);
  process.exit(2);
}

const builtPath = resolve(operation.built);
const sourcePath = resolve(operation.source);
let tsxCli;
try {
  tsxCli = require.resolve('tsx/cli');
} catch {
  tsxCli = undefined;
}
const useSource = Boolean(operation.preferSourceWhenAvailable && tsxCli);
let childArguments;
if (!useSource && existsSync(builtPath)) {
  childArguments = [builtPath, ...process.argv.slice(3)];
} else {
  if (!tsxCli) {
    console.error(
      `The compiled runtime operation is missing: ${operation.built}. ` +
        'Build the server before running this command in a production installation.',
    );
    process.exit(1);
  }
  if (operation.rebuildNodeForSource) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
      console.error('Run this maintenance operation through its npm script so the Node native module can be rebuilt.');
      process.exit(1);
    }
    const rebuild = spawnSync(process.execPath, [npmCli, 'run', 'rebuild:node'], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (rebuild.error) {
      console.error(rebuild.error.message);
      process.exit(1);
    }
    if (rebuild.status !== 0) process.exit(rebuild.status ?? 1);
  }
  childArguments = [tsxCli, sourcePath, ...process.argv.slice(3)];
}

const child = spawnSync(process.execPath, childArguments, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});
if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}
process.exit(child.status ?? 1);
