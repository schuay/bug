import assert from 'node:assert/strict';
import test from 'node:test';

import { cacheKey } from '../lib/cache.js';

test('cacheKey is deterministic and url-sensitive', () => {
  const k1 = cacheKey('https://issuetracker.google.com/issues/1');
  const k2 = cacheKey('https://issuetracker.google.com/issues/1');
  const k3 = cacheKey('https://issuetracker.google.com/issues/2');
  assert.equal(k1, k2);
  assert.notEqual(k1, k3);
  assert.match(k1, /^[0-9a-f]{32}$/);
});
