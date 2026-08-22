import { afterAll, describe, expect, it } from 'vitest';
import { createHostedDatabase } from '../../server/persistence/hostedDatabase';

const connectionString = process.env.LARO_HOSTED_TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
let database: ReturnType<typeof createHostedDatabase> | undefined;

suite('hosted PostgreSQL connection', () => {
  afterAll(async () => {
    await database?.close();
  });

  it('connects to the configured PostgreSQL service and commits a transaction', async () => {
    database = createHostedDatabase({ connectionString: connectionString! });
    await expect(database.healthCheck()).resolves.toEqual({ healthy: true });
    await expect(database.transaction(async (client) => {
      const result = await client.query<{ value: number }>('SELECT 42 AS value');
      return result.rows[0]?.value;
    })).resolves.toBe(42);
  });
});
