import { Router, Response } from 'express';
import { getDb } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

export const memoriesRouter = Router();
memoriesRouter.use(authMiddleware);

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** GPT-like memory is intentionally explicit: ordinary chats never create a
 * record here. A later trusted event pipeline may use source=important_event. */
memoriesRouter.get('/', (req: AuthRequest, res: Response) => {
  const items = getDb().prepare(
    `SELECT id, content, source, created_at, updated_at
     FROM user_memories WHERE user_id=? ORDER BY updated_at DESC, id DESC LIMIT 100`,
  ).all(req.userId!) as Array<Record<string, unknown>>;
  res.json({ items });
});

memoriesRouter.post('/', (req: AuthRequest, res: Response) => {
  const content = String(req.body?.content || '').trim().replace(/\s+/g, ' ');
  if (!content) { res.status(400).json({ message: '记忆内容不能为空' }); return; }
  if (content.length > 1000) { res.status(400).json({ message: '单条记忆不能超过 1000 个字符' }); return; }
  const source = req.body?.source === 'important_event' ? 'important_event' : 'user';
  const result = getDb().prepare(
    `INSERT INTO user_memories (user_id, content, source) VALUES (?, ?, ?)`,
  ).run(req.userId!, content, source);
  const item = getDb().prepare(
    'SELECT id, content, source, created_at, updated_at FROM user_memories WHERE id=? AND user_id=?',
  ).get(result.lastInsertRowid, req.userId!);
  res.status(201).json(item);
});

memoriesRouter.delete('/:id', (req: AuthRequest, res: Response) => {
  const id = positiveId(req.params.id);
  if (!id) { res.status(400).json({ message: '无效的记忆编号' }); return; }
  const result = getDb().prepare('DELETE FROM user_memories WHERE id=? AND user_id=?').run(id, req.userId!);
  if (!result.changes) { res.status(404).json({ message: '记忆不存在或不属于当前用户' }); return; }
  res.json({ deleted: true });
});
