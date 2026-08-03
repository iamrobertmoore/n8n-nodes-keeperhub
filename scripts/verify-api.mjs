#!/usr/bin/env node
/**
 * One-command reproduction of every claim we make about the KeeperHub API.
 *
 *   KEEPERHUB_API_KEY=kh_... node scripts/verify-api.mjs
 *
 * Read-only by default. Pass --write to include simulate-only execution probes
 * (still no value moves; `simulate: true` is a dry run).
 *
 * Prints EXPECTED vs ACTUAL for each check so a maintainer can triage in one
 * pass rather than re-deriving each finding.
 */

const BASE = process.env.KEEPERHUB_BASE_URL ?? 'https://app.keeperhub.com/api';
const KEY = process.env.KEEPERHUB_API_KEY;
const INCLUDE_WRITE = process.argv.includes('--write');

if (!KEY) {
	console.error('Set KEEPERHUB_API_KEY first.');
	process.exit(1);
}

const GARBAGE = 'kh_thisisnotarealkeyatall000000000';

let pass = 0;
let fail = 0;

async function call(path, { key = KEY, method = 'GET', body, headers = {} } = {}) {
	const h = { Accept: 'application/json', ...headers };
	if (key !== null) h.Authorization = `Bearer ${key}`;
	if (body !== undefined) h['Content-Type'] = 'application/json';

	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: h,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let parsed;
	try {
		parsed = text ? JSON.parse(text) : undefined;
	} catch {
		parsed = text;
	}
	return { status: res.status, headers: Object.fromEntries(res.headers), body: parsed };
}

function check(id, title, expected, actual, ok) {
	const verdict = ok ? 'PASS' : 'FAIL';
	if (ok) pass++;
	else fail++;
	console.log(`\n[${verdict}] ${id}, ${title}`);
	console.log(`  expected: ${expected}`);
	console.log(`  actual:   ${actual}`);
}

function preview(v, n = 160) {
	return JSON.stringify(v).slice(0, n);
}

