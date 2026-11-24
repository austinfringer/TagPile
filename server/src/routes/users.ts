import { Router } from 'express';
import { deleteUser, listUsers } from '../db/auth_operations.ts';
import type { Db } from '../db/index.ts';
import { requireAdmin } from './util.ts';

export interface UsersDeps {
  db: Db;
}

/** Admin-only user list and user removal. */
export function usersRouter({ db }: UsersDeps) {
  const router = Router();

  router.get('/users', (req, res) => {
    if (!requireAdmin(db, req, res)) return;
    res.json({ users: listUsers(db) });
  });

  router.delete('/users/:id', (req, res) => {
    const adminId = requireAdmin(db, req, res);
    if (!adminId) return;
    const id = String(req.params.id);
    if (id === adminId) {
      return res.status(409).json({ error: 'You cannot remove your own account' });
    }
    if (!deleteUser(db, id)) return res.status(404).json({ error: 'User not found' });
    res.status(204).send();
  });

  return router;
}
