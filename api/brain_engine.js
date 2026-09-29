/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Brain Engine
 *  Core logic: reads vault .md files, parses wikilinks,
 *  builds graph, runs keyword search, assembles context.
 *  Pure Node.js · Zero dependencies · Fully offline
 * ══════════════════════════════════════════════════════════════
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getEmbedding, getEmbeddingsCache } from '../sdk/embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Same BRAIN_VAULT override sdk/embeddings.js already honors — lets a
// migration or test point at a scratch copy of the vault instead of the
// real one (see migrations/README.md and test/search_hybrid.test.js).
const VAULT_DIR = process.env.BRAIN_VAULT ? path.resolve(process.env.BRAIN_VAULT) : path.resolve(__dirname, '..', 'vault');

// ── YAML frontmatter parser (simple, no deps) ────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (let line of match[1].split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    let key = line.slice(0, colonIdx).trim().replace(/^['"]|['"]$/g, '');
    let val = line.slice(colonIdx + 1).trim().replace(/^['"]|['"]$/g, '');
    // Parse arrays: [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
    } else {
      const num = Number(val);
      if (val !== '' && !isNaN(num) && Number.isInteger(num)) {
        val = num;
      }
    }
    meta[key] = val;
  }
  return { meta, body: match[2] };
}

function buildFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else                   lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// ── Wikilink & tag parser ─────────────────────────────────────────────────────
function stripCodeBlocks(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, '') // remove multi-line code blocks
    .replace(/`[^`\r\n]+`/g, '');    // remove inline code blocks
}

export function parseWikiLinks(text = '') {
  const cleanText = stripCodeBlocks(text);
  const links = [], re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(cleanText)) !== null) links.push(m[1].trim());
  return [...new Set(links)];
}

export function parseTags(text = '') {
  const cleanText = stripCodeBlocks(text);
  const tags = [], re = /#([a-zA-Z_][\w\-/]*)/g; // Match standard tags, supporting sub-tags like parent/child
  let m;
  while ((m = re.exec(cleanText)) !== null) {
    const tag = m[1];
    if (/^\d+$/.test(tag)) continue; // ignore pure numerical hashes (e.g. hex colors, header links)
    tags.push(tag.toLowerCase());
  }
  return [...new Set(tags)];
}

// ── Load ALL .md files from vault recursively ────────────────────────────────
export function loadVault() {
  const nodes = {};

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.name.endsWith('.md')) continue;

      try {
        const raw       = fs.readFileSync(fullPath, 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const relPath   = path.relative(VAULT_DIR, fullPath).replace(/\\/g, '/');
        const id        = relPath.replace(/\.md$/, '');
        const title     = path.basename(entry.name, '.md');
        const allTags   = [...new Set([
          ...(Array.isArray(meta.tags) ? meta.tags : []),
          ...parseTags(body),
        ])];

        nodes[id] = {
          id,
          title,
          type:      meta.type      || 'note',
          tags:      allTags,
          agent:     meta.agent     || null,
          createdAt: meta.createdAt || null,
          importance: parseInt(meta.importance, 10) || 5,
          lastAccessedAt: meta.lastAccessedAt || meta.createdAt || new Date().toISOString().split('T')[0],
          version:   parseInt(meta.version, 10) || 1,
          // Optional org-chart frontmatter (sdk/org_chart.js) — an explicit
          // curation always wins over the tag-derived department guess.
          department: meta.department || null,
          reportsTo:  meta.reportsTo  || null,
          content:   body.trim(),
          filePath:  fullPath,
          relPath,
        };
      } catch (e) {
        console.warn(`[brain] Could not read ${fullPath}: ${e.message}`);
      }
    }
  }

  walk(VAULT_DIR);
  precomputeSearchIndex(nodes);
  return nodes;
}

// ── Write a node to vault as .md file ────────────────────────────────────────
export function writeNode(node, subdir = '') {
  const folder   = subdir
    ? path.join(VAULT_DIR, subdir)
    : path.join(VAULT_DIR, node.type === 'note' ? '' : node.type + 's');

  fs.mkdirSync(folder, { recursive: true });

  const safeName = node.title.replace(/[<>:"/\\|?*]/g, '-');
  const filePath = path.join(folder, `${safeName}.md`);

  const meta = {
    type:      node.type      || 'note',
    tags:      node.tags      || [],
    agent:     node.agent     || 'unknown',
    createdAt: node.createdAt || new Date().toISOString().split('T')[0],
    importance: node.importance || 5,
    lastAccessedAt: node.lastAccessedAt || node.createdAt || new Date().toISOString().split('T')[0],
    version:   node.version   || 1,
  };

  const content = buildFrontmatter(meta) + `# ${node.title}\n\n${node.content || ''}`;
  fs.writeFileSync(filePath, content, 'utf8');

  // Return node id
  const relPath = path.relative(VAULT_DIR, filePath).replace(/\\/g, '/');
  return relPath.replace(/\.md$/, '');
}

