/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — REST API Server
 *  Pure Node.js · Zero dependencies · Fully offline
 *
 *  Start:   node api/server.js
 *  Port:    3747  (or set BRAIN_PORT env var)
 *
 *  ENDPOINTS:
 *   GET  /health
 *   GET  /nodes                         → index of all nodes
 *   GET  /node/:id                      → single node + links
 *   GET  /search?q=...&limit=10
 *   GET  /recall?q=...&hops=1&maxTokens=2000  ← KEY for agents
 *   GET  /graph                         → adjacency map
 *   GET  /type/:type
 *   GET  /tags
 *   GET  /tag/:tag
 *   GET  /agent/:name                   → all nodes for an agent
 *   POST /remember                      → write new memory to vault
 *   PATCH /node/:id                     → update node
 *   DELETE /node/:id                    → delete node
 *   POST /tasks/submit                  → submit a multi-agent task
 *   GET  /tasks?status=...              → list tasks
 *   PATCH /tasks/:id                    → update a task's status
 *   POST /messages/send                 → send an agent-to-agent message
 *   GET  /messages/:agent?unread=false  → read an agent's inbox
 *   GET  /org-chart                     → department/lead structure from persona tags
 *   POST /dedup/scan                    → report near-duplicate node candidates
 *   POST /sandbox/execute               → run a code snippet, sandboxed
 *   POST /embeddings/reindex            → (re)compute semantic vectors for the vault
 *   GET  /export                        → full JSON export
 *   POST /reload                        → force reload vault from disk
 * ══════════════════════════════════════════════════════════════
 */

import http   from 'http';
import https  from 'https';
import fs     from 'fs';
import path   from 'path';
import { URL } from 'url';
import { fileURLToPath } from 'url';

import {
  loadVault, writeNode, updateNodeFile, deleteNodeFile,
  buildEdges, buildBacklinks, searchNodes, searchNodesWithSemantics, buildContext,
  parseWikiLinks, parseTags, validateNode,
} from './brain_engine.js';
import { resolveKeys } from '../sdk/models_config.js';
import { createGitSync } from '../sdk/git_sync.js';
import { TaskQueue } from '../sdk/task_queue.js';
import { Messenger } from '../sdk/messenger.js';
import { buildOrgChart } from '../sdk/org_chart.js';
import { scanForDuplicates } from '../sdk/dedup.js';
import { executeCode } from '../sdk/sandbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.resolve(__dirname, '..', 'vault');
const PORT      = parseInt(process.env.BRAIN_PORT || '3747', 10);
const AUTO_SYNC = process.env.AUTO_GIT_SYNC === 'true';

// ── In-memory cache (reloaded on vault change) ───────────────────────────────
let nodes = {};
let lastReload = null;

function reload() {
  nodes      = loadVault();
  lastReload = new Date().toISOString();
  console.log(`[brain] Reloaded: ${Object.keys(nodes).length} nodes`);
}

// Watch vault folder for changes (Obsidian edits reload automatically)
fs.watch(VAULT_DIR, { recursive: true }, (event, filename) => {
  if (filename?.endsWith('.md')) {
    setTimeout(reload, 300); // debounce
  }
});

let sseClients = [];

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (e) {
      // Remove broken connections automatically
      sseClients = sseClients.filter(c => c !== client);
    }
  }
}


// ── HTTP helpers ─────────────────────────────────────────────────────────────
const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data, null, 2));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

const AUTH_KEY  = process.env.BRAIN_KEY || '';

function authenticate(req, res) {
  if (!AUTH_KEY) return true;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const key = authHeader.substring(7).trim();
    if (key === AUTH_KEY) return true;
  }
  json(res, { error: 'Unauthorized: Invalid or missing API key in Authorization header' }, 401);
  return false;
}

// Serialized, path-scoped auto-commit: only stages the files a caller says
// actually changed (never a blanket `git add vault`, which would sweep up
// any other unrelated in-progress edit into whatever commit fires next),
// and queues concurrent writes instead of racing on .git/index.lock. Same
// AUTO_GIT_SYNC env var as before — this is a reliability upgrade of the
// existing feature, not a new one. See sdk/git_sync.js.
const { gitSync, toVaultRelativePath } = createGitSync(VAULT_DIR, {
  enabled: AUTO_SYNC,
  onError:   (err) => console.error(`[brain] ❌ Git Sync failed: ${err.message}`),
  onSuccess: (message) => console.log(`[brain] 🔄 Git Sync completed: ${message}`),
});

