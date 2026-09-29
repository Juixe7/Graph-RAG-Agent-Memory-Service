#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — MCP Server
 *  Exposes the REST API (recall / remember / search / tasks /
 *  messages / node lookup / health) as MCP tools so any MCP-aware
 *  client can read and write the same shared vault, whether or not
 *  the REST API server happens to be running yet.
 *  Pure Node.js · Zero dependencies · stdio transport
 * ══════════════════════════════════════════════════════════════
 */

import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const PORT      = parseInt(process.env.BRAIN_PORT || '3747', 10);
const HOST      = process.env.BRAIN_HOST || 'localhost';
const AUTH_KEY  = process.env.BRAIN_KEY || '';
const BASE      = `http://${HOST}:${PORT}`;

function log(...args) {
  console.error('[second-brain-mcp]', ...args);
}

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(BASE + urlPath, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_KEY ? { Authorization: `Bearer ${AUTH_KEY}` } : {}),
      },
      timeout: 15000,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = chunks ? JSON.parse(chunks) : {}; } catch { parsed = { raw: chunks }; }
        if (res.statusCode >= 400) {
          reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request to Second Brain server timed out')));
    if (data) req.write(data);
    req.end();
  });
}

function checkHealth() {
  return request('GET', '/health').then(() => true).catch(() => false);
}