// ── Update an existing .md file ───────────────────────────────────────────────
export function updateNodeFile(filePath, patch) {
  if (!fs.existsSync(filePath)) return false;
  const raw            = fs.readFileSync(filePath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);

  const currentVersion = parseInt(meta.version, 10) || 1;
  const newMeta    = { ...meta, ...(patch.meta || {}) };
  const newContent = patch.content !== undefined ? patch.content : body;

  // Every node's stored content always begins with "# <title>" (this function
  // and the node-creation path always reconstruct the file that way), so on a
  // metadata-only patch `newContent` above is just `body`, which STILL has
  // that leading heading line in it. Writing `# ${newTitle}\n\n${newContent}`
  // unconditionally therefore prepended a second, duplicate heading on every
  // metadata-only update (e.g. /recall's passive lastAccessedAt touch) —
  // strip the old leading heading before reassembling.
  let cleanContent = newContent.trim();
  cleanContent = cleanContent.replace(/^#[^\n]*\r?\n+/, '').trim();

  // A node's real displayed heading can differ from its filename (special
  // characters get sanitized out of filenames, or the file simply predates
  // some naming convention) — path.basename must only ever be a last-resort
  // fallback, never the default "current title". Falling back to it
  // unconditionally here meant ANY patch that didn't set patch.title (e.g.
  // /recall's passive lastAccessedAt touch) silently replaced a node's real
  // heading with its bare filename the next time it was read.
  const existingHeadingMatch = body.match(/^\s*#[ \t]+([^\n]+)/);
  const existingHeading = existingHeadingMatch ? existingHeadingMatch[1].trim() : path.basename(filePath, '.md');
  const newTitle   = patch.title || existingHeading;

  // Determine if it was an actual user write/edit (content, title, or core meta changes)
  const isActualEdit = (patch.title && patch.title !== path.basename(filePath, '.md')) ||
                       (patch.content !== undefined && patch.content !== body) ||
                       (patch.meta && (
                         (patch.meta.type && patch.meta.type !== meta.type) ||
                         (patch.meta.tags && JSON.stringify(patch.meta.tags) !== JSON.stringify(meta.tags)) ||
                         (patch.meta.importance && parseInt(patch.meta.importance, 10) !== parseInt(meta.importance, 10))
                       ));

  if (isActualEdit) {
    newMeta.version = currentVersion + 1;
  }

  fs.writeFileSync(filePath, buildFrontmatter(newMeta) + `# ${newTitle}\n\n${cleanContent}`, 'utf8');
  return true;
}

// ── Delete a .md file ─────────────────────────────────────────────────────────
export function deleteNodeFile(filePath) {
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true; }
  return false;
}

// ── Build edge list from all wikilinks ────────────────────────────────────────
export function buildEdges(nodes) {
  const edges = [];
  const byTitle = {};
  for (const n of Object.values(nodes)) {
    byTitle[n.title.toLowerCase()] = n.id;
  }

  for (const node of Object.values(nodes)) {
    for (const link of parseWikiLinks(node.content)) {
      const targetId = byTitle[link.toLowerCase()];
      if (targetId && targetId !== node.id) {
        edges.push({ source: node.id, target: targetId,
                     sourceTitle: node.title, targetTitle: nodes[targetId]?.title });
      }
    }
  }
  return edges;
}

// ── Build backlinks map ────────────────────────────────────────────────────────
export function buildBacklinks(nodes) {
  const map = {};
  for (const { source, target } of buildEdges(nodes)) {
    if (!map[target]) map[target] = [];
    if (!map[target].includes(source)) map[target].push(source);
  }
  return map;
}

// ── TF-IDF Cosine Similarity Search & Time-Decay scoring ──────────────────────
function tokenize(text) {
  if (!text) return [];
  return text.toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1);
}

