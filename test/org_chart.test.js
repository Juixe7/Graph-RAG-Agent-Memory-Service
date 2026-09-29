import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveDepartment, groupByDepartment, buildOrgChart, findExplicitLead } from '../sdk/org_chart.js';

// ── deriveDepartment ──────────────────────────────────────────────────────

test('deriveDepartment prefers an explicit department override over tags', () => {
  const node = { department: 'Custom Team', tags: ['agent', 'persona', 'engineering'] };
  assert.equal(deriveDepartment(node), 'Custom Team');
});

test('deriveDepartment maps a known category tag to its department', () => {
  const node = { tags: ['agent', 'persona', 'marketing'] };
  assert.equal(deriveDepartment(node), 'Marketing');
});

test('deriveDepartment falls back to General when no tag matches a known department', () => {
  const node = { tags: ['agent', 'persona', 'specialized'] };
  assert.equal(deriveDepartment(node), 'General');
});

// ── groupByDepartment ─────────────────────────────────────────────────────

test('groupByDepartment buckets entries by derived department', () => {
  const entries = [
    { id: 'a', title: 'A', tags: ['engineering'] },
    { id: 'b', title: 'B', tags: ['marketing'] },
    { id: 'c', title: 'C', tags: ['engineering'] },
  ];
  const groups = groupByDepartment(entries);
  assert.equal(groups.Engineering.length, 2);
  assert.equal(groups.Marketing.length, 1);
});

// ── buildOrgChart ─────────────────────────────────────────────────────────

test('buildOrgChart nests a member under their same-department manager via reportsTo', () => {
  const entries = [
    { id: 'lead', title: 'Engineering Lead', tags: ['engineering'], reportsTo: null },
    { id: 'ic',   title: 'Backend Developer', tags: ['engineering'], reportsTo: 'Engineering Lead' },
  ];
  const chart = buildOrgChart(entries);
  const eng = chart.departments.find(d => d.department === 'Engineering');
  assert.equal(eng.members.length, 1, 'only the lead is top-level');
  assert.equal(eng.members[0].title, 'Engineering Lead');
  assert.equal(eng.members[0].reports.length, 1);
  assert.equal(eng.members[0].reports[0].title, 'Backend Developer');
});

test('buildOrgChart ignores a reportsTo pointing outside the department', () => {
  const entries = [
    { id: 'a', title: 'Marketer', tags: ['marketing'], reportsTo: 'Engineering Lead' },
    { id: 'b', title: 'Engineering Lead', tags: ['engineering'], reportsTo: null },
  ];
  const chart = buildOrgChart(entries);
  const marketing = chart.departments.find(d => d.department === 'Marketing');
  assert.equal(marketing.members.length, 1, 'cross-department reportsTo is ignored, member stays top-level');
  assert.equal(marketing.members[0].reports.length, 0);
});

// ── findExplicitLead ──────────────────────────────────────────────────────

test('findExplicitLead returns the member others explicitly report to', () => {
  const members = [
    { id: 'lead', title: 'Engineering Lead', reportsTo: null },
    { id: 'a', title: 'Backend Dev', reportsTo: 'Engineering Lead' },
    { id: 'b', title: 'Frontend Dev', reportsTo: 'Engineering Lead' },
  ];
  const lead = findExplicitLead(members);
  assert.equal(lead.id, 'lead');
});

test('findExplicitLead returns null when nobody has an explicit reportsTo', () => {
  const members = [
    { id: 'a', title: 'A', reportsTo: null },
    { id: 'b', title: 'B', reportsTo: null },
  ];
  assert.equal(findExplicitLead(members), null);
});

test('findExplicitLead ignores an unresolvable or self-referential reportsTo', () => {
  const members = [
    { id: 'a', title: 'A', reportsTo: 'Nonexistent Person' },
    { id: 'b', title: 'B', reportsTo: 'B' },
  ];
  assert.equal(findExplicitLead(members), null);
});

test('findExplicitLead picks the member with the most direct reports', () => {
  const members = [
    { id: 'popular', title: 'Popular Lead', reportsTo: null },
    { id: 'quiet', title: 'Quiet Lead', reportsTo: null },
    { id: 'a', title: 'A', reportsTo: 'Popular Lead' },
    { id: 'b', title: 'B', reportsTo: 'Popular Lead' },
    { id: 'c', title: 'C', reportsTo: 'Quiet Lead' },
  ];
  assert.equal(findExplicitLead(members).id, 'popular');
});

test('findExplicitLead picks the true top of a multi-level chain, not a mid-level manager with more direct reports', () => {
  // VP has only 1 direct report (the Team Lead), but the whole team of 4
  // sits beneath them — they should win over the Team Lead, who has 3
  // direct reports but is themselves managed by the VP.
  const members = [
    { id: 'vp', title: 'VP Engineering', reportsTo: null },
    { id: 'teamlead', title: 'Team Lead', reportsTo: 'VP Engineering' },
    { id: 'a', title: 'Dev A', reportsTo: 'Team Lead' },
    { id: 'b', title: 'Dev B', reportsTo: 'Team Lead' },
    { id: 'c', title: 'Dev C', reportsTo: 'Team Lead' },
  ];
  assert.equal(findExplicitLead(members).id, 'vp');
});

test('buildOrgChart leaves everyone top-level when no reportsTo is set', () => {
  const entries = [
    { id: 'a', title: 'A', tags: ['sales'] },
    { id: 'b', title: 'B', tags: ['sales'] },
  ];
  const chart = buildOrgChart(entries);
  const sales = chart.departments.find(d => d.department === 'Sales');
  assert.equal(sales.members.length, 2);
});
