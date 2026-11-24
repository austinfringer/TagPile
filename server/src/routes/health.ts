import { Router } from 'express';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import { verifyJwtCookie } from './auth.ts';

export interface HealthDeps {
  db: Db;
  version: string;
  config: Config;
}

/** Public, so a monitor or proxy can check the server with no session. Only a caller with a
 *  valid JWT also gets the version and uptime. */
export function healthRouter({ db, version, config }: HealthDeps): Router {
  const router = Router();

  router.get('/health', async (req, res) => {
    db.prepare('SELECT 1').get();
    if (!(await verifyJwtCookie(config, req.headers.cookie))) return res.json({ status: 'ok' });
    res.json({ status: 'ok', version, uptime: process.uptime() });
  });

  return router;
}