function getDecayFactor(node) {
  const today = new Date();
  const lastAccessStr = node.lastAccessedAt || node.createdAt || new Date().toISOString().split('T')[0];
  const lastAccess = new Date(lastAccessStr);
  const diffTime = Math.abs(today - lastAccess);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  const importance = parseInt(node.importance, 10) || 5;
  let halfLife = 30; // default medium half-life
  if (importance >= 8) halfLife = 180;
  else if (importance <= 4) halfLife = 7;
  
  const lambda = 0.693 / halfLife;
  return Math.exp(-lambda * diffDays);
}

// ── TF-IDF Caching Search Engine & Optimizations ──────────────────────────────
let searchIndex = {
  docTokens: [], // Array of { id, tokens, magnitude, docTf }
  df: {},
  N: 0
};

export function precomputeSearchIndex(nodes) {
  const allNodes = Object.values(nodes).filter(n => n.type !== 'archive');
  const N = allNodes.length;
  const df = {};

  const docTokens = allNodes.map(node => {
    const text = `${node.title} ${node.title} ${node.tags.join(' ')} ${node.tags.join(' ')} ${node.content}`;
    const tokens = tokenize(text);
    const uniqueTokens = new Set(tokens);
    for (const t of uniqueTokens) {
      df[t] = (df[t] || 0) + 1;
    }

    const docTf = {};
    for (const t of tokens) {
      docTf[t] = (docTf[t] || 0) + 1;
    }

    return { id: node.id, tokens, docTf };
  });

  docTokens.forEach(doc => {
    let docMagnitudeSq = 0;
    for (const t of Object.keys(doc.docTf)) {
      const idf = Math.log(1 + N / (df[t] || 1));
      const tfidf = doc.docTf[t] * idf;
      docMagnitudeSq += tfidf * tfidf;
    }
    doc.magnitude = Math.sqrt(docMagnitudeSq);
  });

  searchIndex = { docTokens, df, N };
}

