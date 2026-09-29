import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { MODELS } from './models_config.js';

// SQLite-backed semantic embedding store, via node:sqlite (built into Node
// >=22.5, no npm install, no native compile step) — real per-row reads/
// writes and an actual transaction, instead of parsing/rewriting a single
// growing JSON blob on every save. It's still flagged experimental by Node
// itself as of this writing ("SQLite is an experimental feature and might
// change at any time") — a real caveat for the *API surface* this module
// depends on, but not for the *data*: the .db file itself is the standard
// SQLite format, readable by literally any SQLite tool/binding forever
// regardless of what Node does with this module later.
//
// This whole module is an OPTIONAL enhancement: with no OPENAI_API_KEY /
// GEMINI_API_KEY configured (and no local model installed — see below),
// getEmbedding() simply rejects and callers (api/brain_engine.js's semantic
// search arm, sdk/dedup.js) fail open, leaving TF-IDF keyword search and
// exact-dedup-free behavior exactly as they are today. No required runtime
// dependency is added by this file.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = process.env.BRAIN_VAULT ? path.resolve(process.env.BRAIN_VAULT) : path.resolve(__dirname, '..', 'vault');
const DB_FILE = path.join(VAULT_DIR, '.embeddings.db');

let db = null;
function getDb() {
  if (db) return db;
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id    TEXT PRIMARY KEY,
      hash       TEXT NOT NULL,
      vector     BLOB NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return db;
}

// Vectors round-trip as float32 (a Buffer view over a Float32Array), not
// the float64 precision JSON.stringify would give a plain number array —
// half the storage per dimension, and every embedding provider called here
// already returns float32-precision values in practice, so nothing
// meaningful is lost.
function encodeVector(arr) {
  return Buffer.from(Float32Array.from(arr).buffer);
}
function decodeVector(buf) {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

// ── Call Gemini Embedding API ───────────────────────────────────────────────
async function callGeminiEmbedding(apiKey, text) {
  const model = MODELS.gemini.embeddingModel;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: `models/${model}`, content: { parts: [{ text }] } }),
    }
  );
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  const vector = d.embedding?.values;
  if (!vector) throw new Error('No embedding returned from Gemini');
  return vector;
}

