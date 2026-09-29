# Vault migrations

The vault's markdown frontmatter schema grows organically (`department`,
`reportsTo`, and whatever comes next) — this directory is where a one-off
change to *existing* data gets written down as a script instead of a
throwaway one-liner nobody can find again.

## Convention

- One file per migration: `NNN-short-description.mjs`, numbered in the
  order they were written (not necessarily the order you'll run them —
  most are safe to run any time, see each file's own header).
- **Idempotent.** Running a migration twice must be a safe no-op the
  second time (check before writing, don't blindly overwrite). Every
  migration here does this by skipping any node that already has the
  field it would set.
- **Read from and write to the real vault directly** via
  `api/brain_engine.js`'s `loadVault`/`updateNodeFile` — point `BRAIN_VAULT`
  at a copy first if you want to dry-run against a scratch copy.
- **Never fabricate data.** A migration that can't find a real, verifiable
  signal for a value should skip that record rather than guess — see
  `001-assign-department-leads.mjs`'s docstring for a concrete example of
  this being the whole point of the migration.
- Run with `node migrations/NNN-*.mjs` from the project root.

## Migrations

- **001-assign-department-leads.mjs** — sets `reportsTo` on department
  members for any department whose title set has exactly one unambiguous
  leadership-signal title (e.g. "Research Lead" in a Research department
  otherwise made of individual-contributor titles). Re-run after adding new
  agent personas — departments that were ambiguous before might not be
  anymore, and it will never touch a persona that already has `reportsTo`
  set (so a manual override always sticks). Pairs with `sdk/org_chart.js`
  and the `GET /org-chart` endpoint.

- **002-json-embeddings-to-sqlite.mjs — not applicable here.** In the
  private codebase this was ported from, this slot was a one-time import of
  a pre-existing `.embeddings.json` (an older storage format) into the
  current `.embeddings.db` (`node:sqlite`, see `sdk/embeddings.js`). This
  public repo has no prior JSON-embeddings format to migrate from — its
  embeddings store has always been SQLite — so there is nothing to port.
  If a future storage-format change ever needs a real migration here, it
  would take this slot.
