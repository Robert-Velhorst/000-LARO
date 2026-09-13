import { describe, expect, it } from 'vitest';
import { assertDatabaseRuntimeIsSupported } from '../../server/persistence/hostedPersistenceGuard';

describe('hosted persistence guard', () => {
  it('rejects a PostgreSQL URL until the hosted repository migration is installed', () => {
    expect(() => assertDatabaseRuntimeIsSupported({
      runtimeMode: 'hosted',
      databaseUrl: 'postgres://laro:secret@db.example.test:5432/laro',
    })).toThrow('Hosted PostgreSQL persistence is not installed');
  });

  it('allows the existing local SQLite runtime', () => {
    expect(() => assertDatabaseRuntimeIsSupported({
      runtimeMode: 'local',
      databaseUrl: 'laro.sqlite',
    })).not.toThrow();
  });
});
