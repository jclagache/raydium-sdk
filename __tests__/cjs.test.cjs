'use strict';

const assert = require('node:assert');

const { RaydiumSDK } = require('../dist/cjs/index.cjs');

assert.ok(RaydiumSDK, 'RaydiumSDK should be defined');
assert.strictEqual(typeof RaydiumSDK, 'function', 'RaydiumSDK should be a class (function)');
assert.strictEqual(RaydiumSDK.name, 'RaydiumSDK', 'RaydiumSDK should have the name "RaydiumSDK"');
