import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

interface PackageManifest {
  version?: unknown;
}

export function resolveAppVersion(
  environment: NodeJS.ProcessEnv = process.env,
  manifestPath = resolve(process.cwd(), 'package.json'),
): string {
  const configured = [environment.LARO_APP_VERSION, environment.npm_package_version]
    .map((value) => value?.trim())
    .find((value) => value && value.toLowerCase() !== 'unknown');
  if (configured) return configured;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    return typeof manifest.version === 'string' && manifest.version.trim()
      ? manifest.version.trim()
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Application version shared by health, system, and administration surfaces. */
export const APP_VERSION = resolveAppVersion();
