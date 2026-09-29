import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// dedup.js pulls in embeddings.js, which resolves its cache path from
// BRAIN_VAULT at import time — point it at a scratch directory before the
// (dynamic) import runs, same pattern as embeddings.test.js.
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-dedup-test-'));
process.env.BRAIN_VAULT = tmpVault;

const { findMostSimilarNode, judgeDuplicate, DEDUP_SIMILARITY_THRESHOLD } = await import('../sdk/dedup.js');
const { saveEmbeddingsCache } = await import('../sdk/embeddings.js');

function fakeEmbeddingResponse(vector) {
  return { data: [{ embedding: vector }] };
}

// ── findMostSimilarNode ───────────────────────────────────────────────────

test('findMostSimilarNode returns the closest existing node above the threshold', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => fakeEmbeddingResponse([1, 0, 0]) });
  t.after(() => { globalThis.fetch = originalFetch; });

  saveEmbeddingsCache({
    existingClose: { hash: 'h1', vector: [0.999, 0.001, 0], updatedAt: '' },
    existingFar:   { hash: 'h2', vector: [0, 1, 0], updatedAt: '' },
  });

  const nodes = {
    existingClose: { id: 'existingClose', type: 'memory', agent: 'research-agent', title: 'Close', content: 'x' },
    existingFar:   { id: 'existingFar',   type: 'memory', agent: 'research-agent', title: 'Far',   content: 'y' },
  };
  const candidate = { id: 'newNode', type: 'memory', agent: 'research-agent', title: 'New', content: 'z' };

  const match = await findMostSimilarNode(nodes, candidate, { openaiKey: 'test-key' });
  assert.ok(match, 'a match above threshold should be found');
  assert.equal(match.node.id, 'existingClose');
  assert.ok(match.similarity >= DEDUP_SIMILARITY_THRESHOLD);
});

test('findMostSimilarNode ignores nodes of a different type or agent', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => fakeEmbeddingResponse([1, 0, 0]) });
  t.after(() => { globalThis.fetch = originalFetch; });

  saveEmbeddingsCache({
    wrongType:  { hash: 'h1', vector: [1, 0, 0], updatedAt: '' },
    wrongAgent: { hash: 'h2', vector: [1, 0, 0], updatedAt: '' },
  });

  const nodes = {
    wrongType:  { id: 'wrongType',  type: 'task',   agent: 'research-agent', title: 'T',  content: 'x' },
    wrongAgent: { id: 'wrongAgent', type: 'memory', agent: 'pipeline-agent', title: 'T2', content: 'y' },
  };
  const candidate = { id: 'newNode', type: 'memory', agent: 'research-agent', title: 'New', content: 'z' };

  const match = await findMostSimilarNode(nodes, candidate, { openaiKey: 'test-key' });
  assert.equal(match, null);
});

test('findMostSimilarNode returns null below the similarity threshold', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => fakeEmbeddingResponse([1, 0, 0]) });
  t.after(() => { globalThis.fetch = originalFetch; });

  saveEmbeddingsCache({
    unrelated: { hash: 'h1', vector: [0, 1, 0], updatedAt: '' },
  });

  const nodes = {
    unrelated: { id: 'unrelated', type: 'memory', agent: 'research-agent', title: 'Unrelated', content: 'x' },
  };
  const candidate = { id: 'newNode', type: 'memory', agent: 'research-agent', title: 'New', content: 'z' };

  const match = await findMostSimilarNode(nodes, candidate, { openaiKey: 'test-key' });
  assert.equal(match, null);
});

// ── judgeDuplicate ────────────────────────────────────────────────────────

test('judgeDuplicate returns the LLM merge verdict when the judge approves a merge', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    json: async () => ({ content: [{ text: JSON.stringify({ action: 'merge', title: 'Merged', content: 'Merged content', tags: ['a'] }) }] }),
  });
  t.after(() => { globalThis.fetch = originalFetch; });

  const verdict = await judgeDuplicate(
    { title: 'New', content: 'New content' },
    { title: 'Existing', content: 'Existing content' },
    { anthropicKey: 'test-key' },
  );
  assert.equal(verdict.action, 'merge');
  assert.equal(verdict.title, 'Merged');
});

test('judgeDuplicate fails open (keeps both) when the LLM call errors', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const verdict = await judgeDuplicate(
    { title: 'New', content: 'New content' },
    { title: 'Existing', content: 'Existing content' },
    { anthropicKey: 'test-key' },
  );
  assert.equal(verdict.action, 'keep');
});
