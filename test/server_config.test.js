import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServerConfig } from '../sdk/server_config.js';

test('loopback binding is allowed without an API key', () => {
  assert.deepEqual(validateServerConfig('127.0.0.1', ''), {
    host: '127.0.0.1',
    apiKey: '',
  });
});

test('non-loopback binding requires an API key', () => {
  assert.throws(
    () => validateServerConfig('0.0.0.0', ''),
    /Set BRAIN_KEY or bind to 127\.0\.0\.1/,
  );
  assert.deepEqual(validateServerConfig('0.0.0.0', 'local-test-key'), {
    host: '0.0.0.0',
    apiKey: 'local-test-key',
  });
});
