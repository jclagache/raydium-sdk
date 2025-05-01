import assert from 'node:assert';

import { RaydiumSDK } from '../dist/esm/index.mjs';

assert.ok(RaydiumSDK, 'RaydiumSDK should be defined');
assert.strictEqual(typeof RaydiumSDK, 'function', 'RaydiumSDK should be a class (function)');
assert.strictEqual(RaydiumSDK.name, 'RaydiumSDK', 'RaydiumSDK should have the name "RaydiumSDK"');
