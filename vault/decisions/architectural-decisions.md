---
type: decision
tags: [architecture, design-patterns]
agent: system
createdAt: 2026-06-18
---
# 🏛️ Decision: Zero-Dependency Backend

Documenting why this codebase uses 100% native Node.js libraries.

## Context
Standardizing agent tools often introduces massive dependency chains (e.g. LangChain, LangGraph).

## Decision
Build the indexing, graph traversal, and HTTP SSE layer using pure Node.js standard libraries (`http`, `https`, `fs`, `path`).

## Consequences
- ⚡ Sub-millisecond startup times.
- 🔒 Maximum security (no vulnerability exploits from supply chain attacks).
- 🧩 Portable across any environment running Node 18+.

#architecture #design #decisions
