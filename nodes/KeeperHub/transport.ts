import { randomUUID } from 'node:crypto';
import type {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	IDataObject,
} from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

import type { AttemptRecord, NormalisedError } from './types';

export const CREDENTIAL_NAME = 'keeperHubApi';

/** Status codes worth another attempt. 409 is excluded: an idempotency conflict
 *  means the original request is authoritative, not that we should re-send. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 800;
const MAX_BACKOFF_MS = 20_000;

export interface RequestContext {
	/** Appended to by every call so the node can emit a full attempt log. */
	attempts: AttemptRecord[];
	maxAttempts: number;
	baseBackoffMs: number;
}

export function newRequestContext(overrides: Partial<RequestContext> = {}): RequestContext {
	return {
		attempts: [],
		maxAttempts: overrides.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
		baseBackoffMs: overrides.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
	};
}

export function newIdempotencyKey(): string {
	return randomUUID();
}

/**
 * KeeperHub returns at least three different error envelopes from the same API:
 *
 *   1. structured    `{ error, detail, request_id, hint }`      (e.g. /integrations)
 *   2. bare          `{ error: "Unauthorized" }`                (e.g. /projects, /keys)
 *   3. unknown-route a third shape for routes that do not exist
 *
 * Everything downstream of this function sees one shape.
 */
export function normaliseError(statusCode: number | undefined, body: unknown): NormalisedError {
	if (body === undefined || body === null) {
		return { statusCode, message: `HTTP ${statusCode ?? 'error'}`, envelope: 'non-json' };
	}

	if (typeof body === 'string') {
		return { statusCode, message: body, envelope: 'non-json', raw: body };
	}

	if (typeof body !== 'object') {
		return { statusCode, message: String(body), envelope: 'non-json', raw: body };
	}

	const b = body as IDataObject;
	const error = b.error ?? b.message;
	const detail = typeof b.detail === 'string' ? b.detail : undefined;
	const hint = typeof b.hint === 'string' ? b.hint : undefined;
	const requestId =
		typeof b.request_id === 'string'
			? b.request_id
			: typeof b.requestId === 'string'
				? b.requestId
				: undefined;

	let envelope: NormalisedError['envelope'] = 'bare';
	if (detail !== undefined || hint !== undefined || requestId !== undefined) {
		envelope = 'structured';
	} else if (error === undefined) {
		envelope = 'unknown-route';
	}

	const message =
		typeof error === 'string'
			? error
			: error !== undefined
				? JSON.stringify(error)
				: `HTTP ${statusCode ?? 'error'}`;

	return { statusCode, message, detail, hint, requestId, envelope, raw: body };
}

/** Prefer the server's own guidance over our backoff curve, then fall back to
 *  exponential backoff with full jitter so parallel n8n items do not resonate. */