let ensureServerPromise = null;
async function ensureServerRunning() {
  if (await checkHealth()) return true;
  // Only one start attempt at a time, even if several tool calls race in.
  if (!ensureServerPromise) {
    ensureServerPromise = (async () => {
      log(`Server not reachable at ${BASE} — starting "node api/server.js" in ${ROOT}...`);
      const child = spawn(process.execPath, ['api/server.js'], {
        cwd: ROOT,
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (await checkHealth()) { log('Server is up.'); return true; }
      }
      return false;
    })();
  }
  return ensureServerPromise;
}

// ── Tool definitions ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'brain_recall',
    description: 'Recall relevant memory/context from the shared Second Brain vault for a query, using graph-RAG (BFS over wikilinks, plus a semantic-similarity signal when embeddings are configured) within a token budget. Call this before answering questions that might already have research, decisions, or notes stored from other work.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall context for' },
        hops: { type: 'number', description: 'Graph traversal depth from seed matches (default 1)' },
        maxTokens: { type: 'number', description: 'Token budget for the returned context (default 2000)' },
      },
      required: ['query'],
    },
    handler: async ({ query, hops, maxTokens }) => {
      const qs = new URLSearchParams({ q: query });
      if (hops != null) qs.set('hops', String(hops));
      if (maxTokens != null) qs.set('maxTokens', String(maxTokens));
      return request('GET', `/recall?${qs}`);
    },
  },
  {
    name: 'brain_remember',
    description: 'Write a new memory/research note into the shared Second Brain vault so future sessions, in this or any other project, can recall it later. Memory hygiene: only call this for a genuine, reusable learning — a fact, pattern, constraint, or decision that will change future behavior or save someone from re-deriving something. Do NOT call it for routine task completions, raw task output, status updates, or anything the task queue already records. Before calling, ask: "would a future session be worse off without this specific note?" — if no, skip it. Prefer updating an existing relevant note over creating a near-duplicate one (see brain_dedup_scan).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' },
        type: { type: 'string', description: 'memory|note|research|decision|insight|task (default memory)' },
        tags: { type: 'array', items: { type: 'string' } },
        agent: { type: 'string', description: 'Name identifying the calling project or agent' },
        importance: { type: 'number', description: '1-10, default 5' },
      },
      required: ['title', 'content'],
    },
    handler: ({ title, content, type, tags, agent, importance }) =>
      request('POST', '/remember', { title, content, type, tags, agent, importance }),
  },
  {
    name: 'brain_search',
    description: 'Hybrid keyword + semantic search across the vault (titles, tags, content), fused via Reciprocal Rank Fusion. Lighter-weight than brain_recall — returns ranked matches, not an assembled context block.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    handler: ({ query, limit }) => {
      const qs = new URLSearchParams({ q: query });
      if (limit != null) qs.set('limit', String(limit));
      return request('GET', `/search?${qs}`);
    },
  },
  {
    name: 'brain_node_get',
    description: 'Fetch a single vault node by id, including its full content, outlinks, and backlinks.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: ({ id }) => request('GET', `/node/${encodeURIComponent(id)}`),
  },
  {
    name: 'brain_tasks_submit',
    description: 'Submit a task/goal to the Second Brain vault-backed task queue for asynchronous work. This is a lightweight coordination primitive (a shared, auditable markdown task list with dependency-based blocking), not an autonomous orchestrator — something else still needs to watch pending tasks and do the work.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        title: { type: 'string' },
        agents: { type: 'array', items: { type: 'string' }, description: 'Agent names to assign this task to' },
        priority: { type: 'number' },
        dependencies: { type: 'array', items: { type: 'string' }, description: 'Task node ids that must complete first' },
      },
      required: ['prompt'],
    },
    handler: ({ prompt, title, agents, priority, dependencies }) =>
      request('POST', '/tasks/submit', { prompt, title, agents, priority, dependencies }),
  },
  {
    name: 'brain_tasks_list',
    description: 'List tasks in the Second Brain task queue, optionally filtered by status tag (e.g. pending, blocked, completed, failed, cancelled).',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
    handler: ({ status }) => request('GET', status ? `/tasks?status=${encodeURIComponent(status)}` : '/tasks'),
  },
  {
    name: 'brain_messages_send',
    description: 'Send a message from one agent/project to another agent inbox in the Second Brain vault.',
    inputSchema: {
      type: 'object',
      properties: {
        toAgent: { type: 'string' },
        fromAgent: { type: 'string' },
        content: { type: 'string' },
        subject: { type: 'string' },
      },
      required: ['toAgent', 'content'],
    },
    handler: ({ toAgent, fromAgent, content, subject }) =>
      request('POST', '/messages/send', { toAgent, fromAgent, content, subject }),
  },
  {
    name: 'brain_messages_get',
    description: 'Read an agent inbox from the Second Brain vault (unread only, by default).',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string' },
        unread: { type: 'boolean' },
      },
      required: ['agent'],
    },
    handler: ({ agent, unread }) =>
      request('GET', `/messages/${encodeURIComponent(agent)}${unread === false ? '?unread=false' : ''}`),
  },
  {
    name: 'brain_health',
    description: 'Check whether the Second Brain server is up and get vault stats (node/edge counts).',
    inputSchema: { type: 'object', properties: {} },
    handler: () => request('GET', '/health'),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ── Minimal MCP JSON-RPC over stdio ──────────────────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function replyResult(id, result) {
  if (id === undefined) return; // notification, no reply expected
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;
  try {
    switch (method) {
      case 'initialize':
        replyResult(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'second-brain', version: '1.1.0' },
        });
        return;

      case 'notifications/initialized':
      case 'initialized':
        return; // no reply

      case 'ping':
        replyResult(id, {});
        return;

      case 'tools/list':
        replyResult(id, {
          tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
        return;

      case 'tools/call': {
        const { name, arguments: args = {} } = params || {};
        const tool = TOOLS_BY_NAME.get(name);
        if (!tool) {
          replyError(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        const up = await ensureServerRunning();
        if (!up) {
          replyResult(id, {
            content: [{ type: 'text', text: `Second Brain server could not be started at ${BASE}. Is Node available at "${ROOT}"?` }],
            isError: true,
          });
          return;
        }
        try {
          const result = await tool.handler(args);
          replyResult(id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          });
        } catch (err) {
          replyResult(id, {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          });
        }
        return;
      }

      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32603, err.message);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('Failed to parse message:', line); continue; }
    handleMessage(msg);
  }
});

// Don't force-exit here: a tools/call may still be awaiting the server's
// response. Let the event loop drain naturally once all pending requests
// (and the health-check retry loop) settle.
process.stdin.on('end', () => {});

log(`Ready. Will proxy to ${BASE} (auto-starting the API server on first tool call if needed).`);

// Kick off a background health check / boot at startup so the first real
// tool call doesn't have to pay the cold-start latency.
ensureServerRunning().catch(() => {});
