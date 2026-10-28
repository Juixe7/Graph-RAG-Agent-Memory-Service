import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

// embeddings.js resolves its cache path from BRAIN_VAULT at import time, so
// point it at a scratch directory before the (dynamic) import runs.
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-embeddings-test-'));
process.env.BRAIN_VAULT = tmpVault;
const oldDb = new DatabaseSync(path.join(tmpVault, '.embeddings.db'));
oldDb.exec(`CREATE TABLE embeddings (
  node_id TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  vector BLOB NOT NULL,
  updated_at TEXT NOT NULL
)`);
oldDb.prepare('INSERT INTO embeddings (node_id, hash, vector, updated_at) VALUES (?, ?, ?, ?)')
  .run('legacy', 'old-hash', Buffer.from(Float32Array.from([1, 0, 0]).buffer), '2026-01-01T00:00:00.000Z');
oldDb.close();
const { updateNodeEmbedding, batchUpdateNodeEmbeddings, getEmbeddingsCache, getEmbedding, meanPoolAndNormalize } = await import('../sdk/embeddings.js');

test('migrates old embedding caches and marks model provenance unknown', () => {
  const cache = getEmbeddingsCache();
  assert.equal(cache.legacy.model, '');
  assert.deepEqual(cache.legacy.vector, [1, 0, 0]);
});

function fakeVectorResponse(seed) {
  return { data: [{ embedding: [seed, seed + 1, seed + 2] }] };
}

test('batchUpdateNodeEmbeddings stores every vector correctly, one embedding request per node', async (t) => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { json: async () => fakeVectorResponse(fetchCalls) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const nodeList = [
    { id: 'a', title: 'A', content: 'first note' },
    { id: 'b', title: 'B', content: 'second note' },
    { id: 'c', title: 'C', content: 'third note' },
  ];
  const { processed, failed } = await batchUpdateNodeEmbeddings(nodeList, { openaiKey: 'test-key' });

  assert.equal(processed, 3);
  assert.equal(failed, 0);
  assert.equal(fetchCalls, 3, 'one embedding request per node');

  const cache = getEmbeddingsCache();
  assert.ok(cache.a && cache.b && cache.c);
  assert.match(cache.a.model, /^openai:/);
  assert.deepEqual(cache.a.vector, [1, 2, 3]);
  assert.deepEqual(cache.b.vector, [2, 3, 4]);
  assert.deepEqual(cache.c.vector, [3, 4, 5]);
});

test('batchUpdateNodeEmbeddings skips re-fetching any node whose content is unchanged on a second pass', async (t) => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { json: async () => fakeVectorResponse(fetchCalls) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const nodeList = [
    { id: 'unchanged-a', title: 'A', content: 'stable content' },
    { id: 'unchanged-b', title: 'B', content: 'other stable content' },
  ];
  await batchUpdateNodeEmbeddings(nodeList, { openaiKey: 'test-key' });
  assert.equal(fetchCalls, 2);

  const { processed, failed } = await batchUpdateNodeEmbeddings(nodeList, { openaiKey: 'test-key' });
  assert.equal(processed, 2);
  assert.equal(failed, 0);
  assert.equal(fetchCalls, 2, 'no new fetches on the second pass — every hash still matches');
});

test('updateNodeEmbedding skips the API call when content is unchanged (hash match)', async (t) => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { json: async () => fakeVectorResponse(fetchCalls) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const keys = { openaiKey: 'test-key' };
  const v1 = await updateNodeEmbedding('node-1', 'Title', 'same content', keys);
  const v2 = await updateNodeEmbedding('node-1', 'Title', 'same content', keys);

  assert.deepEqual(v1, v2);
  assert.equal(fetchCalls, 1, 'second call reuses the cached vector instead of calling the API again');
});

test('updateNodeEmbedding refreshes a vector when the embedding model changes', async (t) => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return { json: async () => ({ embedding: { values: [0.1, 0.2, 0.3] } }) };
    }
    return { json: async () => fakeVectorResponse(1) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await updateNodeEmbedding('model-switch', 'Title', 'stable content', { openaiKey: 'openai-test' });
  const geminiVector = await updateNodeEmbedding('model-switch', 'Title', 'stable content', { geminiKey: 'gemini-test' });

  assert.deepEqual(geminiVector, [0.1, 0.2, 0.3]);
  assert.equal(getEmbeddingsCache()['model-switch'].model, 'gemini:gemini-embedding-001');
  assert.equal(calls, 2, 'the second provider must produce a fresh model-compatible vector');
});

// ── Local embedding fallback (@huggingface/transformers is optional) ────────

test('meanPoolAndNormalize mean-pools masked tokens and L2-normalizes the result', () => {
  const tokens = [[1, 0], [0, 1], [100, 100]]; // third token is masked out — must not affect the result
  const mask = [1, 1, 0];
  const result = meanPoolAndNormalize(tokens, mask);

  // Mean of the first two (unmasked) tokens is [0.5, 0.5]; normalized to unit length.
  const expectedMag = Math.sqrt(0.5 ** 2 + 0.5 ** 2);
  assert.ok(Math.abs(result[0] - 0.5 / expectedMag) < 1e-9);
  assert.ok(Math.abs(result[1] - 0.5 / expectedMag) < 1e-9);
  const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, 'output must be unit-length');
});

test('meanPoolAndNormalize treats a missing attention mask as "attend to everything"', () => {
  const tokens = [[1, 0], [0, 1]];
  const result = meanPoolAndNormalize(tokens, null);
  const norm = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test('getEmbedding falls through to the (currently uninstalled) local model, then reports a clear error', async (t) => {
  // @huggingface/transformers is intentionally NOT a project dependency —
  // this exercises the real, unmocked "package not installed" path, proving
  // getEmbedding() doesn't hang or throw something opaque when the optional
  // local model is absent. fetch is mocked to fail fast so this doesn't
  // depend on whether an ambient OPENAI_API_KEY/GEMINI_API_KEY happens to
  // be set in the environment running the test.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled for this test'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  await assert.rejects(
    () => getEmbedding('some text', { openaiKey: 'unused', geminiKey: 'unused' }),
    (err) => {
      assert.match(err.message, /local: Cannot find package '@huggingface\/transformers'/);
      return true;
    }
  );
});

test('getEmbedding leads with a clear hint when no cloud key is configured at all', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled for this test'); };
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedGemini = process.env.GEMINI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
  });

  await assert.rejects(
    () => getEmbedding('some text', {}),
    (err) => {
      assert.match(err.message, /^No OpenAI\/Gemini API key configured/);
      return true;
    }
  );
});