// ── Call OpenAI Embedding API ───────────────────────────────────────────────
async function callOpenAIEmbedding(apiKey, text) {
  const apiBase = MODELS.openai.embeddingApiBase;
  const modelName = MODELS.openai.embeddingModel;

  const res = await fetch(`${apiBase}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ input: text, model: modelName }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error.message);
  const vector = d.data?.[0]?.embedding;
  if (!vector) throw new Error('No embedding returned from OpenAI');
  return vector;
}

// ── Local embedding model (optional) ────────────────────────────────────────
// Mean pooling + L2 normalization over a transformer's token embeddings —
// the standard way to turn per-token output into one fixed-size sentence
// vector. Pure math, no I/O, so this is unit-tested directly without
// needing the model installed (see test/embeddings.test.js).
export function meanPoolAndNormalize(tokenEmbeddings, attentionMask) {
  const numTokens = tokenEmbeddings.length;
  const dim = tokenEmbeddings[0]?.length || 0;
  const summed = new Array(dim).fill(0);
  let maskSum = 0;

  for (let t = 0; t < numTokens; t++) {
    const mask = attentionMask ? attentionMask[t] : 1;
    if (!mask) continue;
    maskSum += mask;
    for (let d = 0; d < dim; d++) summed[d] += tokenEmbeddings[t][d] * mask;
  }
  if (maskSum === 0) maskSum = 1; // degenerate all-masked input — avoid dividing by zero

  const pooled = summed.map(v => v / maskSum);
  const norm = Math.sqrt(pooled.reduce((sum, v) => sum + v * v, 0)) || 1;
  return pooled.map(v => v / norm);
}

// @huggingface/transformers is NOT a project dependency (package.json stays
// at zero required dependencies) — this is an entirely optional, opt-in
// capability. `npm install @huggingface/transformers` once and it starts
// working automatically; without it, this quietly never becomes available
// and getEmbedding() falls through exactly as it did before this existed.
// Loaded lazily and cached — the ~90MB model download only happens on
// first real use, and only once per process.
let localPipelinePromise = null;
async function getLocalPipeline() {
  if (!localPipelinePromise) {
    localPipelinePromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
  }
  return localPipelinePromise;
}

async function callLocalEmbedding(text) {
  const extractor = await getLocalPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  const vector = Array.from(output.data);
  if (!vector.length) throw new Error('Local embedding model returned no output');
  return vector;
}

// ── Retrieve embedding from available API ─────────────────────────────────────
// Falls through to the next provider on failure (bad key, exhausted quota,
// network error) instead of giving up on the first configured one — an
// if/return chain with no fallback would mean that whenever one key is
// merely PRESENT but broken, a perfectly good key sitting right next to it
// never even gets tried, silently degrading every search to keyword-only.
//
// The local model is tried LAST, not first: a vault's existing cached
// vectors came from whichever cloud provider produced them, and a different
// provider's vectors have a different dimensionality (cosineSimilarity
// already safely returns 0 for a length mismatch rather than throwing, so
// this never breaks anything — it just silently drops the semantic arm's
// contribution for whichever query hit the mismatch). Keeping cloud
// providers as the default preserves consistency with whatever's already
// cached; local only kicks in as a last-resort safety net so search never
// goes fully dark just because a cloud key is missing or exhausted.
export async function getEmbedding(text, keys = {}) {
  const openaiKey = keys.openaiKey || process.env.OPENAI_API_KEY || '';
  const geminiKey = keys.geminiKey || process.env.GEMINI_API_KEY || '';

  const errors = [];
  if (openaiKey) {
    try { return await callOpenAIEmbedding(openaiKey, text); }
    catch (err) { errors.push(`openai: ${err.message}`); }
  }
  if (geminiKey) {
    try { return await callGeminiEmbedding(geminiKey, text); }
    catch (err) { errors.push(`gemini: ${err.message}`); }
  }
  try { return await callLocalEmbedding(text); }
  catch (err) { errors.push(`local: ${err.message}`); }

  // Local is always attempted regardless of whether a cloud key exists (it's
  // the last-resort safety net), so `errors` is never empty at this point —
  // but when there was no cloud key at all, say so up front rather than
  // leading with the local model's own (often package-manager-flavored)
  // error text.
  if (!openaiKey && !geminiKey) errors.unshift('No OpenAI/Gemini API key configured');
  throw new Error(errors.join(' | '));
}

// ── Single-row operations ────────────────────────────────────────────────────
// The efficient path: a direct indexed lookup/write for one node, instead of
// reading or rewriting every node's vector just to touch one.
function getVectorEntry(nodeId) {
  const row = getDb().prepare('SELECT hash, vector, updated_at FROM embeddings WHERE node_id = ?').get(nodeId);
  if (!row) return null;
  return { hash: row.hash, vector: decodeVector(row.vector), updatedAt: row.updated_at };
}

function upsertVectorEntry(nodeId, hash, vector, updatedAt = new Date().toISOString(), database = getDb()) {
  database.prepare(`
    INSERT INTO embeddings (node_id, hash, vector, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(node_id) DO UPDATE SET hash = excluded.hash, vector = excluded.vector, updated_at = excluded.updated_at
  `).run(nodeId, hash, encodeVector(vector), updatedAt);
}

// ── Cache operations ─────────────────────────────────────────────────────────
// Kept for callers that genuinely need every vector at once (the semantic
// search arm's brute-force cosine-similarity scan — real ANN indexing would
// need a vector-search SQLite extension, which isn't a built-in
// zero-dependency option the way node:sqlite is). New code doing a single-
// node lookup/write should prefer getVectorEntry/upsertVectorEntry above
// instead of paying for a full scan.
export function getEmbeddingsCache() {
  try {
    const rows = getDb().prepare('SELECT node_id, hash, vector, updated_at FROM embeddings').all();
    const cache = {};
    for (const row of rows) {
      cache[row.node_id] = { hash: row.hash, vector: decodeVector(row.vector), updatedAt: row.updated_at };
    }
    return cache;
  } catch (e) {
    console.warn(`[embeddings] Error reading cache: ${e.message}`);
    return {};
  }
}

export function saveEmbeddingsCache(cache) {
  try {
    const database = getDb();
    database.exec('BEGIN');
    try {
      for (const [nodeId, entry] of Object.entries(cache)) {
        if (!entry || !Array.isArray(entry.vector)) continue;
        upsertVectorEntry(nodeId, entry.hash, entry.vector, entry.updatedAt || new Date().toISOString(), database);
      }
      database.exec('COMMIT');
    } catch (e) {
      database.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    console.error(`[embeddings] Error writing cache: ${e.message}`);
  }
}

// ── Helper: generate text hash ───────────────────────────────────────────────
export function getHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// ── Update embedding for a single node ────────────────────────────────────────
/**
 * @param {object} [sharedCache] - Pass an already-loaded cache object to
 *   batch many updates into one transaction (see batchUpdateNodeEmbeddings).
 *   Omit it for the normal single-node path, which does one indexed row
 *   lookup/write instead of touching every other node's vector.
 */
export async function updateNodeEmbedding(nodeId, title, content, keys = {}, sharedCache = null) {
  const text = `${title}\n\n${content}`;
  const hash = getHash(text);

  if (sharedCache) {
    // Batch path: caller flushes the whole in-memory cache once at the end.
    if (sharedCache[nodeId] && sharedCache[nodeId].hash === hash && Array.isArray(sharedCache[nodeId].vector)) {
      return sharedCache[nodeId].vector;
    }
    try {
      const vector = await getEmbedding(text, keys);
      sharedCache[nodeId] = { hash, vector, updatedAt: new Date().toISOString() };
      return vector;
    } catch (err) {
      console.warn(`[embeddings] Failed to update vector for "${title}": ${err.message}`);
      return null;
    }
  }

  // If hash matches, keep the existing vector to save API quota — a single
  // indexed row read, not a full-cache load.
  try {
    const existing = getVectorEntry(nodeId);
    if (existing && existing.hash === hash) return existing.vector;
  } catch { /* fall through and try to (re)compute */ }

  try {
    const vector = await getEmbedding(text, keys);
    upsertVectorEntry(nodeId, hash, vector);
    return vector;
  } catch (err) {
    // Silent fail/warning to avoid blocking normal node writes when offline
    // or when no embedding provider is configured at all.
    console.warn(`[embeddings] Failed to update vector for "${title}": ${err.message}`);
    return null;
  }
}

// ── Batch update many nodes in one transaction ──────────────────────────────
// updateNodeEmbedding() alone (non-batch path) is already a single indexed
// row per call, but a full-vault reindex still shouldn't pay for N separate
// transactions — this collects everything that actually changed and writes
// it in one.
export async function batchUpdateNodeEmbeddings(nodeList, keys = {}) {
  const cache = getEmbeddingsCache();
  let processed = 0;
  let failed = 0;

  for (const node of nodeList) {
    try {
      const vector = await updateNodeEmbedding(node.id, node.title, node.content, keys, cache);
      if (vector) processed++; else failed++;
    } catch {
      failed++;
    }
  }

  saveEmbeddingsCache(cache);
  return { processed, failed };
}