export function searchNodes(nodes, query, limit = 10) {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];

  const { docTokens, df, N } = searchIndex;
  if (N === 0) return [];

  const queryTf = {};
  for (const t of queryTokens) queryTf[t] = (queryTf[t] || 0) + 1;

  const queryVector = {};
  let queryMagnitudeSq = 0;
  for (const t of Object.keys(queryTf)) {
    const idf = Math.log(1 + N / (df[t] || 1));
    const tfidf = queryTf[t] * idf;
    queryVector[t] = tfidf;
    queryMagnitudeSq += tfidf * tfidf;
  }
  const queryMagnitude = Math.sqrt(queryMagnitudeSq);
  if (queryMagnitude === 0) return [];

  const results = [];
  docTokens.forEach(doc => {
    const node = nodes[doc.id];
    if (!node) return;

    let dotProduct = 0;
    for (const t of Object.keys(doc.docTf)) {
      if (queryVector[t]) {
        const idf = Math.log(1 + N / (df[t] || 1));
        const tfidf = doc.docTf[t] * idf;
        dotProduct += queryVector[t] * tfidf;
      }
    }

    let cosineSim = 0;
    if (queryMagnitude > 0 && doc.magnitude > 0) {
      cosineSim = dotProduct / (queryMagnitude * doc.magnitude);
    }

    // Boost exact matches in title
    if (node.title.toLowerCase().includes(query.toLowerCase())) cosineSim += 0.4;
    if (node.title.toLowerCase() === query.toLowerCase()) cosineSim += 0.8;

    // Apply Time-Decay weight
    const score = cosineSim * getDecayFactor(node);

    if (score > 0.05) {
      results.push({
        id:      node.id,
        title:   node.title,
        type:    node.type,
        tags:    node.tags,
        agent:   node.agent,
        score,
        preview: node.content.replace(/[#*\[\]`>_]/g, '').slice(0, 160).trim(),
      });
    }
  });

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ── Hybrid semantic + keyword search (Reciprocal Rank Fusion) ────────────────
// searchNodes() above (TF-IDF over the precomputed index) is untouched and
// stays the ENTIRE story when no embedding provider is configured — this
// section is a pure additive enhancement layered on top of it, not a
// replacement.
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

// Merges several independently-ranked id lists into one score per id — the
// standard Cormack/Clarke RRF constant (k=60): score(id) = Σ 1/(k + rank).
// Cheap, needs no score normalization across arms (unlike averaging raw
// similarity scores from different metrics, whose scales aren't comparable),
// and a candidate only needs to rank well on ONE arm to surface.
const RRF_K = 60;

function reciprocalRankFusion(rankedIdLists) {
  const scores = new Map();
  for (const ids of rankedIdLists) {
    ids.forEach((id, rank) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return scores;
}

// Semantic arm: rank all nodes by cosine similarity of their cached
// embedding to the query vector, with the same title-match boosts the
// keyword arm uses. Returns ids only (best first) so callers fuse this with
// the keyword arm rather than comparing raw similarity scores directly.
//
// Checks the embeddings cache for ANY stored vector BEFORE calling
// getEmbedding() on the query — this is what keeps a default, unconfigured
// install from paying any embedding-provider/local-model call on every
// single search: if nothing has ever been embedded (no provider configured,
// nobody has run POST /embeddings/reindex), there's nothing to compare
// against regardless, so the arm short-circuits to empty without touching
// the network or attempting to load the optional local model.
async function semanticRankIds(allNodes, query, keys) {
  try {
    const cache = getEmbeddingsCache();
    const hasVectors = Object.values(cache).some(entry => Array.isArray(entry.vector));
    if (!hasVectors) return [];

    const queryVector = await getEmbedding(query, keys);
    if (!queryVector) return [];

    return allNodes
      .map(node => {
        const entry = cache[node.id];
        let sim = entry && Array.isArray(entry.vector) ? cosineSimilarity(queryVector, entry.vector) : 0;
        if (node.title.toLowerCase().includes(query.toLowerCase())) sim += 0.3;
        if (node.title.toLowerCase() === query.toLowerCase()) sim += 0.5;
        return { id: node.id, sim };
      })
      .filter(r => r.sim > 0.05)
      .sort((a, b) => b.sim - a.sim)
      .map(r => r.id);
  } catch (err) {
    console.warn(`[brain] Semantic search arm failed, continuing with keyword-only results: ${err.message}`);
    return [];
  }
}

/**
 * Hybrid search: fuses the semantic arm (embeddings, when available) with
 * the existing TF-IDF keyword arm via Reciprocal Rank Fusion, then applies
 * the same recency/importance decay multiplier searchNodes() already uses.
 *
 * When no embedding provider is configured AND nothing has ever been
 * embedded (the default, zero-dependency state), this returns EXACTLY
 * searchNodes()'s own result — same ranking, same scores, same object
 * shape — so existing behavior is unchanged until someone opts in.
 *
 * @param {object} nodes
 * @param {string} query
 * @param {number} [limit]
 * @param {object} [keys] - resolveKeys() bundle (sdk/models_config.js); only
 *   used if a semantic candidate pool already exists.
 */
export async function searchNodesWithSemantics(nodes, query, limit = 10, keys = {}) {
  const allNodes = Object.values(nodes).filter(n => n.type !== 'archive');
  if (!allNodes.length) return [];

  const semanticIds = await semanticRankIds(allNodes, query, keys);
  if (!semanticIds.length) return searchNodes(nodes, query, limit);

  // Reuse the existing precomputed-index keyword engine for the ranking
  // order — no re-tokenization, no second index build.
  const keywordIds = searchNodes(nodes, query, allNodes.length).map(r => r.id);
  const arms = [semanticIds, keywordIds].filter(a => a.length);
  if (!arms.length) return [];

  const fused = reciprocalRankFusion(arms);

  return [...fused.entries()]
    .map(([id, rrfScore]) => {
      const node = nodes[id];
      if (!node) return null;
      // Post-fusion recency/importance multiplier — same role as the
      // decay factor already applied inside searchNodes(), layered on top
      // of the fused rank rather than replacing it.
      const score = rrfScore * getDecayFactor(node);
      return {
        id:      node.id,
        title:   node.title,
        type:    node.type,
        tags:    node.tags,
        agent:   node.agent,
        score,
        preview: node.content.replace(/[#*\[\]`>_]/g, '').slice(0, 160).trim(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Node Schema Validation ───────────────────────────────────────────────────
export function validateNode(node, isUpdate = false) {
  const errors = [];

  if (!isUpdate) {
    if (!node.title || typeof node.title !== 'string' || !node.title.trim()) {
      errors.push('Title is required and must be a non-empty string.');
    } else if (/[<>:"/\\|?*]/.test(node.title)) {
      errors.push('Title contains invalid characters for filenames: < > : " / \\ | ? *');
    }
  } else {
    if (node.title !== undefined) {
      if (typeof node.title !== 'string' || !node.title.trim()) {
        errors.push('Title must be a non-empty string.');
      } else if (/[<>:"/\\|?*]/.test(node.title)) {
        errors.push('Title contains invalid characters for filenames: < > : " / \\ | ? *');
      }
    }
  }

  const validTypes = ['core', 'system', 'memory', 'research', 'decision', 'task', 'insight', 'note', 'archive', 'agent', 'message'];
  if (node.type !== undefined) {
    if (!validTypes.includes(node.type)) {
      errors.push(`Type must be one of: ${validTypes.join(', ')}`);
    }
  }

  if (node.importance !== undefined) {
    const importanceVal = parseInt(node.importance, 10);
    if (isNaN(importanceVal) || importanceVal < 1 || importanceVal > 10) {
      errors.push('Importance must be an integer between 1 and 10.');
    }
  }

  if (node.tags !== undefined) {
    if (!Array.isArray(node.tags) || !node.tags.every(t => typeof t === 'string')) {
      errors.push('Tags must be an array of strings.');
    }
  }

  if (node.content !== undefined && typeof node.content !== 'string') {
    errors.push('Content must be a string.');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

export function archiveStaleNodes(nodes) {
  const today = new Date();
  let archivedCount = 0;
  for (const node of Object.values(nodes)) {
    if (node.type === 'archive' || node.tags.includes('core') || node.tags.includes('system')) continue;

    const lastAccessStr = node.lastAccessedAt || node.createdAt || new Date().toISOString().split('T')[0];
    const lastAccess = new Date(lastAccessStr);
    const diffTime = Math.abs(today - lastAccess);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    const importance = parseInt(node.importance, 10) || 5;

    // Archive thresholds: Low importance & 14 days inactive, or Medium importance & 45 days inactive
    if ((importance <= 4 && diffDays > 14) || (importance <= 7 && diffDays > 45)) {
      const archiveDir = path.join(VAULT_DIR, 'archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

      // Change file meta and rewrite
      updateNodeFile(node.filePath, {
        meta: { type: 'archive' }
      });

      // Move file physical location
      const newPath = path.join(archiveDir, path.basename(node.filePath));
      fs.renameSync(node.filePath, newPath);
      archivedCount++;
      console.log(`[brain] 📦 Archived stale node: "${node.title}" (inactive for ${diffDays} days)`);
    }
  }
  return archivedCount;
}

// ── Smart context retrieval: seed + N hops + token budget ────────────────────
/**
 * @param {object} [keys] - resolveKeys() bundle, forwarded to
 *   searchNodesWithSemantics() for the seed search. Omit for keyword-only
 *   seeding (identical to this function's previous, synchronous behavior).
 */
export async function buildContext(nodes, query, hops = 1, maxTokens = 2000, keys = {}) {
  const seeds = await searchNodesWithSemantics(nodes, query, 3, keys);
  if (!seeds.length) return { query, nodes: [], tokenEstimate: 0, systemPrompt: '' };

  const byTitle  = {};
  for (const n of Object.values(nodes)) byTitle[n.title.toLowerCase()] = n.id;

  const visited = new Set();
  const queue   = seeds.map(s => ({ id: s.id, hop: 0 }));
  const result  = [];
  let   tokens  = 0;

  while (queue.length) {
    const { id, hop } = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    const node = nodes[id];
    if (!node) continue;

    const est = Math.ceil(node.content.length / 4);
    if (tokens + est > maxTokens && result.length > 0) break;
    result.push({ ...node, hop });
    tokens += est;

    if (hop < hops) {
      for (const link of parseWikiLinks(node.content)) {
        const tid = byTitle[link.toLowerCase()];
        if (tid && !visited.has(tid)) queue.push({ id: tid, hop: hop + 1 });
      }
    }
  }

  return {
    query,
    hops,
    tokenEstimate: tokens,
    nodeCount:     result.length,
    nodes:         result,
    systemPrompt:  buildSystemPrompt(result),
  };
}

function buildSystemPrompt(nodes) {
  if (!nodes.length) return '';
  const lines = ['## Knowledge Base Context\n',
    `> ${nodes.length} relevant nodes retrieved. Use this context to answer accurately.\n`];
  for (const n of nodes) {
    lines.push(`### ${n.title} [${n.type.toUpperCase()}]`);
    lines.push(n.content);
    lines.push('');
  }
  return lines.join('\n');
}

