import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Messenger } from '../sdk/messenger.js';

// Same approach as test/task_queue.test.js: Messenger only talks to the
// brain over REST (POST /remember, GET/PATCH /node/:id, GET /tag/:tag), so
// it's exercised here against a tiny in-memory fake of those endpoints
// instead of a real running server.
function makeFakeBrain() {
  const nodes = new Map(); // id -> node

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
        const subdir = body.subdir ? `${body.subdir}/` : '';
        const id = `${subdir}${slugify(body.title)}`;
        const node = {
          id,
          title: body.title,
          content: body.content,
          type: body.type || 'memory',
          tags: body.tags || [],
          version: 1,
        };
        nodes.set(id, node);
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

      const tagGet = u.pathname.match(/^\/tag\/(.+)$/);
      if (method === 'GET' && tagGet) {
        const tag = decodeURIComponent(tagGet[1]).toLowerCase();
        const found = [...nodes.values()].filter(n => n.tags.includes(tag));
        return { ok: true, json: async () => ({ tag, count: found.length, nodes: found }) };
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

test('send() writes an unread message tagged for both recipient and sender', async (t) => {
  const fake = withFakeBrain(t);
  const msgr = new Messenger({ api: 'http://localhost:3747' });

  const result = await msgr.send('pipeline-agent', 'research-agent', 'Please check the new dataset.', { subject: 'Dataset ready' });

  const node = fake.nodes.get(result.id);
  assert.ok(node);
  assert.ok(node.tags.includes('unread'));
  assert.ok(node.tags.includes('to-research-agent'));
  assert.ok(node.tags.includes('from-pipeline-agent'));
  assert.match(node.content, /Please check the new dataset\./);
});

test('inbox() returns only unread messages by default', async (t) => {
  withFakeBrain(t);
  const msgr = new Messenger({ api: 'http://localhost:3747' });

  const first = await msgr.send('pipeline-agent', 'research-agent', 'First message', { subject: 'One' });
  await msgr.send('pipeline-agent', 'research-agent', 'Second message', { subject: 'Two' });
  await msgr.markRead(first.id);

  const unread = await msgr.inbox('research-agent');
  assert.equal(unread.length, 1);
  assert.match(unread[0].title, /Two/);

  const all = await msgr.inbox('research-agent', false);
  assert.equal(all.length, 2);
});

test('markRead moves a message from unread to read', async (t) => {
  const fake = withFakeBrain(t);
  const msgr = new Messenger({ api: 'http://localhost:3747' });

  const result = await msgr.send('pipeline-agent', 'research-agent', 'Body', { subject: 'Subj' });
  await msgr.markRead(result.id);

  const node = fake.nodes.get(result.id);
  assert.ok(!node.tags.includes('unread'));
  assert.ok(node.tags.includes('read'));
});

test('reply() sends a new message back to the original sender and marks the original replied', async (t) => {
  const fake = withFakeBrain(t);
  const msgr = new Messenger({ api: 'http://localhost:3747' });

  const original = await msgr.send('pipeline-agent', 'research-agent', 'Can you take a look?', { subject: 'Question' });
  const reply = await msgr.reply(original.id, 'research-agent', 'Looked, looks good.');

  const originalNode = fake.nodes.get(original.id);
  assert.ok(originalNode.tags.includes('replied'));

  const replyNode = fake.nodes.get(reply.id);
  assert.ok(replyNode.tags.includes('to-pipeline-agent'));
  assert.ok(replyNode.tags.includes('from-research-agent'));
  assert.match(replyNode.title, /^\[MSG\] Re: Question/);
  assert.ok(replyNode.content.includes(`**Reply-To:** ${original.id}`));
});
