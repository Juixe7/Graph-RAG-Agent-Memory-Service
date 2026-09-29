/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Agent SDK
 *
 *  The only file any agent needs to import.
 *  Works with any AI agent — Gemini, GPT, Claude, custom.
 *
 *  USAGE:
 *    import { SecondBrain } from '../second-brain/sdk/index.js';
 *
 *    const brain = new SecondBrain({ agent: 'my-agent-name' });
 *
 *    // Get context before a task (95% fewer tokens than reading files)
 *    const ctx = await brain.recall('how to handle PDF export');
 *    // ctx.systemPrompt → inject into your AI call
 *
 *    // Save a memory after a task
 *    await brain.remember('Found high demand for AI prompts on Reddit', {
 *      title: 'Research: AI Prompts Niche',
 *      type:  'research',
 *      tags:  ['ai', 'prompts', 'research'],
 *    });
 *
 * ══════════════════════════════════════════════════════════════
 */

const DEFAULT_API = 'http://localhost:3747';

export class SecondBrain {
  /**
  /**
   * @param {{ agent?: string, api?: string, apiKey?: string, silent?: boolean }} options
   *   agent  — name of the agent using this SDK (stored with memories)
   *   api    — URL of the brain API (default: http://localhost:3747)
   *   apiKey — API key for authentication (default: process.env.BRAIN_KEY)
   *   silent — suppress console logs (default: false)
   */
  constructor(options = {}) {
    this.agentName = options.agent  || 'unknown-agent';
    this.apiUrl    = options.api    || process.env.BRAIN_API || DEFAULT_API;
    this.apiKey    = options.apiKey || process.env.BRAIN_KEY || '';
    this.silent    = options.silent || false;
    this._alive    = null; // cached liveness check
  }

  _log(...args) {
    if (!this.silent) console.log(`[brain:${this.agentName}]`, ...args);
  }

