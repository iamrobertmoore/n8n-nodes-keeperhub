/**
 * Typecheck-only conformance test.
 *
 * n8n's verification guidelines forbid runtime dependencies, so this node
 * cannot import @keeperhub/sdk at runtime. Instead the SDK is a devDependency
 * and this file asserts, at `npm run typecheck` time, that our local mirrors
 * of the REST contract stay assignable to KeeperHub's official types.
 *
 * If KeeperHub changes their contract in a way that breaks us, CI fails here
 * rather than in production.
 *
 * Nothing in this file is compiled into dist.
 */

import type {
	DirectExecutionStatus as SdkDirectExecutionStatus,
	DirectReadResult as SdkDirectReadResult,
	DirectWriteResult as SdkDirectWriteResult,
	ExecutionLogEntry as SdkExecutionLogEntry,
	ExecutionStatus as SdkExecutionStatus,
} from '@keeperhub/sdk';

import type {
	DirectExecutionStatus,
	DirectReadResult,
	DirectWriteResult,
	ExecutionLogEntry,
	ExecutionStatus,
} from '../nodes/KeeperHub/types';

type AssertAssignable<T, U extends T> = U;

// Each line fails to compile if our type drifts from the SDK's.
export type _Status = AssertAssignable<SdkExecutionStatus, ExecutionStatus>;
export type _StatusBack = AssertAssignable<ExecutionStatus, SdkExecutionStatus>;
export type _Write = AssertAssignable<SdkDirectWriteResult, DirectWriteResult>;
export type _Read = AssertAssignable<SdkDirectReadResult, DirectReadResult>;
export type _ExecStatus = AssertAssignable<SdkDirectExecutionStatus, DirectExecutionStatus>;
export type _LogEntry = AssertAssignable<SdkExecutionLogEntry, ExecutionLogEntry>;
