import { operatorProcedure, publicProcedure, router } from '../_core/trpc';
import { getOperatorDiagnostics } from '../operatorDiagnostics';

export const healthRouter = router({
  check: publicProcedure
    .query(() => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
      };
    }),

  // Phase 016/035 / S1-25 — detailed readiness is operational data and requires
  // the same operator capability and canonical snapshot as admin diagnostics.
  readiness: operatorProcedure.query(async () => {
    const diagnostics = await getOperatorDiagnostics();
    const anyJobFailing = diagnostics.workers.some((worker) => worker.status === 'failed');
    return {
      status: diagnostics.db.ready && !anyJobFailing ? 'ready' as const : 'degraded' as const,
      dbReady: diagnostics.db.ready,
      jobs: diagnostics.jobs,
      timestamp: diagnostics.generatedAt,
    };
  }),
});
