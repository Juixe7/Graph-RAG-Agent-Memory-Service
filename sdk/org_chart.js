/**
 * ══════════════════════════════════════════════════════════════
 *  SECOND BRAIN — Org Chart
 *
 *  Turns existing agent persona tags/frontmatter into a lightweight
 *  organizational structure: agents grouped into departments derived
 *  from their existing category tag (e.g. tags: [agent, persona,
 *  marketing] -> "Marketing") — no manual backfill of every persona
 *  file needed. A persona can still be explicitly curated with a
 *  `department` and/or `reportsTo` frontmatter field, which always
 *  wins over the tag-derived guess.
 *
 *  This is a lightweight coordination/visualization primitive — a
 *  read-only view derived from data already in the vault — not a
 *  budget/governance/multi-tenant system.
 * ══════════════════════════════════════════════════════════════
 */

// The category tag most persona files carry — several raw tags map to the
// same human-readable department.
const DEPARTMENT_TAGS = new Map([
  ['engineering', 'Engineering'],
  ['frontend', 'Engineering'],
  ['backend', 'Engineering'],
  ['devops', 'Engineering'],
  ['marketing', 'Marketing'],
  ['paid-media', 'Marketing'],
  ['design', 'Design'],
  ['security', 'Security'],
  ['sales', 'Sales'],
  ['testing', 'QA'],
  ['qa', 'QA'],
  ['project-management', 'Project Management'],
  ['management', 'Project Management'],
  ['coordination', 'Project Management'],
  ['product', 'Product'],
  ['finance', 'Finance'],
  ['support', 'Support'],
  ['playbooks', 'Operations'],
  ['runbooks', 'Operations'],
  ['research', 'Research'],
  ['academic', 'Research'],
  ['strategy', 'Strategy'],
]);

/**
 * Derive a persona's department: an explicit `department` frontmatter
 * field always wins; otherwise the first tag that maps to a known
 * department; otherwise 'General'.
 */
export function deriveDepartment(node) {
  if (node.department) return node.department;
  for (const tag of node.tags || []) {
    const dept = DEPARTMENT_TAGS.get(tag);
    if (dept) return dept;
  }
  return 'General';
}

/**
 * Build a department's reporting tree from `reportsTo` (by title,
 * case-insensitive): who's at the top level (no manager within this same
 * department — an unresolvable or cross-department reportsTo is treated
 * the same as having none) and, for anyone with reports, the list of their
 * direct reports. Shared by buildOrgChart (display) and findExplicitLead
 * (delegation) so both agree on the exact same hierarchy.
 */
function buildDepartmentHierarchy(members) {
  const byTitleLower = new Map(members.map(m => [m.title.toLowerCase(), m]));
  const childrenOf = new Map();
  const topLevel = [];

  for (const member of members) {
    const managerTitle = member.reportsTo ? member.reportsTo.toLowerCase() : null;
    const manager = managerTitle && managerTitle !== member.title.toLowerCase()
      ? byTitleLower.get(managerTitle)
      : null;
    if (manager) {
      if (!childrenOf.has(manager.id)) childrenOf.set(manager.id, []);
      childrenOf.get(manager.id).push(member);
    } else {
      topLevel.push(member);
    }
  }
  return { topLevel, childrenOf };
}

// A cycle (A reportsTo B, B reportsTo A) can't happen via buildDepartmentHierarchy's
// topLevel/childrenOf split for the pair itself, but a longer cycle among
// non-top-level members is possible in principle; `seen` bounds the
// recursion so a malformed reportsTo chain degrades to an undercount
// rather than an infinite loop.
function countDescendants(memberId, childrenOf, seen = new Set()) {
  if (seen.has(memberId)) return 0;
  seen.add(memberId);
  const children = childrenOf.get(memberId) || [];
  let count = children.length;
  for (const child of children) count += countDescendants(child.id, childrenOf, seen);
  return count;
}

/**
 * Find a department's real lead: the top-of-chain member (reports to
 * nobody else in the department) with the largest total team beneath them
 * — not just whoever happens to have the most DIRECT reports, which could
 * be a mid-level manager rather than the person actually at the top.
 * Returns null if nobody in this department has an explicit report.
 */
export function findExplicitLead(members) {
  const { topLevel, childrenOf } = buildDepartmentHierarchy(members);
  const candidates = topLevel.filter(m => (childrenOf.get(m.id) || []).length > 0);
  if (!candidates.length) return null;

  let best = null, bestCount = -1;
  for (const m of candidates) {
    const count = countDescendants(m.id, childrenOf);
    if (count > bestCount) { bestCount = count; best = m; }
  }
  return best;
}

/**
 * Group a flat list of agent entries (as returned by GET /type/agent) by
 * derived department.
 * @returns {Record<string, object[]>}
 */
export function groupByDepartment(agentEntries) {
  const groups = {};
  for (const entry of agentEntries) {
    const dept = deriveDepartment(entry);
    (groups[dept] ||= []).push(entry);
  }
  return groups;
}

/**
 * Build the full org-chart tree: one branch per department, and within
 * each department a flat list of members unless a member explicitly
 * `reportsTo` another member of the SAME department (by title,
 * case-insensitive) — in which case they nest under that lead instead.
 * Cross-department reportsTo and unresolvable names are ignored (the
 * member stays at the department's top level) rather than silently
 * dropped or mis-nested.
 */
export function buildOrgChart(agentEntries) {
  const groups = groupByDepartment(agentEntries);

  const departments = Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([department, members]) => {
      const { topLevel, childrenOf } = buildDepartmentHierarchy(members);

      const toNode = (m) => ({
        id: m.id,
        title: m.title,
        tags: m.tags,
        reports: (childrenOf.get(m.id) || []).map(toNode),
      });

      return {
        department,
        memberCount: members.length,
        members: topLevel.map(toNode),
      };
    });

  return {
    root: { name: 'Coordinator', role: 'Coordinator' },
    departmentCount: departments.length,
    departments,
  };
}
