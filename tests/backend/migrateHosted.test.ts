import { describe, expect, it } from 'vitest';
import { assertHostedPostgresUrl } from '../../scripts/migrate-hosted';

describe('hosted migration command', () => {
  it('accepts PostgreSQL URLs and rejects local SQLite paths', () => {
    expect(assertHostedPostgresUrl('postgres://laro:password@db.example.test:5432/laro')).toBe(
      'postgres://laro:password@db.example.test:5432/laro'
    );
    expect(() => assertHostedPostgresUrl('laro.sqlite')).toThrow('DATABASE_URL must be a PostgreSQL URL');
  });
});
