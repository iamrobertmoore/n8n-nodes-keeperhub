#!/usr/bin/env node
/**
 * Unit tests for the error-normalisation layer, run against the built output.
 * Uses only node:test and node:assert so the package keeps zero dependencies.
 *
 * Run: npm run build && npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normaliseError } = require('../dist/nodes/KeeperHub/transport.js');

test('structured envelope (e.g. /integrations)', () => {
	const e = normaliseError(400, {
		error: 'bad_request',
		detail: 'chainId is required',
		request_id: 'req_123',
		hint: 'Call GET /api/chains for valid ids',
	});
	assert.equal(e.envelope, 'structured');
	assert.equal(e.message, 'bad_request');
	assert.equal(e.detail, 'chainId is required');
	assert.equal(e.requestId, 'req_123');
	assert.equal(e.hint, 'Call GET /api/chains for valid ids');
});

test('bare envelope (e.g. /projects, /keys)', () => {
	const e = normaliseError(401, { error: 'Unauthorized' });
	assert.equal(e.envelope, 'bare');
	assert.equal(e.message, 'Unauthorized');
	assert.equal(e.detail, undefined);
});

test('unknown-route envelope', () => {
	const e = normaliseError(404, { statusCode: 404, path: '/api/executions' });
	assert.equal(e.envelope, 'unknown-route');
	assert.equal(e.statusCode, 404);
});

test('non-JSON body', () => {
	const e = normaliseError(502, '<html>Bad Gateway</html>');
	assert.equal(e.envelope, 'non-json');
	assert.match(e.message, /Bad Gateway/);
});

test('empty body still yields a message', () => {
	const e = normaliseError(500, undefined);
	assert.equal(e.envelope, 'non-json');
	assert.equal(e.message, 'HTTP 500');
});

test('non-string error field is stringified, not [object Object]', () => {
	const e = normaliseError(422, { error: { code: 'revert', reason: 'ERC20: insufficient' } });
	assert.equal(e.envelope, 'bare');
	assert.match(e.message, /insufficient/);
});

// --- address validation -----------------------------------------------
// Regression guard for the case that prompted it: a valid mixed-case address
// that an LLM insisted was the wrong length.
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

test('a real mixed-case address is accepted', () => {
	assert.ok(ADDRESS_RE.test('0xE24E20d74728047d8fa9B30aEad20F7075FCb89f'));
});

test('the burn address is accepted', () => {
	assert.ok(ADDRESS_RE.test('0x000000000000000000000000000000000000dEaD'));
});

test('too short, too long and non-hex are all rejected', () => {
	assert.ok(!ADDRESS_RE.test('0xE24E20d74728047d8fa9B30aEad20F7075FCb89'));
	assert.ok(!ADDRESS_RE.test('0xE24E20d74728047d8fa9B30aEad20F7075FCb89ff'));
	assert.ok(!ADDRESS_RE.test('0xZZ4E20d74728047d8fa9B30aEad20F7075FCb89f'));
	assert.ok(!ADDRESS_RE.test('E24E20d74728047d8fa9B30aEad20F7075FCb89f'));
});
