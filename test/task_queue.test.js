import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueue } from '../sdk/task_queue.js';

// TaskQueue talks to the brain over its own REST API (sdk/index.js's
// SecondBrain client), not the filesystem directly — so it's tested here
// against a tiny in-memory fake of the handful of endpoints it actually
// calls (POST /remember, GET /node/:id, PATCH /node/:id, GET /tasks),
// rather than booting a real api/server.js. This mirrors this suite's
// existing convention (llm_router.test.js, embeddings.test.js, etc.) of
// mocking global fetch instead of hitting a real network/process.
function makeFakeBrain() {
  const nodes = new Map(); // id -> node
  let counter = 0;

  function slugify(title) {
    return title.replace(/[<>:"/\\|?*]/g, '-');
  }

  return {
    nodes,
    async fetch(url, options = {}) {
      const u = new URL(url);
      const method = (options.method || 'GET').toUpperCase();
      const body = options.body ? JSON.parse(options.body) : {};

      if (method === 'POST' && u.pathname === '/remember') {
        const id = `tasks/${slugify(body.title)}`;
        const node = {
          id,
          title: body.title,
          content: body.content,
          type: body.type || 'memory',
          tags: body.tags || [],
          version: 1,
        };
        nodes.set(id, node);
        counter++;
        return { ok: true, json: async () => ({ success: true, id, node }) };
      }

      const nodeGet = u.pathname.match(/^\/node\/(.+)$/);
      if (method === 'GET' && nodeGet) {
        const id = decodeURIComponent(nodeGet[1]);
        const node = nodes.get(id);
        if (!node) return { ok: false, status: 404, json: async () => ({ error: 'Node not found' }) };
        return { ok: true, json: async () => node };
      }

      if (method === 'PATCH' && nodeGet) {
        const id = decodeURIComponent(nodeGet[1]);
        const node = nodes.get(id);
        if (!node) return { ok: false, status: 404, json: async () => ({ error: 'Node not found' }) };
        if (body.tags !== undefined) node.tags = body.tags;
        if (body.content !== undefined) node.content = body.content;
        node.version = (node.version || 1) + 1;
        return { ok: true, json: async () => ({ success: true, id }) };
      }

      if (method === 'GET' && u.pathname === '/tasks') {
        const status = u.searchParams.get('status');
        const found = [...nodes.values()].filter(n => !status || n.tags.includes(status));
        return { ok: true, json: async () => ({ count: found.length, tasks: found }) };
      }

      throw new Error(`Unhandled fake-brain request: ${method} ${u.pathname}`);
    },
  };
}

function withFakeBrain(t) {
  const fake = makeFakeBrain();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => fake.fetch(String(url), options);
  t.after(() => { globalThis.fetch = originalFetch; });
  return fake;
}

test('submit() writes a pending task with no dependencies', async (t) => {
  withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });

  const { taskId, nodeId, status } = await tq.submit('Investigate rate limiting approaches', ['pipeline-agent']);

  assert.equal(status, 'pending');
  assert.ok(taskId.startsWith('task-'));
  assert.ok(nodeId);
});

test('submit() marks a task blocked when dependencies are given', async (t) => {
  withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });

  const { status } = await tq.submit('Second step', ['pipeline-agent'], { dependencies: ['tasks/first-step'] });
  assert.equal(status, 'blocked');
});

test('setStatus transitions tags and keeps the "status:" line in content in sync', async (t) => {
  const fake = withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });
  const { nodeId } = await tq.submit('A task', ['pipeline-agent']);

  await tq.setStatus(nodeId, 'completed');

  const node = fake.nodes.get(nodeId);
  assert.ok(node.tags.includes('completed'));
  assert.ok(!node.tags.includes('pending'));
  assert.match(node.content, /status: completed/);
});

test('setStatus rejects an unknown status', async (t) => {
  withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });
  const { nodeId } = await tq.submit('A task', ['pipeline-agent']);
  await assert.rejects(() => tq.setStatus(nodeId, 'not-a-real-status'), /Unknown status/);
});

test('releaseDependents moves a blocked task to pending once all its dependencies complete', async (t) => {
  withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });

  const dep = await tq.submit('Dependency task', ['pipeline-agent']);
  const dependent = await tq.submit('Dependent task', ['pipeline-agent'], { dependencies: [dep.nodeId] });
  assert.equal(dependent.status, 'blocked');

  await tq.setStatus(dep.nodeId, 'completed');
  const released = await tq.releaseDependents(dep.nodeId);

  assert.equal(released, 1);
  const blocked = await tq.listBlocked();
  assert.equal(blocked.length, 0);
});

test('releaseDependents cascades a failure to a blocked dependent instead of leaving it stuck', async (t) => {
  withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });

  const dep = await tq.submit('Dependency task', ['pipeline-agent']);
  const dependent = await tq.submit('Dependent task', ['pipeline-agent'], { dependencies: [dep.nodeId] });

  await tq.setStatus(dep.nodeId, 'failed');
  const released = await tq.releaseDependents(dep.nodeId);

  assert.equal(released, 1);
  const dependentNode = await tq.get(dependent.nodeId);
  assert.ok(dependentNode.tags.includes('failed'), 'the dependent should be cascaded to failed, not left blocked forever');
});

test('appendResult and setFinalResult write into the expected markdown sections', async (t) => {
  const fake = withFakeBrain(t);
  const tq = new TaskQueue({ api: 'http://localhost:3747' });
  const { nodeId } = await tq.submit('A task', ['pipeline-agent']);

  await tq.appendResult(nodeId, 'pipeline-agent', 'Partial finding.');
  await tq.setFinalResult(nodeId, 'Final answer.');

  const node = fake.nodes.get(nodeId);
  assert.match(node.content, /### pipeline-agent\nPartial finding\./);
  assert.match(node.content, /## Final Result\nFinal answer\./);
});
