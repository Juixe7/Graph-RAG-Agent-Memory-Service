import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function getFreePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const { port } = socket.address();
  await new Promise(resolve => socket.close(resolve));
  return port;
}

async function startApi(t, extraEnv = {}) {
  const port = await getFreePort();
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'second-brain-api-'));
  const child = spawn(process.execPath, ['api/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      BRAIN_HOST: '127.0.0.1',
      BRAIN_PORT: String(port),
      BRAIN_KEY: 'test-api-key',
      BRAIN_VAULT: vault,
      AUTO_GIT_SYNC: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) {
    child.kill();
    await fs.rm(vault, { recursive: true, force: true });
    throw new Error(`API failed to start. Output:\n${output}`);
  }

  t.after(async () => {
    child.kill();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 2000).unref();
    });
    await fs.rm(vault, { recursive: true, force: true });
  });
  return { baseUrl, apiKey: 'test-api-key' };
}

test('API protects vault routes when BRAIN_KEY is configured', async t => {
  const { baseUrl, apiKey } = await startApi(t);
  const anonymous = await fetch(`${baseUrl}/nodes`);
  assert.equal(anonymous.status, 401);

  const authenticated = await fetch(`${baseUrl}/nodes`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(authenticated.status, 200);
});

test('API rejects malformed and oversized JSON request bodies', async t => {
  const { baseUrl, apiKey } = await startApi(t);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const malformed = await fetch(`${baseUrl}/remember`, {
    method: 'POST', headers, body: '{bad json',
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /valid JSON/);

  const oversized = await fetch(`${baseUrl}/remember`, {
    method: 'POST', headers, body: JSON.stringify({ content: 'x'.repeat(1024 * 1024 + 1) }),
  });
  assert.equal(oversized.status, 413);
});

test('API writes Markdown memories and retrieves linked graph context', async t => {
  const { baseUrl, apiKey } = await startApi(t);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const first = await fetch(`${baseUrl}/remember`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'Token Bucket Design',
      content: 'A token bucket handles burst traffic.',
      type: 'memory',
      agent: 'test-agent',
      tags: ['rate-limits'],
    }),
  });
  assert.equal(first.status, 201);

  const second = await fetch(`${baseUrl}/remember`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      title: 'API Rate Limit Notes',
      content: 'For burst traffic, see [[Token Bucket Design]].',
      type: 'memory',
      agent: 'test-agent',
      tags: ['rate-limits'],
    }),
  });
  assert.equal(second.status, 201);

  const graphResponse = await fetch(`${baseUrl}/graph`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const graph = await graphResponse.json();
  assert.equal(graph.nodeCount, 2);
  assert.equal(graph.edgeCount, 1);
  assert.equal(graph.edges[0].targetTitle, 'Token Bucket Design');

  const searchResponse = await fetch(`${baseUrl}/search?q=token%20bucket`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const search = await searchResponse.json();
  assert.ok(search.results.some(result => result.title === 'Token Bucket Design'));
});

test('recall keeps its estimated context within budget and can follow a skipped oversized seed', async t => {
  const { baseUrl, apiKey } = await startApi(t);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const memories = [
    {
      title: 'Oversized Retrieval Seed',
      content: `${'rarequerytoken '.repeat(500)} [[Compact Linked Note]]`,
    },
    {
      title: 'Compact Linked Note',
      content: 'A concise rule for burst traffic.',
    },
  ];
  for (const memory of memories) {
    const response = await fetch(`${baseUrl}/remember`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...memory, type: 'memory', agent: 'test-agent' }),
    });
    assert.equal(response.status, 201);
  }

  const response = await fetch(`${baseUrl}/recall?q=rarequerytoken&hops=1&maxTokens=100`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const context = await response.json();
  assert.ok(context.tokenEstimate <= 100);
  assert.ok(context.nodes.some(node => node.title === 'Compact Linked Note'));
  assert.ok(context.nodes.every(node => node.title !== 'Oversized Retrieval Seed'));
});

test('unsafe code-execution endpoint is no longer exposed', async t => {
  const { baseUrl, apiKey } = await startApi(t);
  const response = await fetch(`${baseUrl}/sandbox/execute`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'process.exit(0)', language: 'javascript' }),
  });
  assert.equal(response.status, 404);
});

test('consolidation uses the LLM router and rejects invalid model output before archiving', async t => {
  let generated = { title: 'Consolidated Notes', content: 'Preserved reference facts.', tags: ['reference'] };
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: { content: JSON.stringify(generated) } }));
    });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const host = `http://127.0.0.1:${provider.address().port}`;
  t.after(() => new Promise(resolve => provider.close(resolve)));

  const { baseUrl, apiKey } = await startApi(t, {
    LLM_PROVIDER_ORDER: 'ollama',
    OLLAMA_HOST: host,
    OLLAMA_MODEL: 'test-model',
  });
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const remember = async (title, agent) => fetch(`${baseUrl}/remember`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title, content: `Notes for ${title}.`, type: 'memory', agent }),
  });

  assert.equal((await remember('First Saved Note', 'valid-agent')).status, 201);
  assert.equal((await remember('Second Saved Note', 'valid-agent')).status, 201);
  const success = await fetch(`${baseUrl}/consolidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent: 'valid-agent', type: 'research' }),
  });
  assert.equal(success.status, 201);
  assert.equal((await success.json()).newNode.title, 'Consolidated Notes');

  assert.equal((await remember('First Invalid Note', 'invalid-agent')).status, 201);
  assert.equal((await remember('Second Invalid Note', 'invalid-agent')).status, 201);
  generated = { title: 'Empty Consolidation', content: '', tags: [] };
  const rejected = await fetch(`${baseUrl}/consolidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent: 'invalid-agent', type: 'research' }),
  });
  assert.equal(rejected.status, 500);

  generated = { title: '', content: 'Missing required title.', tags: [] };
  const rejectedTitle = await fetch(`${baseUrl}/consolidate`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ agent: 'invalid-agent', type: 'research' }),
  });
  assert.equal(rejectedTitle.status, 500);

  const nodesResponse = await fetch(`${baseUrl}/nodes`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const nodes = (await nodesResponse.json()).nodes;
  assert.equal(nodes.filter(node => node.agent === 'invalid-agent' && node.type === 'memory').length, 2);
});
