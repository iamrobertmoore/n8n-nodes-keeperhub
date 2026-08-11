#!/usr/bin/env node
/**
 * Measures the node's safe-write sequence against the live KeeperHub API on
 * Ethereum Sepolia, rather than asserting that it works.
 *
 *   npm run build
 *   KEEPERHUB_API_KEY=kh_... node scripts/benchmark.mjs
 *
 * Two passes:
 *
 *   A. AFFORDABLE  - transfers the wallet can cover. Should land every time.
 *   B. IMPOSSIBLE  - transfers it cannot. The simulation gate should stop all
 *                    of them BEFORE submission, so zero gas is spent on
 *                    transactions that were always going to revert.
 *
 * Pass B is the point. Anyone can land a transaction; the claim worth
 * measuring is how many were correctly refused without cost.
 *
 * Writes benchmark-results.json next to this script and prints a markdown
 * summary. Uses the built node, so it exercises the real code path an n8n user
 * gets, not a reimplementation.
 *
 * Runs land in ~20s each, so passes execute concurrently and can be chunked
 * across invocations with --append, then totalled with --summarise.
 *
 * Flags:
 *   --pass=affordable|impossible   which pass to run
 *   --runs=20                      how many in this invocation
 *   --concurrency=10               how many at once
 *   --append=results.json          accumulate raw results here
 *   --summarise=results.json       print the table from accumulated results
 */

import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { KeeperHub } = require('../dist/nodes/KeeperHub/KeeperHub.node.js');

const KEY = process.env.KEEPERHUB_API_KEY;
if (!KEY) {
	console.error('Set KEEPERHUB_API_KEY first.');
	process.exit(1);
}

const arg = (name, fallback) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.split('=')[1] : fallback;
};

const BASE = process.env.KEEPERHUB_BASE_URL ?? 'https://app.keeperhub.com/api';
const CHAIN_ID = 11155111; // Ethereum Sepolia
const RUNS = Number(arg('runs', 20));
const AMOUNT = arg('amount', '0.0001');
const IMPOSSIBLE_AMOUNT = '999';
const DEAD = '0x000000000000000000000000000000000000dEaD';
const OUT = arg('out', new URL('../benchmark-results.json', import.meta.url).pathname);

/** The slice of IExecuteFunctions the node actually touches. */
function makeContext(params, { continueOnFail = false } = {}) {
	return {
		getInputData: () => [{ json: {} }],
		getNode: () => ({ name: 'KeeperHub', type: 'keeperHub', typeVersion: 1 }),
		continueOnFail: () => continueOnFail,
		getCredentials: async () => ({ apiKey: KEY, baseUrl: BASE }),
		getNodeParameter(name, _i, fallback) {
			const v = name.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), params);
			return v === undefined ? fallback : v;
		},
		helpers: {
			httpRequestWithAuthentication: {
				async call(_ctx, _name, options) {
					const headers = { Authorization: `Bearer ${KEY}`, ...(options.headers ?? {}) };
					if (options.body !== undefined) headers['Content-Type'] = 'application/json';
					const res = await fetch(options.url, {
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
					return { statusCode: res.status, headers: Object.fromEntries(res.headers), body };
				},
			},
		},
	};
}

const node = new KeeperHub();

const params = (amount) => ({
	resource: 'transfer',
	operation: 'send',
	chainId: CHAIN_ID,
	recipientAddress: DEAD,
	amount,
	tokenAddress: '',
	options: {},
});

