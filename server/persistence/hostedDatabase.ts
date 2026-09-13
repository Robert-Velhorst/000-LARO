import { Pool, type PoolConfig, type QueryResultRow } from 'pg';

export type PostgresQueryResult<Row extends QueryResultRow = QueryResultRow> = {
  rows: Row[];
};

export interface PostgresClient {
  query<Row extends QueryResultRow = QueryResultRow>(query: string, values?: unknown[]): Promise<PostgresQueryResult<Row>>;
  release(): void;
}

export interface PostgresPool {
  query<Row extends QueryResultRow = QueryResultRow>(query: string, values?: unknown[]): Promise<PostgresQueryResult<Row>>;
  connect(): Promise<PostgresClient>;
  end(): Promise<void>;
}

export type HostedDatabaseOptions = {
  connectionString: string;
  pool?: PostgresPool;
  maxConnections?: number;
};

export type HostedDatabase = {
  healthCheck(): Promise<{ healthy: true }>;
  transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

function createPool(connectionString: string, maxConnections: number): PostgresPool {
  const config: PoolConfig = {
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
  return new Pool(config) as unknown as PostgresPool;
}

/**
 * Hosted PostgreSQL primitive. It intentionally owns only connection lifecycle
 * and transaction semantics; schema and repository migration are introduced
 * separately so the current local SQLite database remains unaffected.
 */
export function createHostedDatabase(options: HostedDatabaseOptions): HostedDatabase {
  const pool = options.pool ?? createPool(options.connectionString, options.maxConnections ?? 10);

  return {
    async healthCheck(): Promise<{ healthy: true }> {
      const result = await pool.query<{ healthy: number }>('SELECT 1 AS healthy');
      if (result.rows[0]?.healthy !== 1) {
        throw new Error('PostgreSQL health check returned an unexpected result');
      }
      return { healthy: true };
    },

    async transaction<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('[HostedDatabase] PostgreSQL rollback failed', rollbackError);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
