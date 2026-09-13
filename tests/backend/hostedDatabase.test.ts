import { describe, expect, it, vi } from 'vitest';
import { createHostedDatabase, type PostgresClient, type PostgresPool } from '../../server/persistence/hostedDatabase';

function createPool(): { pool: PostgresPool; client: PostgresClient } {
  const client: PostgresClient = {
    query: vi.fn(async (query: string) => ({ rows: query === 'SELECT 1 AS healthy' ? [{ healthy: 1 }] : [] })),
    release: vi.fn(),
  };
  return {
    client,
    pool: {
      query: vi.fn(async (query: string) => ({ rows: query === 'SELECT 1 AS healthy' ? [{ healthy: 1 }] : [] })),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    },
  };
}

describe('hosted PostgreSQL boundary', () => {
  it('probes PostgreSQL without exposing the connection string', async () => {
    const { pool } = createPool();
    const database = createHostedDatabase({
      connectionString: 'postgresql://laro:private-password@postgres.example.test:5432/laro',
      pool,
    });

    await expect(database.healthCheck()).resolves.toEqual({ healthy: true });
    expect(pool.query).toHaveBeenCalledWith('SELECT 1 AS healthy');
  });

  it('commits an application transaction once its work completes', async () => {
    const { pool, client } = createPool();
    const database = createHostedDatabase({ connectionString: 'postgresql://laro@example.test/laro', pool });

    await expect(database.transaction(async (tx) => {
      await tx.query('SELECT current_user');
      return 'complete';
    })).resolves.toBe('complete');

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(3, 'COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases a failed transaction', async () => {
    const { pool, client } = createPool();
    const database = createHostedDatabase({ connectionString: 'postgresql://laro@example.test/laro', pool });

    await expect(database.transaction(async () => {
      throw new Error('intentional failure');
    })).rejects.toThrow('intentional failure');

    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
