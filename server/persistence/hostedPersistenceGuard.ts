import type { RuntimeMode } from '../_core/runtimeMode';

export type DatabaseRuntime = {
  runtimeMode: RuntimeMode;
  databaseUrl: string;
};

/**
 * Prevents a public deployment from treating a PostgreSQL connection string
 * as a filename for the desktop SQLite driver. The hosted repository migration
 * is deliberately additive and is not enabled until its data, backup, GDPR,
 * and integrity paths are all available.
 */
export function assertDatabaseRuntimeIsSupported(runtime: DatabaseRuntime): void {
  if (runtime.runtimeMode === 'hosted') {
    throw new Error(
      'Hosted PostgreSQL persistence is not installed. Keep LARO_RUNTIME_MODE=local until the additive hosted repository migration is deployed.'
    );
  }
}
