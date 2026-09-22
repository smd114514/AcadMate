import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth.js';
import { agentBase, agentUrl } from '../harnessClient.js';
import { apiSettingsRequired, getLlmApiSettings, hasUsableLlmSettings } from '../services/llmSettings.js';
import { researchAgentOverrides, researchAgentTimeoutMs } from '../researchRuntime.js';

export const agentMemoriesRouter = Router();
agentMemoriesRouter.use(authMiddleware);

function memoryPrefix(userId: number): string {
  return `/memories/users/${userId}/`;
}

/** The browser can only see the current user's PaperClaw memory namespace.
 * The FastAPI read-model endpoint is intentionally kept private behind this
 * authenticated BFF route. */
agentMemoriesRouter.get('/', async (req: AuthRequest, res: Response) => {
  if (!agentBase()) {
    res.status(503).json({ message: '记忆智能体未配置，请先启动 PaperClaw 服务。' });
    return;
  }
  try {
    const upstream = await fetch(agentUrl('/api/memories'), { signal: AbortSignal.timeout(10_000) });
    if (!upstream.ok) {
      res.status(upstream.status).json({ message: (await upstream.text().catch(() => '')).slice(0, 300) || '无法读取智能体记忆。' });
      return;
    }
    const records = await upstream.json().catch(() => []) as unknown;
    const prefix = memoryPrefix(req.userId!);
    const items = Array.isArray(records)
      ? records.filter((item) => item && typeof item === 'object' && String((item as { path?: unknown }).path || '').startsWith(prefix))
      : [];
    res.json({ items });
  } catch (error) {
    res.status(503).json({ message: error instanceof Error ? `无法连接记忆智能体：${error.message}` : '无法连接记忆智能体。' });
  }
});

agentMemoriesRouter.post('/stream', async (req: AuthRequest, res: Response) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content || content.length > 1000) {
    res.status(400).json({ message: '记忆内容需为 1–1000 个字符。' });
    return;
  }
  if (!agentBase()) {
    res.status(503).json({ message: '记忆智能体未配置，请先启动 PaperClaw 服务。' });
    return;
  }
  if (!hasUsableLlmSettings(req.userId!)) {
    res.status(400).json(apiSettingsRequired('记忆智能体'));
    return;
  }

  const settings = getLlmApiSettings(req.userId!, true);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), researchAgentTimeoutMs());
  res.on('close', () => controller.abort());
  try {
    const prefix = memoryPrefix(req.userId!);
    const upstream = await fetch(agentUrl('/api/agent/messages/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `请将以下内容作为用户明确要求保存的长期记忆处理，并简要说明你保存了什么：\n${content}`,
        ...researchAgentOverrides('research'),
        model: settings.model,
        api_key: settings.apiKey,
        base_url: settings.baseUrl,
        metadata: {
          surface: 'memory',
          owner_id: String(req.userId!),
          extra_instructions: `你正在处理记忆请求。仅在用户已明确要求保存的情况下写入长期记忆；本请求已满足该条件。只可读写当前用户的 ${prefix} 命名空间，优先使用 ${prefix}preferences.md 或 ${prefix}notes.md。不要读取、修改或提及其他 /memories/ 路径。不要保存密钥、完整论文、附件全文或工具原始输出。`,
        },
      }),
      signal: controller.signal,
    });
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status || 502).json({ message: (await upstream.text().catch(() => '')).slice(0, 500) || '记忆智能体调用失败。' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (value) res.write(decoder.decode(value, { stream: !done }));
      if (done) break;
    }
    res.end();
  } catch (error) {
    if (!res.headersSent) res.status(502).json({ message: error instanceof Error ? `记忆智能体调用失败：${error.message}` : '记忆智能体调用失败。' });
    else res.end();
  } finally {
    clearTimeout(timeout);
  }
});