  // ── Core fetch ──────────────────────────────────────────────────────────
  async _fetch(path, options = {}) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const res = await fetch(`${this.apiUrl}${path}`, {
        ...options,
        headers: {
          ...headers,
          ...(options.headers || {}),
        },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (e) {
      if (!this.silent) console.warn(`[brain] Unavailable: ${e.message}`);
      return null;
    }
  }

  // ── Liveness check ──────────────────────────────────────────────────────
  async isAlive() {
    const res = await this._fetch('/health');
    this._alive = !!res?.status;
    return this._alive;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  READ METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 🔑 KEY METHOD — recall relevant context before a task.
   *
   * Searches the knowledge graph for the query and returns the most
   * relevant nodes with their linked neighbors. Returns a ready-to-use
   * systemPrompt string to inject into your AI call.
   *
   * Token cost: ~300–2000 tokens (vs ~50,000 for reading source files)
   *
   * @param {string} query     — What you need to know
   * @param {number} hops      — How many wikilink levels to follow (0–3)
   * @param {number} maxTokens — Token budget (default 2000)
   * @returns {{ systemPrompt, nodes, tokenEstimate, nodeCount }}
   *
   * Example:
   *   const ctx = await brain.recall('telegram approval flow', 1);
   *   const aiResponse = await gemini.generate({
   *     system: ctx.systemPrompt + mySystemPrompt,
   *     prompt: userMessage,
   *   });
   */
  async recall(query, hops = 1, maxTokens = 2000) {
    const params = new URLSearchParams({ q: query, hops, maxTokens, agent: this.agentName });
    const result = await this._fetch(`/recall?${params}`);
    if (!result) return { systemPrompt: '', nodes: [], tokenEstimate: 0, nodeCount: 0 };
    this._log(`recall("${query}") → ${result.nodeCount} nodes, ~${result.tokenEstimate} tokens`);
    return result;
  }

  /**
   * Search the knowledge graph by keyword.
   * Returns scored, ranked results.
   *
   * @param {string} query
   * @param {number} limit — max results (default 5)
   * @returns {Array<{ id, title, type, tags, score, preview }>}
   */
  async search(query, limit = 5) {
    const params = new URLSearchParams({ q: query, limit });
    const result = await this._fetch(`/search?${params}`);
    return result?.results || [];
  }

  /**
   * Get a specific node by ID.
   * @param {string} id — node ID (path relative to vault, e.g. "research/AI Prompts")
   */
  async get(id) {
    return await this._fetch(`/node/${encodeURIComponent(id)}`);
  }

  /**
   * Get all nodes of a given type.
   * Types: 'memory' | 'research' | 'task' | 'insight' | 'decision' | 'note'
   */
  async byType(type) {
    const result = await this._fetch(`/type/${type}`);
    return result?.nodes || [];
  }

  /**
   * Get all nodes with a given tag.
   */
  async byTag(tag) {
    const result = await this._fetch(`/tag/${encodeURIComponent(tag)}`);
    return result?.nodes || [];
  }

  /**
   * Get all memories stored by a specific agent.
   */
  async myMemories(agentName) {
    const name   = agentName || this.agentName;
    const result = await this._fetch(`/agent/${encodeURIComponent(name)}`);
    return result?.nodes || [];
  }

  /**
   * Get the full graph as an adjacency map.
   * Useful for agents that need to reason about the whole knowledge structure.
   */
  async graph() {
    return await this._fetch('/graph');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  WRITE METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 🧠 remember — Write a memory to the second brain.
   *
   * Call this after completing a task, making a discovery, or reaching a decision.
   * The memory is stored as a real .md file in the vault — visible in Obsidian.
   *
   * @param {string} content — The knowledge to store (markdown supported)
   * @param {{ title, type, tags, subdir }} options
   *
   * Types: 'memory' | 'research' | 'task' | 'insight' | 'decision' | 'note'
   *
   * Example:
   *   await brain.remember(
   *     'Reddit r/productivity has 2M+ members asking about AI tools',
   *     { title: 'Research: AI Tools Reddit Demand', type: 'research', tags: ['ai', 'research'] }
   *   );
   */
  async remember(content, options = {}) {
    const node = {
      title:   options.title   || `Memory — ${new Date().toLocaleDateString()}`,
      content: typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      type:    options.type    || 'memory',
      tags:    options.tags    || [],
      agent:   this.agentName,
      subdir:  options.subdir  || `agents/${this.agentName}`,
    };
    const result = await this._fetch('/remember', {
      method: 'POST',
      body:   JSON.stringify(node),
    });
    if (result?.success) this._log(`📝 Remembered: "${node.title}"`);
    return result;
  }

  /**
   * Update an existing node. Supports Optimistic Concurrency Control (OCC)
   * by passing a `version` property in the patch payload.
   *
   * @param {string} id    — node ID
   * @param {object} patch — { title?, content?, type?, tags?, version? }
   */
  async update(id, patch) {
    return await this._fetch(`/node/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body:   JSON.stringify(patch),
    });
  }

  /**
   * Delete a node from the vault.
   */
  async forget(id) {
    const result = await this._fetch(`/node/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (result?.success) this._log(`🗑️ Forgotten: ${id}`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PROMPT HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build a complete, token-efficient system prompt for an AI call.
   * Retrieves relevant context from the brain and prepends it.
   *
   * @param {string} topic       — What this AI call is about
   * @param {string} basePrompt  — Your original system prompt
   * @param {number} hops        — Graph traversal depth (default 1)
   * @returns {string} Combined system prompt with brain context prepended
   *
   * Example:
   *   const systemPrompt = await brain.smartPrompt('write product ebook', MY_SYSTEM_PROMPT);
   *   // Now systemPrompt has ~500 tokens of relevant context + your prompt
   */
  async smartPrompt(topic, basePrompt = '', hops = 1) {
    const ctx = await this.recall(topic, hops, 1500);
    if (!ctx.systemPrompt) return basePrompt;
    return [
      '<!-- SECOND BRAIN CONTEXT -->',
      ctx.systemPrompt,
      `<!-- end context: ${ctx.nodeCount} nodes, ~${ctx.tokenEstimate} tokens -->`,
      '',
      basePrompt,
    ].join('\n');
  }

  /**
   * Wrap any async function with automatic memory logging.
   * The agent's result is saved to the brain automatically.
   *
   * @param {string}   taskName — Human-readable task name
   * @param {Function} fn       — Async function to run
   * @param {object}   options  — { type, tags, summarize }
   *
   * Example:
   *   const research = await brain.withMemory('Research: AI Tools', doResearch);
   */
  async withMemory(taskName, fn, options = {}) {
    const start = Date.now();
    let result, error;
    try {
      result = await fn();
    } catch (e) {
      error = e;
      await this.remember(
        `## ${taskName} — FAILED\n\n**Error:** ${e.message}\n**Time:** ${new Date().toISOString()}`,
        { title: `❌ ${taskName}`, type: 'decision', tags: ['error', 'failed'] }
      );
      throw e;
    }

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    const summary  = options.summarize
      ? options.summarize(result)
      : typeof result === 'string'
        ? result.slice(0, 500)
        : JSON.stringify(result, null, 2).slice(0, 500);

    await this.remember(
      `## ${taskName}\n\n**Status:** ✅ Completed\n**Duration:** ${duration}s\n\n${summary}`,
      {
        title: `✅ ${taskName} — ${new Date().toLocaleDateString()}`,
        type:  options.type || 'memory',
        tags:  options.tags || ['completed'],
      }
    );
    return result;
  }
}

// ── Singleton export for convenience ─────────────────────────────────────────
export const brain = new SecondBrain({ agent: 'default' });
export default SecondBrain;
