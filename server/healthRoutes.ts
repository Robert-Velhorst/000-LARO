import { Router } from 'express';
import { createContext } from './context';
import { roleSatisfies } from './_core/roles';
import {
  getOperatorDiagnostics,
  getPublicHealthSummary,
  getPublicReadiness,
} from './operatorDiagnostics';

const router = Router();

function noStore(res: any): void {
  res.setHeader('Cache-Control', 'no-store');
}

router.get('/api/live', (_req, res) => {
  noStore(res);
  res.status(200).json({ status: 'alive' });
});

router.get('/api/ready', async (_req, res) => {
  const readiness = await getPublicReadiness();
  noStore(res);
  res.status(readiness.dbReady ? 200 : 503).json(readiness);
});

router.get('/api/health', async (_req, res) => {
  const health = await getPublicHealthSummary();
  noStore(res);
  res.status(health.dbReady ? 200 : 503).json(health);
});

router.get('/api/operator/diagnostics', async (req, res) => {
  try {
    const ctx = await createContext({ req, res });
    noStore(res);
    if (!ctx.user || ctx.authScope !== 'session') {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roleSatisfies(ctx.user.role, 'operator')) {
      res.status(403).json({ error: 'Operator access required' });
      return;
    }
    res.status(200).json(await getOperatorDiagnostics());
  } catch {
    noStore(res);
    res.status(503).json({ error: 'Operator diagnostics unavailable' });
  }
});

export default router;