function nextDelayMs(
	headers: Record<string, unknown> | undefined,
	attempt: number,
	baseBackoffMs: number,
): number {
	const h = (name: string): string | undefined => {
		if (!headers) return undefined;
		const v = headers[name] ?? headers[name.toLowerCase()];
		return v === undefined || v === null ? undefined : String(v);
	};

	const retryAfter = h('retry-after');
	if (retryAfter !== undefined) {
		const asSeconds = Number(retryAfter);
		if (Number.isFinite(asSeconds)) return Math.min(asSeconds * 1000, MAX_BACKOFF_MS);
		const asDate = Date.parse(retryAfter);
		if (!Number.isNaN(asDate)) {
			return Math.min(Math.max(asDate - Date.now(), 0), MAX_BACKOFF_MS);
		}
	}

	const reset = h('x-ratelimit-reset');
	if (reset !== undefined) {
		const asSeconds = Number(reset);
		if (Number.isFinite(asSeconds) && asSeconds > 0 && asSeconds < 300) {
			return Math.min(asSeconds * 1000, MAX_BACKOFF_MS);
		}
	}

	const ceiling = Math.min(baseBackoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
	return Math.floor(Math.random() * ceiling);
}

export interface KeeperHubRequestOptions {
	method: IHttpRequestMethods;
	path: string;
	body?: IDataObject;
	qs?: IDataObject;
	/** Sent as Idempotency-Key. Only meaningful on writes. */
	idempotencyKey?: string;
	/** Set false to let the caller handle a non-2xx itself. */
	throwOnError?: boolean;
}

export interface KeeperHubResponse<T> {
	statusCode: number;
	headers: Record<string, unknown>;
	body: T;
	error?: NormalisedError;
}

/**
 * Single entry point for every KeeperHub call. Handles auth (delegated to
 * n8n's credential helper), idempotency, retry/backoff, and error
 * normalisation, and records each attempt for the audit trail.
 */
export async function keeperHubRequest<T = unknown>(
	ctx: IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions,
	reqCtx: RequestContext,
	options: KeeperHubRequestOptions,
): Promise<KeeperHubResponse<T>> {
	const credentials = await ctx.getCredentials(CREDENTIAL_NAME);
	const baseUrl = String(credentials.baseUrl ?? 'https://app.keeperhub.com/api').replace(/\/+$/, '');

	const headers: IDataObject = { Accept: 'application/json' };
	if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

	const httpOptions: IHttpRequestOptions = {
		method: options.method,
		url: `${baseUrl}${options.path}`,
		headers,
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (options.body !== undefined) httpOptions.body = options.body;
	if (options.qs !== undefined) httpOptions.qs = options.qs;

	let lastError: NormalisedError | undefined;

	for (let attempt = 1; attempt <= reqCtx.maxAttempts; attempt++) {
		const at = new Date().toISOString();
		let statusCode: number | undefined;
		let responseHeaders: Record<string, unknown> = {};
		let body: unknown;

		try {
			const response = (await ctx.helpers.httpRequestWithAuthentication.call(
				ctx,
				CREDENTIAL_NAME,
				httpOptions,
			)) as { statusCode: number; headers: Record<string, unknown>; body: unknown };

			statusCode = response.statusCode;
			responseHeaders = response.headers ?? {};
			body = response.body;
		} catch (err) {
			// Transport-level failure (DNS, socket, TLS). Retryable.
			lastError = {
				message: (err as Error).message ?? 'Network error',
				envelope: 'non-json',
			};
			if (attempt === reqCtx.maxAttempts) {
				reqCtx.attempts.push({ attempt, outcome: 'failed', reason: lastError.message, at });
				break;
			}
			const waitedMs = nextDelayMs(undefined, attempt, reqCtx.baseBackoffMs);
			reqCtx.attempts.push({
				attempt,
				outcome: 'retried',
				reason: lastError.message,
				waitedMs,
				at,
			});
			await sleep(waitedMs);
			continue;
		}

		if (statusCode >= 200 && statusCode < 300) {
			reqCtx.attempts.push({ attempt, statusCode, outcome: 'ok', at });
			return { statusCode, headers: responseHeaders, body: body as T };
		}

		lastError = normaliseError(statusCode, body);

		const retryable = RETRYABLE_STATUS.has(statusCode) && attempt < reqCtx.maxAttempts;
		if (!retryable) {
			reqCtx.attempts.push({
				attempt,
				statusCode,
				outcome: 'failed',
				reason: lastError.message,
				at,
			});
			break;
		}

		const waitedMs = nextDelayMs(responseHeaders, attempt, reqCtx.baseBackoffMs);
		reqCtx.attempts.push({
			attempt,
			statusCode,
			outcome: 'retried',
			reason: lastError.message,
			waitedMs,
			at,
		});
		await sleep(waitedMs);
	}

	if (options.throwOnError === false) {
		return {
			statusCode: lastError?.statusCode ?? 0,
			headers: {},
			body: undefined as unknown as T,
			error: lastError,
		};
	}

	throw new KeeperHubApiError(lastError ?? { message: 'Request failed', envelope: 'non-json' });
}

export class KeeperHubApiError extends Error {
	readonly normalised: NormalisedError;

	constructor(normalised: NormalisedError) {
		const parts = [normalised.message];
		if (normalised.detail) parts.push(normalised.detail);
		if (normalised.hint) parts.push(`Hint: ${normalised.hint}`);
		if (normalised.requestId) parts.push(`(request_id ${normalised.requestId})`);
		super(parts.join(', '));
		this.name = 'KeeperHubApiError';
		this.normalised = normalised;
	}
}

/**
 * Polls a direct execution to a terminal state, honouring the server's
 * X-Poll-Interval-Hint when present.
 */
export async function pollExecution(
	ctx: IExecuteFunctions,
	reqCtx: RequestContext,
	executionId: string,
	opts: { timeoutMs: number; fallbackIntervalMs: number; isTerminal: (status: string) => boolean },
): Promise<{ body: IDataObject; timedOut: boolean; polls: number }> {
	const deadline = Date.now() + opts.timeoutMs;
	let polls = 0;
	let last: IDataObject = {};

	while (Date.now() < deadline) {
		const res = await keeperHubRequest<IDataObject>(ctx, reqCtx, {
			method: 'GET',
			path: `/execute/${encodeURIComponent(executionId)}/status`,
		});
		polls++;
		last = (res.body ?? {}) as IDataObject;

		const status = String(last.status ?? '');
		if (opts.isTerminal(status)) return { body: last, timedOut: false, polls };

		const hint = res.headers['x-poll-interval-hint'] ?? res.headers['X-Poll-Interval-Hint'];
		const hintMs = hint === undefined ? NaN : Number(hint) * 1000;
		const waitMs = Number.isFinite(hintMs) && hintMs > 0 ? hintMs : opts.fallbackIntervalMs;

		await sleep(Math.min(waitMs, Math.max(deadline - Date.now(), 0)));
	}

	return { body: last, timedOut: true, polls };
}
