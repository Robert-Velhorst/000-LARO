import { readFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';

const { values } = parseArgs({ options: { config: { type: 'string' } } });
if (!values.config) throw new Error('An explicit private workspace configuration is required');
const configPath = realpathSync(values.config);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (config.testAccess !== true) throw new Error('Local test access is not enabled');
if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid local port');
const origin = `http://127.0.0.1:${config.port}`;
const ready = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(5000) });
if (!ready.ok || !(await ready.json()).dbReady) throw new Error('Start the local workspace first');
const environment = dotenv.parse(readFileSync(path.resolve(path.dirname(configPath), config.environment)));
if (!environment.JWT_SECRET || environment.JWT_SECRET.length < 32) throw new Error('Existing strong workspace key required');
const db = new Database(path.resolve(path.dirname(configPath), config.database), { readonly: true, fileMustExist: true });
let owner;
try {
  const users = db.prepare('SELECT id FROM users LIMIT 2').all();
  if (users.length !== 1) throw new Error('Local test access requires exactly one existing owner; no account was selected');
  owner = users[0].id;
} finally { db.close(); }
const ticket = jwt.sign({ purpose: 'local-test-access' }, environment.JWT_SECRET, {
  algorithm: 'HS256', subject: owner, jwtid: randomBytes(32).toString('hex'),
  issuer: 'laro-local-operator', audience: 'laro-local-test', expiresIn: '5m',
});
// Fragment is not sent in HTTP requests or referrer headers. Never print it.
const url = `${origin}/#local-test=${encodeURIComponent(ticket)}`;
if (process.platform !== 'win32') throw new Error('This desktop opener supports Windows only');
const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
let code;
try { [code] = await once(browser, 'exit'); }
catch { throw new Error('Could not open the local test link'); }
if (code !== 0) throw new Error('Could not open the local test link');
console.log('Local test link opened in your browser. Valid for five minutes and one use.');
