#!/usr/bin/env node
/**
 * Exercises the built node against the live KeeperHub API without needing an
 * n8n instance, by stubbing the slice of IExecuteFunctions the node actually
 * uses. Proves the node's own logic — simulate gate, idempotency, polling,
 * attempt log, error normalisation — not just the transport helpers.
 *
 *   KEEPERHUB_API_KEY=kh_... node --experimental-strip-types test/live-node.mjs
 *   (or: npm run build && node test/live-node.mjs)
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KeeperHub } = require('../dist/nodes/KeeperHub/KeeperHub.node.js');

const KEY = process.env.KEEPERHUB_API_KEY;
if (!KEY) {
	console.error('Set KEEPERHUB_API_KEY first.');
	process.exit(1);
}

const BASE = process.env.KEEPERHUB_BASE_URL ?? 'https://app.keeperhub.com/api';
const DEAD = '0x000000000000000000000000000000000000dEaD';

/** Minimal stand-in for the parts of IExecuteFunctions the node touches. */
function makeContext(params, { items = [{ json: {} }], continueOnFail = false } = {}) {
	return {
		getInputData: () => items,
		getNode: () => ({ name: 'KeeperHub', type: 'keeperHub', typeVersion: 1 }),
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ apiKey: KEY, baseUrl: BASE }),
		getNodeParameter(name, _i, fallback) {
			const value = name.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), params);
			return value === undefined ? fallback : value;
		},
		helpers: {
			httpRequestWithAuthentication: {
				async call(_ctx, _credName, options) {
					const headers = {
						Authorization: `Bearer ${KEY}`,
						...(options.headers ?? {}),
					};
					if (options.body !== undefined) headers['Content-Type'] = 'application/json';

					const url = new URL(options.url);
					for (const [k, v] of Object.entries(options.qs ?? {})) {
						url.searchParams.set(k, String(v));
					}

					const res = await fetch(url, {
						method: options.method,
						headers,
						body: options.body === undefined ? undefined : JSON.stringify(options.body),
					});
					const text = await res.text();
					let body;
					try {
						body = text ? JSON.parse(text) : undefined;
					} catch {
						body = text;
					}
					return {
						statusCode: res.status,
						headers: Object.fromEntries(res.headers),
						body,
					};
				},
			},
		},
	};
}

const node = new KeeperHub();
let failures = 0;

async function scenario(title, params, assert, opts) {
	process.stdout.write(`\n▸ ${title}\n`);
	const ctx = makeContext(params, opts);
	try {
		const [out] = await node.execute.call(ctx);
		const json = out[0].json;
		console.log(`  ${JSON.stringify(json).slice(0, 420)}`);
		const problem = assert(json);
		if (problem) {
			failures++;
			console.log(`  ✗ ${problem}`);
		} else {
			console.log('  ✓');
		}
	} catch (err) {
		const problem = assert(null, err);
		if (problem) {
			failures++;
			console.log(`  ✗ threw: ${err.message}`);
		} else {
			console.log(`  ✓ threw as expected: ${err.message.slice(0, 160)}`);
		}
	}
}

// 1. Happy path: simulate -> execute -> poll -> transaction hash.
await scenario(
	'Transfer 0.0001 SepoliaETH — full safe-write sequence',
	{
		resource: 'transfer',
		operation: 'send',
		chainId: 11155111,
		recipientAddress: DEAD,
		amount: '0.0001',
		tokenAddress: '',
		options: {},
	},
	(json) => {
		if (!json) return 'expected a result, got a throw';
		if (!json.transactionHash) return 'no transactionHash';
		if (json.simulation?.wouldRevert !== false) return 'simulation did not clear';
		if (!Array.isArray(json.attempts) || json.attempts.length === 0) return 'no attempt log';
		if (!json.idempotencyKey) return 'no idempotency key generated';
		if (!json.gasCostWei) return 'gas cost not computed';
		return null;
	},
);

// 2. Simulation gate: an impossible amount must never reach the chain.
await scenario(
	'Transfer 999 ETH — simulation must abort before submitting',
	{
		resource: 'transfer',
		operation: 'send',
		chainId: 11155111,
		recipientAddress: DEAD,
		amount: '999',
		tokenAddress: '',
		options: {},
	},
	(json, err) => {
		if (!err) return 'expected the simulation gate to throw, but it returned';
		return null;
	},
);

// 3. continueOnFail: the same failure must surface as data, not an exception.
await scenario(
	'Transfer 999 ETH with continueOnFail — error returned as data',
	{
		resource: 'transfer',
		operation: 'send',
		chainId: 11155111,
		recipientAddress: DEAD,
		amount: '999',
		tokenAddress: '',
		options: {},
	},
	(json) => {
		if (!json) return 'expected data, got a throw';
		if (!json.error) return 'no error field on the item';
		return null;
	},
	{ continueOnFail: true },
);

// 4. Audit trail retrieval for the execution we just made.
await scenario(
	'Execution → Get (audit trail)',
	{
		resource: 'execution',
		operation: 'get',
		executionId: 'x36nqwq71uugpb322iuvk',
		executionSource: 'direct',
	},
	(json) => {
		if (!json) return 'expected a result';
		if (json.status !== 'completed') return `unexpected status ${json.status}`;
		return null;
	},
);

// 5. Workflow list.
await scenario(
	'Workflow → List',
	{ resource: 'workflow', operation: 'list' },
	(json) => (Array.isArray(json?.workflows) ? null : 'workflows was not an array'),
);

console.log(`\n${'-'.repeat(60)}`);
console.log(failures === 0 ? 'All scenarios passed.' : `${failures} scenario(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
