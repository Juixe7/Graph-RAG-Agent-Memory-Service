/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Near-Duplicate Memory Reconciliation
 *
 *  A cheap embedding-similarity gate decides which existing memory
 *  is even worth comparing, then an LLM judge decides whether to
 *  actually merge (same fact, just reworded) or keep both (any
 *  material difference — a number, an entity, a negation, a
 *  condition). The judge never averages or computes over facts — it
 *  only ever preserves full detail from both sides on a merge.
 *
 *  Fails open everywhere: any missing key or LLM error just means
 *  "keep both" — a dedup failure must never block a normal memory
 *  write. With no embedding/LLM provider configured at all, dedup
 *  simply never finds a candidate — the rest of the app is
 *  unaffected either way.
 * ══════════════════════════════════════════════════════════════
 */

import { getEmbedding, getEmbeddingsCache } from './embeddings.js';
import { routeLLM } from './llm_router.js';

// A high bar (0.97 cosine similarity) suits tightly-templated, LLM-extracted
// facts. Free-form personal notes vary more in phrasing for the same
// underlying content, so a slightly lower gate still keeps false merges
// rare while actually catching near-duplicates in practice.
export const DEDUP_SIMILARITY_THRESHOLD = 0.93;

function cosineSimilarity(v1, v2) {
  if (!v1 || !v2 || v1.length !== v2.length) return 0;
  let dot = 0, mag1 = 0, mag2 = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
    mag1 += v1[i] * v1[i];
    mag2 += v2[i] * v2[i];
  }
  return mag1 && mag2 ? dot / (Math.sqrt(mag1) * Math.sqrt(mag2)) : 0;
}

/**
 * Find the most similar existing node to a candidate (same type + agent),
 * using already-cached embeddings for the existing side — only the
 * candidate needs a fresh embedding call.
 * @returns {Promise<{node: object, similarity: number}|null>}
 */
export async function findMostSimilarNode(nodes, candidate, keys = {}, threshold = DEDUP_SIMILARITY_THRESHOLD) {
  const pool = Object.values(nodes).filter(n =>
    n.type === candidate.type &&
    n.agent === candidate.agent &&
    n.id !== candidate.id
  );
  if (!pool.length) return null;

  let vector;
  try {
    vector = await getEmbedding(`${candidate.title}\n\n${candidate.content}`, keys);
  } catch {
    return null; // no embedding provider configured — dedup opts out silently, same fail-open policy as the rest of the vault
  }
  if (!vector) return null;

  const cache = getEmbeddingsCache();
  let best = null;
  for (const node of pool) {
    const entry = cache[node.id];
    if (!entry || !Array.isArray(entry.vector)) continue;
    const sim = cosineSimilarity(vector, entry.vector);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { node, similarity: sim };
    }
  }
  return best;
}

const DEDUP_JUDGE_SYSTEM_PROMPT = `You reconcile near-duplicate personal-memory notes for the Second Brain system.
You will be given a NEW note and an EXISTING note that an embedding search flagged as highly similar.

If they assert the SAME fact or event (wording aside) → merge them, preserving EVERY distinct detail from both. Never drop information, and never average, sum, or otherwise compute a new value from the two.
If they differ in ANY material way — a number, a name, a date, a negation, a condition, an outcome — keep them both separate instead of merging.

Respond ONLY with a JSON object in one of these two shapes:
{"action":"merge","title":"<merged title>","content":"<merged markdown, preserving wikilinks>","tags":["tag1","tag2"]}
{"action":"keep"}`;

function validateDedupVerdict(obj) {
  if (!obj || typeof obj !== 'object') return 'response is not an object';
  if (obj.action === 'keep') return true;
  if (obj.action === 'merge') {
    if (typeof obj.title !== 'string' || !obj.title.trim()) return '"title" is required for a merge';
    if (typeof obj.content !== 'string' || !obj.content.trim()) return '"content" is required for a merge';
    return true;
  }
  return 'unknown action — expected "merge" or "keep"';
}

/**
 * Ask an LLM to decide whether `candidate` should be merged into
 * `existing`, or kept as a separate note. Fails open (returns
 * {action:'keep'}) on any error — never blocks the caller's normal write.
 */
export async function judgeDuplicate(candidate, existing, llmKeys, logFn = () => {}) {
  const userPrompt = [
    '[NEW]',
    `Title: ${candidate.title}`,
    candidate.content,
    '',
    '[EXISTING]',
    `Title: ${existing.title}`,
    existing.content,
  ].join('\n');

  try {
    return await routeLLM(llmKeys, DEDUP_JUDGE_SYSTEM_PROMPT, userPrompt, {
      json: true,
      validate: validateDedupVerdict,
      logFn,
    });
  } catch (err) {
    logFn(`[dedup] judge call failed, keeping both notes: ${err.message}`);
    return { action: 'keep' };
  }
}

/**
 * Scan the vault for near-duplicate candidates without changing anything.
 * Groups nodes by (type, agent), embeds each once, and reports any pair
 * whose cosine similarity clears the threshold together with the judge's
 * verdict — the caller (the /dedup/scan endpoint) decides whether to act
 * on it. Fails open: any per-node error just skips that node.
 *
 * @param {object} nodes   - full vault node map, as returned by loadVault()
 * @param {object} [opts]
 * @param {object} [opts.embeddingKeys] - resolveKeys() bundle for embeddings
 * @param {object} [opts.llmKeys]       - resolveKeys() bundle for the judge
 * @param {number} [opts.threshold]     - override DEDUP_SIMILARITY_THRESHOLD
 * @param {boolean} [opts.judge]        - also run the LLM judge on each
 *   candidate pair (default true). Set false to just report similarity
 *   without spending an LLM call per candidate.
 * @returns {Promise<Array<{a, b, similarity, verdict}>>}
 */
export async function scanForDuplicates(nodes, opts = {}) {
  const embeddingKeys = opts.embeddingKeys || {};
  const llmKeys = opts.llmKeys || {};
  const threshold = opts.threshold ?? DEDUP_SIMILARITY_THRESHOLD;
  const runJudge = opts.judge !== false;
  const logFn = opts.logFn || (() => {});

  const candidates = [];
  try {
    const all = Object.values(nodes).filter(n => n.type !== 'archive');
    const cache = getEmbeddingsCache();
    const seenPairs = new Set();

    for (const node of all) {
      const entry = cache[node.id];
      if (!entry || !Array.isArray(entry.vector)) continue;

      for (const other of all) {
        if (other.id === node.id) continue;
        if (other.type !== node.type || other.agent !== node.agent) continue;

        const pairKey = [node.id, other.id].sort().join('|');
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const otherEntry = cache[other.id];
        if (!otherEntry || !Array.isArray(otherEntry.vector)) continue;

        const similarity = cosineSimilarity(entry.vector, otherEntry.vector);
        if (similarity < threshold) continue;

        let verdict = null;
        if (runJudge) {
          try {
            verdict = await judgeDuplicate(node, other, llmKeys, logFn);
          } catch (err) {
            logFn(`[dedup] scan judge call failed for ${node.id}/${other.id}: ${err.message}`);
            verdict = { action: 'keep' };
          }
        }

        candidates.push({
          a: { id: node.id, title: node.title },
          b: { id: other.id, title: other.title },
          similarity,
          verdict,
        });
      }
    }
  } catch (err) {
    logFn(`[dedup] scan failed, reporting no candidates: ${err.message}`);
    return [];
  }

  return candidates.sort((x, y) => y.similarity - x.similarity);
}
