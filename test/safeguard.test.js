import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeContent } from '../sdk/safeguard.js';

test('redacts an OpenAI project key', () => {
  const key = 'sk-proj-' + 'a'.repeat(48);
  const out = sanitizeContent(`here is my key: ${key}`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_OPENAI_KEY\]/);
});

test('redacts an Anthropic API key', () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(90);
  const out = sanitizeContent(`ANTHROPIC_API_KEY=${key}`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_ANTHROPIC_KEY\]/);
});

test('redacts a Gemini API key', () => {
  const key = 'AIzaSy' + 'B'.repeat(33);
  const out = sanitizeContent(`key: ${key}`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_GEMINI_KEY\]/);
});

test('redacts an AWS access key id', () => {
  const key = 'AKIA' + 'ABCD1234EFGH5678';
  const out = sanitizeContent(`aws_access_key_id = ${key}`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_AWS_KEY\]/);
});

test('redacts a GitHub personal access token', () => {
  const key = 'ghp_' + 'a1b2c3'.repeat(7);
  const out = sanitizeContent(`token: ${key}`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_GITHUB_TOKEN\]/);
});

test('redacts a Slack bot token', () => {
  const key = 'xoxb-1234567890-abcdefghijk';
  const out = sanitizeContent(`slack token ${key} in the payload`);
  assert.ok(!out.includes(key));
  assert.match(out, /\[REDACTED_SLACK_TOKEN\]/);
});

test('redacts an SSN, an email, and a credit card number', () => {
  const out = sanitizeContent('SSN 123-45-6789, email me at user@example.com, card 4111 1111 1111 1111');
  assert.match(out, /\[REDACTED_SSN\]/);
  assert.match(out, /\[REDACTED_EMAIL\]/);
  assert.match(out, /\[REDACTED_CREDIT_CARD\]/);
});

test('redacts a credit card without swallowing the trailing space into the match', () => {
  const out = sanitizeContent('card 4111-1111-1111-1111 on file');
  assert.strictEqual(out, 'card [REDACTED_CREDIT_CARD] on file');
});

test('does not redact a non-Luhn digit run as a credit card', () => {
  const out = sanitizeContent('order id 1234-5678-9012-3456 was placed');
  assert.strictEqual(out, 'order id 1234-5678-9012-3456 was placed');
});

test('redacts generic key=value secret assignments while preserving the label', () => {
  const out = sanitizeContent('password: "hunter2superSecretValue123"');
  assert.match(out, /password: "\[REDACTED_SECRET\]"/);
  assert.ok(!out.includes('hunter2superSecretValue123'));
});

test('leaves ordinary text untouched', () => {
  const text = 'This note has no secrets, just plain markdown and a [[wikilink]].';
  assert.equal(sanitizeContent(text), text);
});

test('is a no-op on non-string input', () => {
  assert.equal(sanitizeContent(null), null);
  assert.equal(sanitizeContent(undefined), undefined);
  assert.equal(sanitizeContent(42), 42);
});