// Task queue / messenger talk to this same server over its own REST API
// (see sdk/index.js's SecondBrain client) rather than touching the vault
// directly, so a fresh instance per call is cheap and keeps them decoupled
// from this file's in-memory `nodes` cache.
function makeTaskQueue() {
  return new TaskQueue({ apiKey: AUTH_KEY, api: `http://localhost:${PORT}`, silent: false });
}
function makeMessenger() {
  return new Messenger({ apiKey: AUTH_KEY, api: `http://localhost:${PORT}`, silent: false });
}

async function callGemini(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING", description: "Consolidated, concise title of the note" },
            content: { type: "STRING", description: "Consolidated note markdown body, keeping important facts and wikilinks" },
            tags: { type: "ARRAY", items: { type: "STRING" }, description: "Relevant tag names (no hashes)" }
          },
          required: ["title", "content", "tags"]
        }
      }
    });
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.candidates || !data.candidates[0]) {
            throw new Error(data.error ? data.error.message : 'No content generated');
          }
          const text = data.candidates[0].content.parts[0].text;
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error(`Failed to parse Gemini response: ${e.message}. Response: ${body}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method.toUpperCase();
  const p      = url.pathname.replace(/\/$/, '') || '/';

  if (method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }

  const STATIC_UI_ASSETS = ['/d3.min.js', '/marked.min.js', '/preact.min.js', '/htm.min.js'];
  const isStaticUi = p === '/' || p === '/ui' || p.startsWith('/ui/') || STATIC_UI_ASSETS.includes(p);
  const isExempt = p === '/health' || p === '/stream' || isStaticUi;

  if (!isExempt) {
    if (!authenticate(req, res)) return;
  }

  // ── Static Visualizer UI serving ─────────────────────────────────────────
  if (method === 'GET' && isStaticUi) {
    let filePath = '';
    if (p === '/' || p === '/ui') {
      filePath = path.join(__dirname, '..', 'ui', 'index.html');
    } else if (STATIC_UI_ASSETS.includes(p)) {
      filePath = path.join(__dirname, '..', 'ui', p.slice(1));
    } else {
      const rel = p.replace(/^\/ui\//, '');
      filePath = path.join(__dirname, '..', 'ui', rel);
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      let contentType = 'text/html';
      if (ext === '.js') contentType = 'application/javascript';
      else if (ext === '.css') contentType = 'text/css';
      else if (ext === '.json') contentType = 'application/json';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // ── Stream (SSE) ───────────────────────────────────────────────────────
  if (method === 'GET' && p === '/stream') {
    // Authenticate SSE connections via query token parameter if AUTH_KEY is configured
    if (AUTH_KEY) {
      const token = url.searchParams.get('token') || '';
      if (token !== AUTH_KEY) {
        res.writeHead(401, CORS);
        res.end(JSON.stringify({ error: 'Unauthorized: Invalid token in query string' }));
        return;
      }
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    res.write(`event: ping\ndata: ${JSON.stringify({ connected: true })}\n\n`);
    sseClients.push(res);
    req.on('close', () => {
      sseClients = sseClients.filter(c => c !== res);
    });
    return;
  }

  // ── Health ─────────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/health') {
    const edges = buildEdges(nodes);
    return json(res, {
      status:       'ok',
      service:      '🧠 Second Brain API',
      version:      '1.0.0',
      port:         PORT,
      vault:        './vault', // Relative path to hide absolute local filesystem directories
      nodeCount:    Object.keys(nodes).length,
      edgeCount:    edges.length,
      lastReload,
      authEnabled:  !!AUTH_KEY,
      sseStreams:   sseClients.length,
      gitSyncEnabled: AUTO_SYNC,
      endpoints: [
        'GET  /health',
        'GET  /nodes',
        'GET  /node/:id',
        'GET  /search?q=...&limit=10',
        'GET  /recall?q=...&hops=1&maxTokens=2000',
        'GET  /graph',
        'GET  /type/:type',
        'GET  /tags',
        'GET  /tag/:tag',
        'GET  /agent/:name',
        'POST /remember',
        'PATCH /node/:id',
        'DELETE /node/:id',
        'POST /tasks/submit',
        'GET  /tasks',
        'PATCH /tasks/:id',
        'POST /messages/send',
        'GET  /messages/:agent',
        'GET  /org-chart',
        'POST /dedup/scan',
        'POST /sandbox/execute',
        'POST /embeddings/reindex',
        'GET  /export',
        'POST /reload',
      ],
    });
  }

  // ── Reload ─────────────────────────────────────────────────────────────
  if (method === 'POST' && p === '/reload') {
    reload();
    return json(res, { success: true, nodeCount: Object.keys(nodes).length, lastReload });
  }

  // ── Consolidate (POST) ──────────────────────────────────────────────────
  if (method === 'POST' && p === '/consolidate') {
    const body = await readBody(req);
    const geminiKey = process.env.GEMINI_API_KEY || body.geminiApiKey || '';
    if (!geminiKey) {
      return json(res, { error: 'Missing Gemini API Key. Provide GEMINI_API_KEY env variable or pass geminiApiKey in body.' }, 400);
    }

    // Filter nodes of type: 'memory' (optionally filter by agent)
    const agent = body.agent || null;
    let targetNodes = Object.values(nodes).filter(n => n.type === 'memory');
    if (agent) {
      targetNodes = targetNodes.filter(n => n.agent === agent);
    }

    if (targetNodes.length < 2) {
      return json(res, { error: 'Insufficient memory nodes to consolidate. Need at least 2 nodes.', count: targetNodes.length }, 400);
    }

    // Assemble text content
    const memoryText = targetNodes.map(n => `---
Title: ${n.title}
Agent: ${n.agent}
Created: ${n.createdAt}
Tags: ${n.tags.join(', ')}
Importance: ${n.importance}
Content:
${n.content}
`).join('\n\n');

    const prompt = `You are the Second Brain REM Sleep Consolidator.
Review the following raw agent memories and consolidate them into a single, high-density structured note.
Remove duplicate logs, retain key numbers, facts, learned schemas, decision logic, and learnings.
Format the output as clean markdown, maintaining or expanding internal wikilinks [[Page Name]] where appropriate.
Write a clear title and list of tags.

Raw memories to consolidate:
${memoryText}`;

    try {
      const result = await callGemini(geminiKey, prompt);

      // Write the new consolidated node
      const newNode = {
        title: result.title,
        content: result.content,
        type: body.type || 'research',
        tags: [...new Set([...(result.tags || []), 'consolidated'])],
        agent: agent || 'system',
        importance: 7
      };

      const newId = writeNode(newNode, agent ? `agents/${agent}` : 'research');

      // Move consolidated files to vault/archive/ folder and update their type to 'archive'
      const archiveDir = path.join(VAULT_DIR, 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

      const changedPaths = [];
      for (const oldNode of targetNodes) {
        updateNodeFile(oldNode.filePath, {
          meta: { type: 'archive' }
        });

        const newPath = path.join(archiveDir, path.basename(oldNode.filePath));
        changedPaths.push(toVaultRelativePath(oldNode.filePath), toVaultRelativePath(newPath));
        fs.renameSync(oldNode.filePath, newPath);

        // Broadcast delete/archive event to client
        broadcast('delete', {
          id: oldNode.id,
          title: oldNode.title,
          timestamp: new Date().toISOString()
        });
      }

      reload();

      // Broadcast remember event for the new consolidated thought
      broadcast('remember', {
        id: newId,
        node: nodes[newId],
        timestamp: new Date().toISOString()
      });

      if (nodes[newId]) changedPaths.push(toVaultRelativePath(nodes[newId].filePath));
      gitSync(`consolidated ${targetNodes.length} memories into "${newNode.title}"`, changedPaths);

      return json(res, {
        success: true,
        consolidatedCount: targetNodes.length,
        newNode: nodes[newId],
        id: newId
      }, 201);
    } catch (err) {
      console.error('[brain] Consolidation error:', err.message);
      return json(res, { error: `Consolidation failed: ${err.message}` }, 500);
    }
  }

  // ── Nodes index ────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/nodes') {
    const list = Object.values(nodes).map(n => ({
      id: n.id, title: n.title, type: n.type, tags: n.tags,
      agent: n.agent, createdAt: n.createdAt,
      preview: n.content.replace(/[#*\[\]`>_]/g, '').slice(0, 120).trim(),
    }));
    return json(res, { count: list.length, nodes: list });
  }

  // ── Single node ────────────────────────────────────────────────────────
  const nodeGet = p.match(/^\/node\/(.+)$/);
  if (method === 'GET' && nodeGet) {
    const id   = decodeURIComponent(nodeGet[1]);
    const node = nodes[id];
    if (!node) return json(res, { error: 'Node not found', id }, 404);
    const bl   = buildBacklinks(nodes);
    return json(res, {
      ...node,
      outLinks: parseWikiLinks(node.content)
        .map(t => Object.values(nodes).find(n => n.title.toLowerCase() === t.toLowerCase()))
        .filter(Boolean).map(n => ({ id: n.id, title: n.title, type: n.type })),
      inLinks: (bl[id] || []).map(sid => nodes[sid])
        .filter(Boolean).map(n => ({ id: n.id, title: n.title, type: n.type })),
      tokenEstimate: Math.ceil(node.content.length / 4),
    });
  }

  // ── Search ─────────────────────────────────────────────────────────────
  // Hybrid keyword + semantic search: searchNodesWithSemantics() fuses the
  // existing TF-IDF keyword arm with a semantic-similarity arm (when an
  // embedding provider is configured and something has been embedded) via
  // Reciprocal Rank Fusion. With no embeddings configured, it returns
  // exactly what searchNodes() alone would — same results, same order.
  if (method === 'GET' && p === '/search') {
    const q     = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '10', 10);
    if (!q) return json(res, { error: 'Missing ?q= query' }, 400);
    const results = await searchNodesWithSemantics(nodes, q, limit, resolveKeys());
    return json(res, { query: q, results });
  }

  // ── Recall (THE KEY AGENT ENDPOINT) ───────────────────────────────────
  // Returns minimal, relevant context within a token budget.
  // Agents call this instead of reading source files.
  if (method === 'GET' && p === '/recall') {
    const q         = url.searchParams.get('q') || '';
    const hops      = Math.min(parseInt(url.searchParams.get('hops')      || '1',    10), 3);
    const maxTokens = Math.min(parseInt(url.searchParams.get('maxTokens') || '2000', 10), 8000);
    const agentName = url.searchParams.get('agent') || 'unknown';
    if (!q) return json(res, { error: 'Missing ?q= query' }, 400);

    const context = await buildContext(nodes, q, hops, maxTokens, resolveKeys());

    // Update lastAccessedAt for nodes retrieved in context
    const today = new Date().toISOString().split('T')[0];
    for (const node of context.nodes) {
      updateNodeFile(node.filePath, {
        meta: { lastAccessedAt: today }
      });
      if (nodes[node.id]) {
        nodes[node.id].lastAccessedAt = today;
      }
    }

    broadcast('recall', {
      query: q,
      agent: agentName,
      nodes: context.nodes.map(n => ({ id: n.id, title: n.title, type: n.type, hop: n.hop })),
      timestamp: new Date().toISOString()
    });

    return json(res, context);
  }

  // ── Graph ─────────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/graph') {
    const edges = buildEdges(nodes);
    return json(res, {
      nodeCount: Object.keys(nodes).length,
      edgeCount: edges.length,
      nodes: Object.values(nodes).map(n => ({
        id: n.id, title: n.title, type: n.type, tags: n.tags, agent: n.agent,
      })),
      edges,
    });
  }

  // ── By Type ────────────────────────────────────────────────────────────
  const typeMatch = p.match(/^\/type\/(.+)$/);
  if (method === 'GET' && typeMatch) {
    const type  = decodeURIComponent(typeMatch[1]);
    const found = Object.values(nodes).filter(n => n.type === type);
    return json(res, {
      type, count: found.length,
      nodes: found.map(n => ({
        id: n.id, title: n.title, tags: n.tags, agent: n.agent,
        preview: n.content.slice(0, 120).trim(),
      })),
    });
  }

  // ── Tags ──────────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/tags') {
    const map = {};
    for (const n of Object.values(nodes))
      for (const t of n.tags) map[t] = (map[t] || 0) + 1;
    return json(res, {
      count: Object.keys(map).length,
      tags:  Object.entries(map).sort((a, b) => b[1] - a[1])
               .map(([tag, count]) => ({ tag, count })),
    });
  }

  // ── By Tag ────────────────────────────────────────────────────────────
  const tagMatch = p.match(/^\/tag\/(.+)$/);
  if (method === 'GET' && tagMatch) {
    const tag   = decodeURIComponent(tagMatch[1]).toLowerCase();
    const found = Object.values(nodes).filter(n => n.tags.includes(tag));
    return json(res, {
      tag, count: found.length,
      // `tags` included (not just id/type/agent) so a caller like
      // sdk/messenger.js's inbox()/sent() — which filters byTag() results
      // by tag membership (e.g. 'unread') — has something to filter on.
      nodes: found.map(n => ({ id: n.id, title: n.title, type: n.type, tags: n.tags, agent: n.agent, content: n.content })),
    });
  }

  // ── By Agent ──────────────────────────────────────────────────────────
  const agentMatch = p.match(/^\/agent\/(.+)$/);
  if (method === 'GET' && agentMatch) {
    const agentName = decodeURIComponent(agentMatch[1]);
    const found     = Object.values(nodes).filter(n => n.agent === agentName);
    return json(res, {
      agent: agentName, count: found.length,
      nodes: found.map(n => ({
        id: n.id, title: n.title, type: n.type, tags: n.tags, createdAt: n.createdAt,
        preview: n.content.slice(0, 120).trim(),
      })),
    });
  }

  // ── Remember (POST) ────────────────────────────────────────────────────
  if (method === 'POST' && p === '/remember') {
    const body = await readBody(req);

    // Schema Validation
    const validation = validateNode(body, false);
    if (!validation.valid) {
      return json(res, { error: 'Validation Error', details: validation.errors }, 400);
    }

    const node = {
      title:     body.title,
      content:   body.content,
      type:      body.type      || 'memory',
      tags:      body.tags      || parseTags(body.content),
      agent:     body.agent     || 'unknown',
      importance: body.importance || 5,
      createdAt: body.createdAt || new Date().toISOString().split('T')[0],
    };

    const subdir = body.subdir || (body.agent ? `agents/${body.agent}` : '');
    const id     = writeNode(node, subdir);
    reload();

    console.log(`[brain] 📝 New memory: "${node.title}" (${node.agent})`);
    
    broadcast('remember', {
      id,
      node: nodes[id] || node,
      timestamp: new Date().toISOString()
    });

    gitSync(`remember memory: "${node.title}" by ${node.agent}`, nodes[id] ? [toVaultRelativePath(nodes[id].filePath)] : []);
    return json(res, { success: true, id, node: nodes[id] || node }, 201);
  }

  // ── Update (PATCH) ────────────────────────────────────────────────────
  const patchMatch = p.match(/^\/node\/(.+)$/);
  if (method === 'PATCH' && patchMatch) {
    const id   = decodeURIComponent(patchMatch[1]);
    const node = nodes[id];
    if (!node) return json(res, { error: 'Node not found', id }, 404);

    const body = await readBody(req);

    // Optimistic Concurrency Control (OCC) Check
    if (body.version !== undefined) {
      const clientVersion = parseInt(body.version, 10);
      const serverVersion = parseInt(node.version, 10) || 1;
      if (clientVersion !== serverVersion) {
        return json(res, { 
          error: 'Conflict: Node has been modified by another process. Please reload and retry.',
          clientVersion,
          serverVersion
        }, 409);
      }
    }

    // Schema Validation
    const validation = validateNode(body, true);
    if (!validation.valid) {
      return json(res, { error: 'Validation Error', details: validation.errors }, 400);
    }

    const filePathBeforeUpdate = node.filePath;
    const ok   = updateNodeFile(node.filePath, {
      title:   body.title   || node.title,
      content: body.content !== undefined ? body.content : node.content,
      meta:    {
        type: body.type || node.type,
        tags: body.tags || node.tags,
        importance: body.importance || node.importance,
        lastAccessedAt: new Date().toISOString().split('T')[0]
      },
    });
    if (ok) {
      reload();

      broadcast('update', {
        id,
        node: nodes[id],
        timestamp: new Date().toISOString()
      });

      gitSync(`update memory: "${body.title || node.title}"`, [toVaultRelativePath(filePathBeforeUpdate)]);
    }
    return json(res, { success: ok, id });
  }

  // ── Delete ────────────────────────────────────────────────────────────
  const deleteMatch = p.match(/^\/node\/(.+)$/);
  if (method === 'DELETE' && deleteMatch) {
    const id   = decodeURIComponent(deleteMatch[1]);
    const node = nodes[id];
    if (!node) return json(res, { error: 'Node not found', id }, 404);
    const deletedPath = toVaultRelativePath(node.filePath);
    deleteNodeFile(node.filePath);
    reload();
    console.log(`[brain] 🗑️ Deleted: "${node.title}"`);

    broadcast('delete', {
      id,
      title: node.title,
      timestamp: new Date().toISOString()
    });

    gitSync(`forget memory: "${node.title}"`, [deletedPath]);
    return json(res, { success: true });
  }

  // ── Tasks: submit (POST) ────────────────────────────────────────────────
  if (method === 'POST' && p === '/tasks/submit') {
    const body = await readBody(req);
    if (!body.prompt) return json(res, { error: 'Missing required field: prompt' }, 400);
    const result = await makeTaskQueue().submit(body.prompt, body.agents || [], {
      title: body.title,
      priority: body.priority,
      tags: body.tags,
      dependencies: body.dependencies,
    });
    reload();
    gitSync(`task submitted: "${body.title || body.prompt.slice(0, 60)}"`,
      result.nodeId && nodes[result.nodeId] ? [toVaultRelativePath(nodes[result.nodeId].filePath)] : []);
    return json(res, { success: true, ...result }, 201);
  }

  // ── Tasks: status update (PATCH) ─────────────────────────────────────────
  const taskPatchMatch = p.match(/^\/tasks\/(.+)$/);
  if (method === 'PATCH' && taskPatchMatch) {
    const id = decodeURIComponent(taskPatchMatch[1]);
    const body = await readBody(req);
    if (!body.status) return json(res, { error: 'Missing required field: status' }, 400);
    try {
      const tq = makeTaskQueue();
      await tq.setStatus(id, body.status, body.content !== undefined ? { content: body.content } : {});
      reload();
      // A completed/failed/cancelled task may unblock others waiting on it.
      let released = 0;
      if (['completed', 'failed', 'cancelled'].includes(body.status)) {
        released = await tq.releaseDependents(id);
        if (released) reload();
      }
      gitSync(`task status -> ${body.status}: ${id}`, nodes[id] ? [toVaultRelativePath(nodes[id].filePath)] : []);
      return json(res, { success: true, id, status: body.status, releasedDependents: released });
    } catch (err) {
      return json(res, { error: err.message }, 400);
    }
  }

  // ── Tasks: list (GET) ────────────────────────────────────────────────────
  if (method === 'GET' && p === '/tasks') {
    const status = url.searchParams.get('status');
    const found = Object.values(nodes).filter(n => n.type === 'task' && (!status || n.tags.includes(status)));
    return json(res, {
      count: found.length,
      tasks: found.map(n => ({
        id: n.id, title: n.title, tags: n.tags, content: n.content, createdAt: n.createdAt,
      })),
    });
  }

  // ── Messages: send (POST) ────────────────────────────────────────────────
  if (method === 'POST' && p === '/messages/send') {
    const body = await readBody(req);
    if (!body.toAgent || !body.content) {
      return json(res, { error: 'Missing required fields: toAgent, content' }, 400);
    }
    const result = await makeMessenger().send(body.fromAgent || 'unknown', body.toAgent, body.content, {
      subject: body.subject,
      taskId:  body.taskId,
    });
    reload();
    gitSync(`message: ${body.fromAgent || 'unknown'} -> ${body.toAgent}`,
      result?.id && nodes[result.id] ? [toVaultRelativePath(nodes[result.id].filePath)] : []);
    return json(res, { success: true, id: result?.id }, 201);
  }

  // ── Messages: inbox (GET) ─────────────────────────────────────────────────
  const messagesGetMatch = p.match(/^\/messages\/(.+)$/);
  if (method === 'GET' && messagesGetMatch) {
    const agentName  = decodeURIComponent(messagesGetMatch[1]);
    const unreadOnly = url.searchParams.get('unread') !== 'false';
    const messages   = await makeMessenger().inbox(agentName, unreadOnly);
    return json(res, { agent: agentName, count: messages.length, messages });
  }

  // ── Org chart (GET) ───────────────────────────────────────────────────────
  // Derived read-only from agent-persona nodes already in the vault (tags
  // and/or explicit department/reportsTo frontmatter) — see sdk/org_chart.js.
  if (method === 'GET' && p === '/org-chart') {
    const agentEntries = Object.values(nodes).filter(n => n.type === 'agent');
    return json(res, buildOrgChart(agentEntries));
  }

  // ── Dedup: scan for near-duplicate nodes (POST) ───────────────────────────
  // Reporting only by default (dryRun=true) — never auto-merges. Pass
  // { dryRun: false } to acknowledge the report was reviewed; this endpoint
  // still never writes to the vault itself either way, it only judges and
  // reports candidates for a human (or a follow-up call) to act on.
  if (method === 'POST' && p === '/dedup/scan') {
    const body = await readBody(req);
    const dryRun = body.dryRun !== false;
    const keys = resolveKeys(body);
    const candidates = await scanForDuplicates(nodes, {
      embeddingKeys: keys,
      llmKeys: keys,
      judge: body.judge !== false,
      threshold: body.threshold,
      logFn: (m) => console.log(`[dedup] ${m}`),
    });
    return json(res, { dryRun, candidateCount: candidates.length, candidates });
  }

  // ── Sandbox: execute code (POST) ──────────────────────────────────────────
  if (method === 'POST' && p === '/sandbox/execute') {
    const body = await readBody(req);
    if (!body.code || !body.language) {
      return json(res, { error: 'Missing required fields: code, language' }, 400);
    }
    if (!['python', 'javascript'].includes(body.language)) {
      return json(res, { error: 'language must be "python" or "javascript"' }, 400);
    }
    const result = await executeCode(body.code, body.language, body.timeoutMs || 5000);
    return json(res, result);
  }

  // ── Embeddings: force reindex (POST) ──────────────────────────────────────
  // Runs in the background so it doesn't block the response — a full-vault
  // reindex can take a while. No-op-ish (fast, all-cache-hit) on repeat runs
  // since updateNodeEmbedding() skips any node whose content hash is
  // unchanged. Requires an embedding provider key (OPENAI_API_KEY /
  // GEMINI_API_KEY, or the optional local model) to do anything.
  if (method === 'POST' && p === '/embeddings/reindex') {
    const body = await readBody(req);
    const keys = resolveKeys(body);
    (async () => {
      const allNodes = Object.values(nodes).filter(n => n.type !== 'archive');
      console.log(`[embeddings] Starting batch semantic reindexing for ${allNodes.length} nodes...`);
      const { batchUpdateNodeEmbeddings } = await import('../sdk/embeddings.js');
      const { processed, failed } = await batchUpdateNodeEmbeddings(allNodes, keys);
      console.log(`[embeddings] Batch reindexing finished. Processed: ${processed}, Failed: ${failed}.`);
    })().catch(e => console.error('[embeddings] Reindexing error:', e.message));
    return json(res, { success: true, message: 'Batch reindexing started in the background.' }, 202);
  }

  // ── Export ────────────────────────────────────────────────────────────
  if (method === 'GET' && p === '/export') {
    return json(res, {
      version:    '1.0',
      exportedAt: new Date().toISOString(),
      nodeCount:  Object.keys(nodes).length,
      nodes:      Object.values(nodes),
      edges:      buildEdges(nodes),
    });
  }

  return json(res, { error: 'Not found', path: p }, 404);
});

// ── Boot ─────────────────────────────────────────────────────────────────────
reload();

server.listen(PORT, () => {
  console.log('\n' + '═'.repeat(58));
  console.log('  🧠  SECOND BRAIN API');
  console.log(`  📡  http://localhost:${PORT}`);
  console.log(`  💾  Vault: ${VAULT_DIR}`);
  console.log(`  📝  ${Object.keys(nodes).length} nodes loaded`);
  console.log('═'.repeat(58));
  console.log('\n  AGENT QUICK START:');
  console.log(`  GET /recall?q=your+topic&hops=1    ← low-token context`);
  console.log(`  POST /remember  { title, content, type, agent }`);
  console.log('\n  Token savings vs reading source files: 95-99%\n');
});
