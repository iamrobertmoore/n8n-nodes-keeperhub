/**
 * Local mirrors of the KeeperHub REST contract.
 *
 * These are declared here rather than imported from `@keeperhub/sdk` because
 * n8n's verification guidelines forbid runtime dependencies in a community
 * node. `@keeperhub/sdk` is kept as a devDependency and `test/sdk-conformance.ts`
 * asserts (at typecheck time only) that these shapes stay assignable to the
 * official ones, so drift in the upstream contract fails CI.
 */

export type ExecutionStatus =
	| 'pending'
	| 'running'
	| 'success'
	| 'error'
	| 'cancelled'
	| 'completed'
	| 'failed';

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
	'success',
	'completed',
	'error',
	'failed',
	'cancelled',
]);

export const FAILED_STATUSES: ReadonlySet<string> = new Set(['error', 'failed', 'cancelled']);

/**
 * Shape of an element of GET /api/chains, transcribed from the live response
 * on 2026-07-31 (22 chains).
 *
 * Note: the Quickstart states "Each chain includes a `status` field (stable,
 * experimental, deprecated)" and calls this endpoint "the live source of
 * truth". No chain in the live response carries a `status` field at all, it
 * is absent, not null. It is typed optional here and never relied upon.
 */
export interface Chain {
	/** Opaque KeeperHub record id, not the chain id. */
	id: string;
	chainId: number;
	name: string;
	symbol?: string;
	/** 'evm' | 'solana'. Solana entries use chainId 101/103, which are not EVM ids. */
	chainType?: string;
	isEnabled?: boolean;
	isTestnet?: boolean;
	/** True where KeeperHub routes through a private mempool (MEV protection). */
	usePrivateMempoolRpc?: boolean;
	explorerUrl?: string;
	explorerAddressPath?: string;
	explorerApiUrl?: string;
	explorerApiType?: string;
	/** Documented but not present in any live response. Never trusted. */
	status?: string | null;
}

export interface DirectExecutionStatus {
	executionId: string;
	status: ExecutionStatus;
	type?: string;
	transactionHash?: string;
	transactionLink?: string;
	gasUsedWei?: string;
	result?: unknown;
	error?: string | null;
	createdAt?: string;
	completedAt?: string;
}

export interface DirectWriteResult {
	executionId: string;
	status: ExecutionStatus;
}

export interface DirectReadResult {
	result: string | Record<string, unknown> | unknown[];
}

export interface SimulationResult {
	success?: boolean;
	wouldRevert?: boolean;
	revertReason?: string | null;
	gasEstimate?: string;
	[key: string]: unknown;
}

export interface Workflow {
	id: string;
	name: string;
	description?: string;
	nodes?: unknown[];
	edges?: unknown[];
	createdAt?: string;
	updatedAt?: string;
}

export interface ExecutionLogEntry {
	nodeId: string;
	nodeName?: string;
	nodeType?: string;
	status: ExecutionStatus;
	input?: unknown;
	output?: unknown;
	duration?: number;
	createdAt?: string;
}

/** One HTTP attempt, surfaced so the audit trail shows retries doing real work. */
export interface AttemptRecord {
	attempt: number;
	statusCode?: number;
	outcome: 'ok' | 'retried' | 'failed';
	reason?: string;
	waitedMs?: number;
	at: string;
}

/** Normalised error, flattened from KeeperHub's three different envelopes. */
export interface NormalisedError {
	statusCode?: number;
	message: string;
	detail?: string;
	hint?: string;
	requestId?: string;
	envelope: 'structured' | 'bare' | 'unknown-route' | 'non-json';
	raw?: unknown;
}
