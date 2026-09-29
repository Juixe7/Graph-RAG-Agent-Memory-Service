/**
 * ══════════════════════════════════════════════════════════════
 *  Migration 001 — Assign real department leads
 *
 *  Sets `reportsTo` on department members for any department whose
 *  members' titles carry EXACTLY ONE unambiguous leadership signal (e.g.
 *  "Research Lead" surrounded by individual-contributor titles).
 *  Departments with zero or several competing signal titles are left
 *  alone — sdk/org_chart.js's findExplicitLead() then reports no lead for
 *  those, which is the honest state: there is no real basis to promote one
 *  member over another among equals.
 *
 *  Idempotent: never touches a persona that already has `reportsTo` set,
 *  so re-running after adding new personas is always safe, and a manual
 *  override always sticks.
 *
 *  Run: node migrations/001-assign-department-leads.mjs
 * ══════════════════════════════════════════════════════════════
 */
import { fileURLToPath } from 'url';
import { loadVault, updateNodeFile } from '../api/brain_engine.js';
import { groupByDepartment } from '../sdk/org_chart.js';

const LEAD_KEYWORDS = /\b(lead|director|head|chief|principal|senior|manager|vp|president|architect)\b/i;

export async function run() {
  const nodes = loadVault();
  const agents = Object.values(nodes).filter(n => n.type === 'agent');
  const groups = groupByDepartment(agents);

  let assigned = 0;
  for (const [dept, members] of Object.entries(groups)) {
    const candidates = members.filter(m => LEAD_KEYWORDS.test(m.title));
    if (candidates.length !== 1) continue;
    const lead = candidates[0];

    let deptAssigned = 0;
    for (const member of members) {
      if (member.id === lead.id) continue;
      if (member.reportsTo) continue; // never clobber an existing explicit curation
      updateNodeFile(member.filePath, { meta: { reportsTo: lead.title } });
      assigned++;
      deptAssigned++;
    }
    if (deptAssigned) console.log(`[migration-001] ${dept}: "${lead.title}" is now lead of ${deptAssigned} member(s).`);
  }
  console.log(`[migration-001] Done. ${assigned} persona file(s) updated.`);
  return assigned;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
