import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJSON, routeLLM, activeProvider } from '../sdk/llm_router.js';

// ── extractJSON ────────────────────────────────────────────────────────────

test('extractJSON parses a plain JSON string', () => {
  assert.deepEqual(extractJSON('{"action":"respond","message":"hi"}'), { action: 'respond', message: 'hi' });
});

test('extractJSON parses JSON wrapped in a markdown code fence', () => {
  const text = 'Sure, here you go:\n```json\n{"action":"respond","message":"hi"}\n```\nHope that helps!';
  assert.deepEqual(extractJSON(text), { action: 'respond', message: 'hi' });
});

test('extractJSON pulls the first {...} block out of surrounding prose', () => {
  const text = 'The result is {"action":"remember","title":"t"} — done.';
  assert.deepEqual(extractJSON(text), { action: 'remember', title: 't' });
});

test('extractJSON throws a helpful error when nothing parses', () => {
  assert.throws(() => extractJSON('not json at all'), /Could not extract valid JSON/);
});

test('extractJSON repairs raw newlines/tabs left unescaped inside a string value', () => {
  // What a smaller model commonly emits: valid JSON structure, but a
  // literal newline inside the "message" string instead of an escaped
  // "\n" — technically invalid JSON.
  const text = '{"action":"respond","message":"Line one.\nLine two.\tTabbed."}';
  assert.deepEqual(extractJSON(text), { action: 'respond', message: 'Line one.\nLine two.\tTabbed.' });
});

test('extractJSON repair does not touch an escaped quote inside a string', () => {
  const text = '{"action":"respond","message":"She said \\"hi\\"\nthen left."}';
  assert.deepEqual(extractJSON(text), { action: 'respond', message: 'She said "hi"\nthen left.' });
});

// ── routeLLM provider fallthrough ────────────────────────────────────────────

function fakeResponse(body) {
  return { json: async () => body };
}

test('routeLLM calls only the first configured provider on success', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return fakeResponse({ content: [{ text: '{"action":"respond","message":"from anthropic"}' }] });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const keys = { anthropicKey: 'test-key', geminiKey: 'unused-key', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.2:3b' };
  const result = await routeLLM(keys, 'system', 'user', { json: true });

  assert.deepEqual(result, { action: 'respond', message: 'from anthropic' });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /anthropic\.com/);
});

test('routeLLM falls through to the next provider when the first fails', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('anthropic.com')) throw new Error('simulated network failure');
    if (u.includes('generativelanguage.googleapis.com')) {
      return fakeResponse({ candidates: [{ content: { parts: [{ text: '{"action":"respond","message":"from gemini"}' }] } }] });
    }
    throw new Error(`unexpected URL in test: ${u}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const keys = { anthropicKey: 'test-key', geminiKey: 'test-key', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.2:3b' };
  const result = await routeLLM(keys, 'system', 'user', { json: true });

  assert.deepEqual(result, { action: 'respond', message: 'from gemini' });
  assert.equal(calls.length, 2);
});

test('routeLLM falls through when a provider returns valid JSON in the wrong shape', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('anthropic.com')) {
      // Syntactically valid JSON, but missing the "message" the validator requires.
      return fakeResponse({ content: [{ text: '{"action":"respond"}' }] });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      return fakeResponse({ candidates: [{ content: { parts: [{ text: '{"action":"respond","message":"ok"}' }] } }] });
    }
    throw new Error(`unexpected URL in test: ${u}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const keys = { anthropicKey: 'test-key', geminiKey: 'test-key', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.2:3b' };
  const validate = (obj) => (typeof obj.message === 'string' && obj.message.length > 0) || 'missing message';
  const result = await routeLLM(keys, 'system', 'user', { json: true, validate });

  assert.deepEqual(result, { action: 'respond', message: 'ok' });
  assert.equal(calls.length, 2, 'the invalid-shape response from anthropic must not be accepted as-is');
});

test('routeLLM throws with all provider errors when every provider fails', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const keys = { anthropicKey: 'test-key', ollamaHost: 'http://localhost:11434', ollamaModel: 'llama3.2:3b' };
  await assert.rejects(() => routeLLM(keys, 'system', 'user', { json: true }), /All LLM providers failed/);
});

// ── activeProvider ────────────────────────────────────────────────────────

test('activeProvider reports the first configured provider in priority order', () => {
  assert.equal(activeProvider({ anthropicKey: 'x' }), 'anthropic');
  assert.equal(activeProvider({ geminiKey: 'x' }), 'gemini');
});

test('activeProvider falls back to ollama when no keys are configured', () => {
  assert.equal(activeProvider({}), 'ollama');
});