const run = async () => {
	console.log(`KeeperHub API verification, ${new Date().toISOString()}`);
	console.log(`base: ${BASE}`);

	// --- NEW-3: /api/chains has no status field ---------------------------
	{
		const r = await call('/chains');
		const chains = Array.isArray(r.body) ? r.body : [];
		const withStatus = chains.filter((c) => Object.hasOwn(c, 'status')).length;
		check(
			'NEW-3',
			'Quickstart documents a `status` field on every chain',
			`${chains.length}/${chains.length} chains carry a "status" key`,
			`${withStatus}/${chains.length} do. Keys present: ${Object.keys(chains[0] ?? {}).join(', ')}`,
			withStatus === chains.length && chains.length > 0,
		);

		const testnets = chains.filter((c) => c.isTestnet).length;
		console.log(
			`  note:     ${chains.length} chains enabled (docs list 9), ${testnets} testnet, ` +
				`${chains.filter((c) => c.usePrivateMempoolRpc).length} with private mempool`,
		);
	}

	// --- NEW-1: documented API-key scope table vs reality ------------------
	{
		// Every endpoint listed under "Accepted on API keys" in docs/api/authentication.
		const documented = [
			'/workflows',
			'/executions',
			'/execute',
			'/integrations',
			'/projects',
			'/tags',
			'/public-tags',
			'/chains',
			'/analytics',
			'/keys',
			'/organizations',
			'/address-book',
			'/billing',
			'/user',
		];

		const broken = [];
		const lines = [];
		for (const path of documented) {
			const r = await call(path);
			const note = r.status === 404 ? 'ROUTE MISSING' : r.status === 401 ? 'REJECTS VALID KEY' : '';
			if (note) broken.push(`${path} (${r.status} ${note})`);
			lines.push(`              ${String(r.status).padEnd(4)} ${path}${note ? `  <- ${note}` : ''}`);
		}

		check(
			'NEW-1',
			'every endpoint documented as accepting kh_ keys does so',
			`${documented.length}/${documented.length} reachable with a valid kh_ key`,
			`${documented.length - broken.length}/${documented.length} reachable\n${lines.join('\n')}`,
			broken.length === 0,
		);
	}

	// --- BY DESIGN: /workflows is anonymous-tolerant -----------------------
	{
		const anon = await call('/workflows', { key: null });
		const bad = await call('/workflows', { key: GARBAGE });
		const good = await call('/workflows');
		check(
			'KNOWN-1',
			'GET /workflows can distinguish a bad key from an empty account',
			'anonymous and invalid keys are rejected with 401',
			`anon -> ${anon.status}, invalid -> ${bad.status}, valid -> ${good.status} ` +
				'(by design: auth required:false, see KeeperHub/cli#75)',
			anon.status === 401 && bad.status === 401,
		);

		const projBad = await call('/projects', { key: GARBAGE });
		check(
			'PROBE',
			'/projects is a sound credential probe (this is what the n8n node uses)',
			'invalid key -> 401',
			`invalid key -> ${projBad.status}`,
			projBad.status === 401,
		);
	}

	// --- F2: error envelope consistency ------------------------------------
	{
		const shapes = {};
		for (const path of ['/integrations', '/projects', '/keys', '/tags', '/organizations']) {
			const r = await call(path, { key: GARBAGE });
			shapes[path] = `${r.status} keys=[${Object.keys(r.body ?? {}).sort().join(',')}]`;
		}
		const unknown = await call('/this-route-does-not-exist', { key: GARBAGE });
		shapes['/this-route-does-not-exist'] =
			`${unknown.status} keys=[${Object.keys(unknown.body ?? {}).sort().join(',')}]`;

		const distinct = new Set(Object.values(shapes).map((s) => s.split(' keys=')[1]));
		check(
			'F2',
			'one error envelope across the API',
			'1 distinct error body shape',
			`${distinct.size} distinct shapes:\n` +
				Object.entries(shapes)
					.map(([k, v]) => `              ${k} -> ${v}`)
					.join('\n'),
			distinct.size === 1,
		);
	}

	// --- Reliability headers the docs promise ------------------------------
	{
		const r = await call('/chains');
		const names = Object.keys(r.headers).filter((h) =>
			/ratelimit|retry-after|poll-interval/i.test(h),
		);
		check(
			'NEW-4',
			'X-RateLimit-* / Retry-After documented as present on API responses',
			'at least one rate-limit header',
			names.length ? names.join(', ') : 'none present',
			names.length > 0,
		);
	}

	// --- Simulate dry-run --------------------------------------------------
	if (INCLUDE_WRITE) {
		const body = {
			chainId: 11155111,
			network: '11155111',
			recipientAddress: '0x000000000000000000000000000000000000dEaD',
			amount: '0.0001',
			simulate: true,
		};
		const r = await call('/execute/transfer', { method: 'POST', body });
		const completed = r.body?.status === 'simulated' && r.body?.wouldRevert !== undefined;
		check(
			'NEW-2',
			'a simulation that completes returns 2xx (400 is for malformed input)',
			'200 with wouldRevert / revertReason',
			`${r.status}, simulation ${completed ? 'COMPLETED and still returned ' + r.status : 'did not complete'}\n` +
				`              ${preview(r.body, 260)}`,
			completed && r.status >= 200 && r.status < 300,
		);

		// Idempotency replay semantics: same key twice, simulate only.
		const idem = `verify-${Date.now()}`;
		const a = await call('/execute/transfer', {
			method: 'POST',
			body,
			headers: { 'Idempotency-Key': idem },
		});
		const b = await call('/execute/transfer', {
			method: 'POST',
			body,
			headers: { 'Idempotency-Key': idem },
		});
		const replayHeader = Object.keys(b.headers).filter((h) => /idempot|replay/i.test(h));
		check(
			'OPEN-1',
			'a replayed Idempotency-Key is marked as a replay',
			'second response flagged as replayed',
			`first -> ${a.status}, second -> ${b.status}, replay headers: ${
				replayHeader.length ? replayHeader.join(', ') : 'none'
			}`,
			replayHeader.length > 0,
		);
	} else {
		console.log('\n(skipping simulate probes, pass --write to include them)');
	}

	console.log(`\n${'-'.repeat(60)}`);
	console.log(`${pass} matched documentation, ${fail} did not.`);
};

run().catch((e) => {
	console.error(e);
	process.exit(1);
});
