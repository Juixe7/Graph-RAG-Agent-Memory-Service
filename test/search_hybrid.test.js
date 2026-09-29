import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

// brain_engine.js's searchNodesWithSemantics pulls in embeddings.js, which
// resolves its cache path from BRAIN_VAULT at import time — point it at a
// scratch vault before the (dynamic) imports run, same pattern as
// embeddings.test.js/dedup.test.js.
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'second-brain-hybrid-search-test-'));
process.env.BRAIN_VAULT = tmpVault;

function writeNodeFile(id, { title, content, type = 'memory' }) {
  const filePath = path.join(tmpVault, `${id}.md`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---\ntype: ${type}\ntags: []\nagent: test\ncreatedAt: 2026-06-18\n---\n# ${title}\n\n${content}\n`);
}

writeNodeFile('alpha', { title: 'Rate limiting design', content: 'Notes on token bucket rate limiting for the API gateway.' });
writeNodeFile('beta', { title: 'Unrelated gardening notes', content: 'Tomatoes need full sun and consistent watering.' });

const { loadVault, searchNodes, searchNodesWithSemantics } = await import('../api/brain_engine.js');
const { saveEmbeddingsCache } = await import('../sdk/embeddings.js');

test('searchNodesWithSemantics returns exactly searchNodes()\'s result when nothing has been embedded', async () => {
  const nodes = loadVault();
  const keyword = searchNodes(nodes, 'rate limiting', 10);
  const hybrid = await searchNodesWithSemantics(nodes, 'rate limiting', 10, {});
  assert.deepEqual(hybrid, keyword, 'with an empty embeddings cache, the hybrid path must be identical to keyword-only search');
});

test('searchNodesWithSemantics surfaces a semantically-close node via the embeddings arm even when the query text does not match it directly', async (t) => {
  const nodes = loadVault();

  // Fake a query embedding close to "beta"'s cached vector but far from
  // "alpha"'s — an embedding provider key must be configured (even a fake
  // one; getEmbedding() is mocked below) for the semantic arm to run at all.
  saveEmbeddingsCache({
    alpha: { hash: 'h1', vector: [0, 1, 0], updatedAt: '' },
    beta:  { hash: 'h2', vector: [1, 0, 0], updatedAt: '' },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => ({ data: [{ embedding: [1, 0, 0] }] }) });
  t.after(() => { globalThis.fetch = originalFetch; });

  const results = await searchNodesWithSemantics(nodes, 'some query with no keyword overlap at all', 10, { openaiKey: 'test-key' });
  const ids = results.map(r => r.id);
  assert.ok(ids.includes('beta'), 'the semantically-close node should surface purely from the embeddings arm');
});
