#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Create fresh installation secrets once. Refuse to overwrite a deployment's
// existing session/encryption keys, which are also needed to recover its data.
const [address, destination = '.env.hetzner'] = process.argv.slice(2);
try {
  if (!address) throw new Error('Usage: node scripts/setup-hetzner.mjs https://laro.example.com [env-file]');
  const url = new URL(address);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.pathname !== '/' || url.search || url.hash ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname)) {
    throw new Error('Use the HTTPS root address of a domain, without a port, path, or credentials.');
  }
  const output = resolve(destination);
  const content = [
    '# Private LARO installation configuration. Keep a protected backup of this file.',
    `LARO_DOMAIN=${url.hostname}`,
    'LARO_IMAGE_TAG=local',
    'LARO_BIND_PORT=3187',
    `JWT_SECRET=${randomBytes(32).toString('hex')}`,
    `COOKIE_SECRET=${randomBytes(32).toString('hex')}`,
    '# Enter this setup code in the signup form to create the first owner.',
    '# Enrollment closes automatically after that account has been created.',
    `STANDALONE_SIGNUP_TOKEN=${randomBytes(32).toString('hex')}`,
    'LARO_BACKUP_RETENTION_COUNT=14',
    'LARO_BACKUP_RETENTION_DAYS=30',
    'LARO_BACKUP_MAX_AGE_HOURS=30',
    '# Add Google, email, and optional AI credentials here when available.',
    'LARO_REQUIRED_LIVE_PROVIDERS=',
    '',
  ].join('\n');
  writeFileSync(output, content, { flag: 'wx', mode: 0o600 });
  console.log(`Created ${output}. Secrets were not printed. Keep this file private and backed up.`);
} catch (error) {
  console.error(error?.code === 'EEXIST'
    ? 'Configuration already exists; refusing to replace installation secrets.'
    : error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
