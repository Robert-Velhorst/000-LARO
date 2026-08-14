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
};

const operationName = process.argv[2];
const operation = operations[operationName];
if (!operation) {
  console.error(`Unknown runtime operation: ${operationName || '<missing>'}`);
  process.exit(2);
}

const builtPath = resolve(operation.built);
const sourcePath = resolve(operation.source);
let childArguments;
if (existsSync(builtPath)) {
  childArguments = [builtPath, ...process.argv.slice(3)];
} else {
  let tsxCli;
  try {
    tsxCli = require.resolve('tsx/cli');
  } catch {
    console.error(
      `The compiled runtime operation is missing: ${operation.built}. ` +
      'Build the server before running this command in a production installation.',
    );
    process.exit(1);
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
