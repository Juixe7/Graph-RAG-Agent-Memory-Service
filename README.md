# 🧠 Autonomous Agent Second Brain — Graph-RAG Memory Core

[![GitHub License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-success.svg)](package.json)
[![Platform](https://img.shields.io/badge/platform-node.js%20%3E%3D%2022.5-orange.svg)](package.json)
[![Tests](https://img.shields.io/badge/tests-node%3A--test-blue.svg)](test)

A **zero-dependency, offline-first Graph-RAG memory system** that enables autonomous AI agents to share long-term memories, accumulate research, and coordinate workflows.

Designed to operate natively as an **Obsidian Vault** on the filesystem and exposed as a clean REST API and Javascript SDK. By representing memories as interconnected nodes (`[[wikilinks]]`) and fusing **graph traversal, keyword search, optional semantic similarity, and recency** into one ranked signal, it filters and delivers targeted context to LLMs, reducing typical agent input sizes by **95–99%** compared to reading entire codebases or directories.

![Graph Visualizer Live Demo](assets/visualizer_demo.webp)

---

## 🚀 Why This Project Stands Out (Portfolio Highlights)

This project showcases several advanced backend engineering principles and data modeling architectures:

*   **Zero-Dependency Node.js Backend:** Built using pure native Node.js ES Modules (`http`, `fs`, `path`, `child_process`, `node:sqlite`, `node:test`). Instantly boots in milliseconds, is highly secure against dependency vulnerability chains, and is extremely portable. Every capability added since 1.0 — semantic search, dedup, task queue, messaging, sandboxed execution — follows the same rule: no required npm dependency, ever. An optional one (a cloud embedding key, Docker, `@huggingface/transformers`) simply degrades gracefully to "unavailable" when absent, never a crash.
*   **Graph-RAG vs. Flat-RAG:** Flat RAG systems (using simple vector similarity) yield disconnected text chunks that lose context. This engine parses Obsidian-style wikilinks (`[[Page Name]]`) to build an adjacency map, tracing logical connections between ideas.
*   **Hybrid Search via Reciprocal Rank Fusion:** `/search` and `/recall` fuse a keyword arm (the original cached TF-IDF engine, untouched) with an optional semantic-similarity arm (cosine similarity over cached embeddings) using Reciprocal Rank Fusion — the same rank-based merge technique used to combine independent, non-comparable ranking signals without normalizing raw scores across them. With no embedding provider configured, this is provably identical to the original keyword-only behavior: the semantic arm short-circuits to empty and the fused result falls back to exactly what plain TF-IDF would return.
*   **Token Economics (Optimized Context):** Rather than feeding raw file structures (~50k tokens) or arbitrary chunks into LLM context windows, agents query `/recall` to receive a pre-assembled context payload restricted to a custom token budget (~300–2,000 tokens), preventing model attention degradation.
*   **Native File System Hot-Reloading (`fs.watch()`):** Automatically invalidates and refreshes the memory index in real time when files are edited (either manually in Obsidian or programmatically via the API). Built using native file system events with a debounce timer to sustain sub-millisecond query performance.
*   **Cached TF-IDF Search Engine Optimization:** To achieve sub-millisecond search latency, the backend pre-tokenizes vault contents and pre-calculates inverse document frequencies (IDF) and vector magnitudes during graph cache loading, eliminating O(N) tokenization and regex parsing on every search.
*   **SQLite-Backed Semantic Embeddings:** Optional per-node vector storage via `node:sqlite` (built into Node ≥22.5, no install, no native compile step) — real indexed per-row reads/writes and actual transactions, instead of a single ever-growing JSON blob. Multi-provider fetch (OpenAI, Gemini) with an optional local-model last resort, so semantic search never goes fully dark just because a cloud key ran out of quota.
*   **Optimistic Concurrency Control (OCC):** Prevents concurrent write overrides. Nodes contain a `version` property in YAML frontmatter that increments on actual updates. `PATCH` calls require the matching `version`, failing with `409 Conflict` if modified concurrently.
*   **Strict Node Schema Validation:** Validates incoming payloads (`title` filename characters, `type` enums, `importance` bounds, and `tags` format) before writing files to disk, ensuring strict memory bank integrity.
*   **Granular Read & Write Authentication Security:** When `BRAIN_KEY` is configured, Bearer Token authentication is enforced across all endpoints—including search, recall, and graph views. The telemetry stream endpoint (`/stream`) requires a matching `?token=` parameter to block raw data exposure on public URLs.
*   **PII & Secrets Safeguard:** `sdk/safeguard.js` is a standalone regex-based redaction utility (API keys across ~20 providers, DB connection strings, PEM private keys, JWTs, SSNs, Luhn-checked credit card numbers) any code path in the project can call before logging, storing, or echoing text back.
*   **Near-Duplicate Memory Reconciliation:** `sdk/dedup.js` gates candidates with a cheap embedding-similarity check, then asks an LLM judge whether two similar notes are truly the same fact (merge, preserving every detail) or materially different (keep both). Fails open on any error — a dedup failure never blocks a normal memory write. `POST /dedup/scan` reports candidates vault-wide without ever auto-merging.
*   **Multi-Agent Coordination Primitives:** A vault-backed task queue (status tags, dependency-based blocking/cascading release) and agent-to-agent messenger (inbox/outbox as vault nodes), plus an org chart derived read-only from persona tags/frontmatter already in the vault. These are lightweight coordination primitives — a shared, auditable, markdown-backed task list and inbox — not a full autonomous orchestrator; something else still has to watch `pending` tasks and do the work.
*   **Sandboxed Code Execution:** `POST /sandbox/execute` prefers a network-disabled, memory-capped, auto-removed Docker container when Docker is available, and falls back to a restricted local child process (keyword blacklist, hard timeout) when it isn't — never a required dependency either way.
*   **Resilient, Path-Scoped Git Sync:** `sdk/git_sync.js` replaces a naive "stage the whole vault folder" auto-commit with one that stages only the files a caller says actually changed (so an unrelated in-flight edit never gets swept into someone else's commit) and serializes/queues concurrent writes instead of racing on `.git/index.lock`.
*   **Unified Multi-Provider LLM Router:** `sdk/llm_router.js` calls Anthropic, OpenAI-compatible, Gemini, NVIDIA NIM, or local Ollama behind one interface, falling through a configurable priority chain on any failure, and repairs the most common way smaller models emit almost-valid JSON (unescaped control characters inside a string).
*   **MCP Server & CLI:** `mcp/server.js` is a zero-dependency, stdio JSON-RPC MCP server exposing this REST API as MCP tools to any MCP-aware client, auto-spawning the API server if it isn't already running. `sdk/cli.js` (`npm run brain -- <command>`) wraps the same API for quick terminal use.
*   **Interactive Agent Simulator UI:** Features a premium sidebar form in the dashboard where you can simulate multi-agent memory writes, watching the nodes, links, and EventSource telemetry update dynamically in the D3.js visualization — now alongside a second **Org Chart** tab built with vendored Preact + htm (see [UI Architecture](#-ui-architecture)).
*   **Human-Agent-in-the-Loop Coordination:** Because memories are serialized as plain Markdown files (`.md`) with YAML frontmatter, a human can open the same folder in Obsidian to audit agent reasoning, edit notes, or add guidelines directly into the graph.
*   **Test Suite & CI:** A `node:test`-based suite (no test framework dependency either) covers every module above, isolating side effects via temp directories, mocked `fetch`, and env-var overrides. GitHub Actions runs it across Node 22.x/24.x on every push/PR to `main`, plus a syntax sweep over every file in `api/`, `sdk/`, `mcp/`.

---

## ⚙️ Technical Architecture

```mermaid
graph TD
    subgraph Client Environments
        Agent1[Research Agent] -->|SDK: remember/recall| API[🧠 Second Brain REST API]
        Agent2[Pipeline Agent] -->|SDK: remember/recall| API
        Human[Human Operator] -->|Edits Notes| Obs[Obsidian Editor]
        MCPClient[MCP-aware Client] -->|stdio JSON-RPC| MCP[mcp/server.js]
        CLI[sdk/cli.js] -->|REST| API
        MCP -->|auto-spawns / proxies| API
    end

    subgraph API Server
        API --> Engine[Graph Engine]
        Engine --> Search[Hybrid Search: TF-IDF + Semantic RRF]
        Engine --> Cache[In-Memory Graph Cache]
        Engine --> FS[Local FS Watcher]
        API --> Tasks[Task Queue]
        API --> Msg[Messenger]
        API --> Org[Org Chart]
        API --> Dedup[Dedup Scan]
        API --> Sandbox[Sandboxed Execution]
    end

    subgraph Storage Layer
        FS -->|Reads/Writes| Vault[(Markdown Vault)]
        Search -->|Vectors| EmbedDB[(SQLite: .embeddings.db)]
        Obs -->|Reads/Writes| Vault
        Engine -->|Optional Async Sync| Git[Path-Scoped Git Sync]
    end

    subgraph LLM Layer
        Dedup --> Router[LLM Router: Anthropic / OpenAI / Gemini / NVIDIA / Ollama]
    end

    Git -->|Auto Commit & Push| GitHub[Private GitHub Repo]
```

---

## 🎨 UI Architecture

The project contains a dynamic, high-tech dashboard with two tabs:

*   **Graph tab (original):** built with **D3.js (v7)** and **Marked.js**. Force-directed graph simulation (nodes sized by link degree, colored by type), an interactive context panel for reading a node's markdown and navigating its outlinks/backlinks, and live filters + live reload via `/reload`.
*   **Org Chart tab (new):** built with **vendored Preact + htm** (`ui/preact.min.js`, `ui/htm.min.js` — local files, no CDN, no build step). `htm.bind(preact.h)` turns a plain tagged template into the same VNode tree JSX would, rendered via `preact.render` as a real component tree (`OrgMember`, `DepartmentCard`, `OrgChartView`) fetching `GET /org-chart`. This is the **recommended pattern for any new view added to this file going forward** — the rest of `ui/index.html` (the Graph tab) intentionally stays vanilla JS/innerHTML rather than being retroactively rewritten.

---

## 📡 REST API & Interface Directory

| Method | Endpoint | Payload / Query | Description |
|---|---|---|---|
| **GET** | `/health` | — | Returns server stats, port, and vault nodes/edges volume. |
| **GET** | `/nodes` | — | Gets list of all index nodes with trimmed previews. |
| **GET** | `/node/:id` | — | Gets specific note body, parsed outgoing links, and incoming backlinks. |
| **GET** | `/search` | `?q=query&limit=10` | Hybrid keyword + semantic search (Reciprocal Rank Fusion), fused with the original TF-IDF ranking. |
| **GET** | `/recall` | `?q=query&hops=1` | **Core Agent Context:** graph context assembler within a token budget, seeded by hybrid search. |
| **GET** | `/graph` | — | Returns complete adjacency map nodes and edges. |
| **POST** | `/remember` | `{title, content, type, agent}` | Commits a new markdown node into the vault directory. |
| **PATCH** | `/node/:id` | `{title, content, type, tags}` | Modifies an existing file's text content or YAML frontmatter metadata (OCC via `version`). |
| **DELETE**| `/node/:id` | — | Deletes a note from the disk. |
| **POST** | `/tasks/submit` | `{prompt, agents, priority, dependencies}` | Submits a task to the vault-backed task queue. |
| **GET** | `/tasks` | `?status=pending` | Lists tasks, optionally filtered by status tag. |
| **PATCH** | `/tasks/:id` | `{status, content}` | Updates a task's status; auto-releases/cascades dependents. |
| **POST** | `/messages/send` | `{fromAgent, toAgent, content, subject}` | Sends an agent-to-agent message. |
| **GET** | `/messages/:agent` | `?unread=false` | Reads an agent's inbox. |
| **GET** | `/org-chart` | — | Department/lead structure derived from persona tags & frontmatter. |
| **POST** | `/dedup/scan` | `{dryRun, judge}` | Reports near-duplicate node candidates; never auto-merges. |
| **POST** | `/sandbox/execute` | `{code, language, timeoutMs}` | Runs a code snippet sandboxed (Docker, or a restricted local fallback). |
| **POST** | `/embeddings/reindex` | `{}` | (Re)computes semantic vectors for the vault in the background. |
| **GET** | `/export` | — | Full JSON export. |
| **POST** | `/reload` | — | Refreshes the in-memory cache manually. |

---

## 📦 SDK Quick Start & Code Quality

The Client SDK is written in clean, modern Javascript using native `fetch`.

```javascript
import { SecondBrain } from './sdk/index.js';

// Initialize Client (Reads optional BRAIN_API & BRAIN_KEY env variables)
const brain = new SecondBrain({
  agent: 'pipeline-agent',
  api: 'http://localhost:3747',
  apiKey: process.env.BRAIN_KEY
});

/**
 * Workflow Scenario: Context Recall -> Task Execution -> Memory Write
 */
async function runAutoPipeline() {
  // 1. Fetch relevant context within 1 Graph Hop and 1500 token budget
  const context = await brain.recall('API rate limiting design', 1, 1500);
  
  // 2. Inject context directly into your LLM prompt
  const llmPrompt = `
    ${context.systemPrompt}
    
    Task: Design rate limiter middleware for backend services.
  `;
  const result = await myLlmClient.generate(llmPrompt);
  
  // 3. Save learnings back to the shared memory bank for other agents
  await brain.remember(result, {
    title: 'Rate Limiting Middleware Specification',
    type: 'research',
    tags: ['infrastructure', 'security', 'rate-limit']
  });
}
```

### CLI

```bash
npm run brain -- status
npm run brain -- recall "API rate limiting design"
npm run brain -- tasks submit "Investigate rate limiting approaches" --agents=pipeline-agent
npm run brain -- org-chart
```

### MCP Server

`mcp/server.js` is a zero-dependency, stdio JSON-RPC MCP server exposing this repo's REST API as MCP tools (`brain_recall`, `brain_remember`, `brain_search`, `brain_node_get`, `brain_tasks_submit`, `brain_tasks_list`, `brain_messages_send`, `brain_messages_get`, `brain_health`). It auto-spawns `api/server.js` on first tool call if the API isn't already running, so an MCP client only needs to point at `node mcp/server.js` — no separate server-start step. Configure it in an MCP-aware client the same way you'd configure any other stdio MCP server, pointing its command at `node mcp/server.js` from this repo's root (set `BRAIN_KEY`/`BRAIN_PORT` in its environment if your instance uses them).

---

## 🔒 Security & Authentication Setup

By default, the server runs in local/development mode with authentication disabled. For cloud deployments, multi-agent networks, or when exposing the REST API endpoints publicly, you should enforce Bearer Token authentication:

1. **Set the Secret Key:**
   Define the `BRAIN_KEY` environment variable on your system or server:
   ```bash
   export BRAIN_KEY="your-highly-secure-secret-token"
   ```
2. **Enforced Protection:**
   Once `BRAIN_KEY` is set, all mutative endpoints (`POST /remember`, `POST /reload`, `POST /consolidate`, `PATCH /node/:id`, `DELETE /node/:id`, the task/message/dedup/sandbox endpoints, etc.) will block unauthorized requests and return `401 Unauthorized`.
3. **Authorization Header:**
   Incoming requests must include the token in the `Authorization` header:
   ```http
   Authorization: Bearer your-highly-secure-secret-token
   ```
4. **Client SDK Configuration:**
   When initializing the Javascript client SDK, inject the token using the `apiKey` configuration option:
   ```javascript
   const brain = new SecondBrain({
     api: 'http://localhost:3747',
     apiKey: process.env.BRAIN_KEY // Or pass the token directly
   });
   ```
5. **PII/Secrets Safeguard:** `sdk/safeguard.js`'s `sanitizeContent()` is available for any code path (custom endpoints, ingestion pipelines, logging) that wants to redact API keys, DB URLs, PEM keys, JWTs, SSNs, or credit card numbers before persisting or echoing text.

---

## 🧩 Optional Capabilities (Graceful Degradation)

Every capability below is additive and opt-in — with none of it configured, the server behaves exactly as a plain zero-dependency TF-IDF/graph memory store, which remains the default.

| Capability | Enable by setting | Behavior when unset |
|---|---|---|
| Semantic search arm, dedup similarity gate | `OPENAI_API_KEY` and/or `GEMINI_API_KEY` (or install `@huggingface/transformers` for a local last-resort model) | Semantic arm returns no candidates; search/recall are identical to keyword-only TF-IDF. |
| LLM-judged dedup, LLM router calls | Any of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`/`OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, or a local Ollama at `OLLAMA_HOST` | Falls through the provider chain to Ollama; if nothing is reachable, the caller (e.g. the dedup judge) fails open. |
| Sandboxed execution via Docker | A running Docker daemon | Falls back to a restricted local child process with a keyword blacklist. |
| Auto git sync | `AUTO_GIT_SYNC=true` | No-op; nothing is committed or pushed. |

### Environment Settings

| Variable | Description | Default |
|---|---|---|
| `BRAIN_PORT` | The port the REST API listens on. | `3747` |
| `BRAIN_KEY` | Optional. If set, mutative endpoints require a matching bearer token. | `""` |
| `AUTO_GIT_SYNC` | Optional. If `true`, the server commits & pushes modifications to GitHub (path-scoped, serialized — see `sdk/git_sync.js`). | `false` |
| `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional. Enables the semantic search/dedup embeddings arm. | unset |
| `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `NVIDIA_API_KEY` / `OLLAMA_HOST` | Optional. Configures the LLM router's provider chain (`sdk/models_config.js`). | unset / `http://localhost:11434` |
| `LLM_PROVIDER_ORDER` | Optional. Overrides the router's fallback priority order. | `anthropic,nvidia,gemini,openai,ollama` |

---

## 🛠️ Configuration & Setup

### Requirements
*   Node.js (**>= 22.5.0** — `sdk/embeddings.js` uses the built-in `node:sqlite` module, available starting there)
*   Web Browser (for Visualizer UI)

### Installation
Clone the repository:
```bash
git clone https://github.com/ara-5/mind-mri-agent-second-brain.git
cd mind-mri-agent-second-brain
```

### Start Server
```bash
# Production start
npm start

# Development watch mode
npm run dev
```

### Launch Visualizer UI
```bash
npm run ui
```
*(Runs a cross-platform command to open `ui/index.html` in your default browser)*

### Run Tests
```bash
npm test
```
Runs the full `node:test` suite (`test/*.test.js`) — no test framework dependency, isolates side effects via temp directories, mocked `fetch`, and env-var overrides. CI (`.github/workflows/ci.yml`) runs this across Node 22.x/24.x on every push/PR to `main`.

### Vault Migrations
See `migrations/README.md` for the one-file-per-migration, idempotent, never-fabricate-data convention, and `migrations/001-assign-department-leads.mjs` for the first real migration (assigns org-chart leads from unambiguous persona-title keywords).