async function runOnce(amount) {
	const started = Date.now();
	// continueOnFail so a refusal returns as data and we can inspect it.
	const ctx = makeContext(params(amount), { continueOnFail: true });
	const [out] = await node.execute.call(ctx);
	const json = out[0].json;
	const elapsedMs = Date.now() - started;

	const refused = Boolean(json.error);
	return {
		elapsedMs,
		refused,
		landed: !refused && Boolean(json.transactionHash),
		transactionHash: json.transactionHash ?? null,
		executionId: json.executionId ?? null,
		wouldRevert: json.simulation?.wouldRevert ?? null,
		gasCostWei: json.gasCostWei ?? null,
		polls: json.polls ?? null,
		attempts: Array.isArray(json.attempts) ? json.attempts.length : null,
		retried: Array.isArray(json.attempts)
			? json.attempts.some((a) => a.outcome === 'retried')
			: null,
		error: refused ? String(json.error).slice(0, 120) : null,
	};
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function stats(values) {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	return {
		min: s[0],
		p50: pct(s, 50),
		p95: pct(s, 95),
		max: s[s.length - 1],
		mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
	};
}

function loadStore(path) {
	if (!existsSync(path)) return { affordable: [], impossible: [] };
	return JSON.parse(readFileSync(path, 'utf8'));
}

function summarise(store) {
	const landed = store.affordable.filter((r) => r.landed);
	const leaked = store.impossible.filter((r) => r.transactionHash);
	const gas = landed.map((r) => Number(r.gasCostWei)).filter(Number.isFinite);
	const a = stats(store.affordable.map((r) => r.elapsedMs));
	const b = stats(store.impossible.map((r) => r.elapsedMs));
	const polls = stats(store.affordable.map((r) => r.polls).filter((v) => v != null));
	const gasStats = stats(gas);
	const retried = store.affordable.filter((r) => r.retried).length;

	const lines = [
		'| Measure | Result |',
		'|---|---|',
		`| Affordable transfers landed | **${landed.length}/${store.affordable.length}** |`,
		`| Impossible transfers refused before submission | **${store.impossible.filter((r) => r.refused).length}/${store.impossible.length}** |`,
		`| Impossible transfers that reached the chain | **${leaked.length}** |`,
		a ? `| Time to landed transaction (p50 / p95) | ${(a.p50 / 1000).toFixed(1)}s / ${(a.p95 / 1000).toFixed(1)}s |` : '',
		b ? `| Time to refusal, no gas spent (p50 / p95) | ${(b.p50 / 1000).toFixed(1)}s / ${(b.p95 / 1000).toFixed(1)}s |` : '',
		polls ? `| Status polls per landed transfer (p50 / max) | ${polls.p50} / ${polls.max} |` : '',
		gasStats ? `| Gas cost per landed transfer (p50) | ${gasStats.p50.toLocaleString()} wei |` : '',
		`| Runs needing an HTTP retry | ${retried}/${store.affordable.length} |`,
	].filter(Boolean);
	return lines.join('\n');
}

const run = async () => {
	const summarisePath = arg('summarise', null);
	if (summarisePath) {
		const store = loadStore(summarisePath);
		console.log(summarise(store));
		console.log(`\ntransactions: ${store.affordable.filter((r) => r.landed).length}`);
		return;
	}

	const pass = arg('pass', 'affordable');
	const concurrency = Number(arg('concurrency', 10));
	const storePath = arg('append', OUT);
	const amount = pass === 'impossible' ? IMPOSSIBLE_AMOUNT : AMOUNT;

	const store = loadStore(storePath);
	console.log(`pass=${pass} runs=${RUNS} concurrency=${concurrency} amount=${amount}`);

	const save = () => {
		store.generatedAt = new Date().toISOString();
		store.chainId = CHAIN_ID;
		writeFileSync(storePath, JSON.stringify(store, null, 2));
	};

	let done = 0;
	for (let start = 0; start < RUNS; start += concurrency) {
		const size = Math.min(concurrency, RUNS - start);
		// Persist as each run resolves, not when the wave does: a landed
		// transaction is real whether or not the harness lives to write it.
		await Promise.all(
			Array.from({ length: size }, async () => {
				const r = await runOnce(amount);
				store[pass].push(r);
				done++;
				console.log(
					`  ${String(done).padStart(2)}/${RUNS}  ${r.landed ? 'landed ' : r.refused ? 'refused' : 'OTHER  '}` +
						`  ${String(r.elapsedMs).padStart(6)}ms  ${r.transactionHash?.slice(0, 14) ?? (r.error ?? '').slice(0, 46)}`,
				);
				save();
			}),
		);
	}

	store.generatedAt = new Date().toISOString();
	store.chainId = CHAIN_ID;
	writeFileSync(storePath, JSON.stringify(store, null, 2));
	console.log(`\nstored ${store[pass].length} total ${pass} runs in ${storePath}`);
};

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
