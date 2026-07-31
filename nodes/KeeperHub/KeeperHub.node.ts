import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { description } from './descriptions';
import {
	KeeperHubApiError,
	keeperHubRequest,
	newIdempotencyKey,
	newRequestContext,
	pollExecution,
} from './transport';
import type { Chain, SimulationResult } from './types';
import { FAILED_STATUSES, TERMINAL_STATUSES } from './types';

export class KeeperHub implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'KeeperHub',
		name: 'keeperHub',
		icon: { light: 'file:keeperhub.svg', dark: 'file:keeperhub-dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Execute onchain transactions through KeeperHub, with simulate-first safety, idempotent retries and a full audit trail',
		defaults: { name: 'KeeperHub' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'keeperHubApi', required: true }],
		properties: description,
	};

	methods = {
		loadOptions: {
			/**
			 * Chains come from the live API rather than a hardcoded list: the docs
			 * list 9, the API returns 22. Testnets are listed first because a first
			 * write should not land on mainnet by accident. Solana entries are
			 * filtered out — their chainId (101/103) is not an EVM chain id and the
			 * direct-execution endpoints this node uses are EVM-shaped.
			 */
			async getChains(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const reqCtx = newRequestContext();
				const res = await keeperHubRequest<Chain[] | { data?: Chain[] }>(this, reqCtx, {
					method: 'GET',
					path: '/chains',
				});

				const raw = res.body;
				const chains: Chain[] = Array.isArray(raw) ? raw : (raw?.data ?? []);

				const usable = chains.filter(
					(c) => c.isEnabled !== false && (c.chainType ?? 'evm') === 'evm',
				);
				const sorted = [...usable].sort((a, b) => {
					if (!!a.isTestnet !== !!b.isTestnet) return a.isTestnet ? -1 : 1;
					return (a.name ?? '').localeCompare(b.name ?? '');
				});

				return sorted.map((c) => {
					const notes = [`Chain ID ${c.chainId}`];
					if (c.symbol) notes.push(c.symbol);
					notes.push(c.isTestnet ? 'testnet' : 'MAINNET — real funds');
					if (c.usePrivateMempoolRpc) notes.push('private mempool (MEV protected)');
					return {
						name: `${c.name ?? c.chainId}${c.isTestnet ? ' (testnet)' : ''}`,
						value: c.chainId,
						description: notes.join(' · '),
					};
				});
			},

			async getWorkflows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const reqCtx = newRequestContext();
				const res = await keeperHubRequest<Array<{ id: string; name?: string }>>(this, reqCtx, {
					method: 'GET',
					path: '/workflows',
				});
				const items = Array.isArray(res.body) ? res.body : [];
				return items.map((w) => ({ name: w.name ?? w.id, value: w.id }));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				let output: IDataObject;

				if (resource === 'transfer' && operation === 'send') {
					output = await runDirectWrite.call(this, i, 'transfer');
				} else if (resource === 'contract' && operation === 'call') {
					output = await runDirectWrite.call(this, i, 'contract-call');
				} else if (resource === 'workflow') {
					output = await runWorkflow.call(this, i, operation);
				} else if (resource === 'execution') {
					output = await runExecution.call(this, i, operation);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported operation "${operation}" for resource "${resource}"`,
						{ itemIndex: i },
					);
				}

				returnData.push({ json: output, pairedItem: { item: i } });
			} catch (error) {
				const nodeError =
					error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });

				// `continueOnFail()` is true for BOTH "continue (using error output)" and
				// "continue (using regular output)", so it cannot tell us which branch the
				// user wants. What routes an item to the error output is the `error`
				// property on INodeExecutionData — without it the engine sees a clean
				// return and sends everything down output 0.
				if (this.continueOnFail()) {
					const json: IDataObject = { error: (error as Error).message };
					if (error instanceof KeeperHubApiError) {
						json.keeperhub = error.normalised as unknown as IDataObject;
					}
					returnData.push({ json, error: nodeError, pairedItem: { item: i } });
					continue;
				}
				throw nodeError;
			}
		}

		return [returnData];
	}
}

/**
 * The documented Safe First-Write Sequence, implemented once:
 *
 *   simulate -> gate on success && !wouldRevert -> execute with an
 *   Idempotency-Key -> poll to a terminal state -> return the transaction hash.
 *
 * Every stage is surfaced in the output so the audit trail is visible in the
 * n8n output panel rather than buried in the platform.
 */
async function runDirectWrite(
	this: IExecuteFunctions,
	i: number,
	kind: 'transfer' | 'contract-call',
): Promise<IDataObject> {
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	const reqCtx = newRequestContext({
		maxAttempts: (options.maxAttempts as number) ?? 4,
		baseBackoffMs: (options.baseBackoffMs as number) ?? 800,
	});

	const chainId = this.getNodeParameter('chainId', i) as number;
	const payload: IDataObject = { chainId, network: String(chainId) };

	if (kind === 'transfer') {
		payload.recipientAddress = this.getNodeParameter('recipientAddress', i) as string;
		payload.amount = String(this.getNodeParameter('amount', i));
		const tokenAddress = this.getNodeParameter('tokenAddress', i, '') as string;
		if (tokenAddress) payload.tokenAddress = tokenAddress;
	} else {
		payload.contractAddress = this.getNodeParameter('contractAddress', i) as string;
		payload.functionName = this.getNodeParameter('functionName', i) as string;
		const functionArgs = this.getNodeParameter('functionArgs', i, '') as string;
		if (functionArgs) payload.functionArgs = functionArgs;
		const abi = this.getNodeParameter('abi', i, '') as string;
		if (abi) payload.abi = abi;
		const value = this.getNodeParameter('value', i, '') as string;
		if (value) payload.value = value;
	}

	if (options.gasLimitMultiplier) {
		payload.gasLimitMultiplier = String(options.gasLimitMultiplier);
	}

	const path = `/execute/${kind}`;
	const result: IDataObject = { chainId, operation: kind };

	// --- 1. Simulate -------------------------------------------------------
	const simulateFirst = options.simulateFirst !== false;
	let simulation: SimulationResult | undefined;

	if (simulateFirst) {
		const simRes = await keeperHubRequest<SimulationResult>(this, reqCtx, {
			method: 'POST',
			path,
			body: { ...payload, simulate: true },
			throwOnError: false,
		});

		if (simRes.error) {
			result.simulation = { attempted: true, failed: true, error: simRes.error };
			result.status = 'simulation-failed';
			result.attempts = reqCtx.attempts as unknown as IDataObject[];
			if (options.abortOnSimulationFailure !== false) {
				throw new KeeperHubApiError(simRes.error);
			}
			return result;
		}

		simulation = simRes.body ?? {};
		result.simulation = simulation as unknown as IDataObject;

		const wouldRevert = simulation.wouldRevert === true;
		const explicitlyFailed = simulation.success === false;

		if ((wouldRevert || explicitlyFailed) && options.abortOnSimulationFailure !== false) {
			result.status = 'aborted-by-simulation';
			result.attempts = reqCtx.attempts as unknown as IDataObject[];
			throw new KeeperHubApiError({
				message: 'Simulation says this transaction would revert; not submitting',
				detail: (simulation.revertReason as string) ?? undefined,
				hint: 'Turn off "Abort on Simulation Failure" to submit anyway.',
				envelope: 'structured',
				raw: simulation,
			});
		}
	}

	// --- 2. Execute --------------------------------------------------------
	const idempotencyKey = (options.idempotencyKey as string) || newIdempotencyKey();
	result.idempotencyKey = idempotencyKey;

	const execRes = await keeperHubRequest<IDataObject>(this, reqCtx, {
		method: 'POST',
		path,
		body: payload,
		idempotencyKey,
	});

	const executionId = String(execRes.body?.executionId ?? '');
	result.executionId = executionId;
	result.status = String(execRes.body?.status ?? 'unknown');

	// A read-only contract call returns a value synchronously and has no execution to poll.
	if (!executionId && execRes.body?.result !== undefined) {
		result.result = execRes.body.result;
		result.status = 'success';
		result.attempts = reqCtx.attempts as unknown as IDataObject[];
		return result;
	}

	// --- 3. Poll to terminal ----------------------------------------------
	const waitForConfirmation = options.waitForConfirmation !== false;
	if (waitForConfirmation && executionId) {
		const polled = await pollExecution(this, reqCtx, executionId, {
			timeoutMs: ((options.timeoutSeconds as number) ?? 180) * 1000,
			fallbackIntervalMs: ((options.pollIntervalSeconds as number) ?? 3) * 1000,
			isTerminal: (status) => TERMINAL_STATUSES.has(status),
		});

		const final = polled.body;
		result.status = String(final.status ?? result.status);
		result.polls = polled.polls;
		result.timedOut = polled.timedOut;
		if (final.transactionHash) result.transactionHash = final.transactionHash;
		if (final.transactionLink) result.transactionLink = final.transactionLink;
		if (final.error) result.executionError = final.error;

		// KeeperHub's `gasUsedWei` is byte-identical to `result.gasUsedUnits` — it is a
		// gas *unit count*, not a wei amount, so using it as a cost understates spend by
		// ~9 orders of magnitude. We surface both under honest names and compute the
		// real cost, so nobody builds a spending cap on the mislabelled field.
		const inner = (final.result ?? {}) as IDataObject;
		const units = inner.gasUsedUnits ?? final.gasUsedWei;
		const price = inner.effectiveGasPrice ?? final.gasPriceWei;
		if (units !== undefined) result.gasUsedUnits = String(units);
		if (price !== undefined) result.effectiveGasPriceWei = String(price);
		if (units !== undefined && price !== undefined) {
			try {
				result.gasCostWei = (BigInt(String(units)) * BigInt(String(price))).toString();
			} catch {
				// Non-integer values from a future API change: omit rather than guess.
			}
		}
		if (inner.sponsored !== undefined) result.sponsored = inner.sponsored;
		if (final.completedAt) result.completedAt = final.completedAt;
		result.auditTrail = final as unknown as IDataObject;

		if (FAILED_STATUSES.has(String(final.status ?? '')) && options.failOnRevert !== false) {
			result.attempts = reqCtx.attempts as unknown as IDataObject[];
			throw new KeeperHubApiError({
				message: `Execution ${executionId} finished with status "${final.status}"`,
				detail: typeof final.error === 'string' ? final.error : undefined,
				hint: 'The full audit trail is on the execution record; fetch it with the Execution resource.',
				envelope: 'structured',
				raw: final,
			});
		}
	}

	result.attempts = reqCtx.attempts as unknown as IDataObject[];
	result.retried = reqCtx.attempts.some((a) => a.outcome === 'retried');
	return result;
}

async function runWorkflow(
	this: IExecuteFunctions,
	i: number,
	operation: string,
): Promise<IDataObject> {
	const reqCtx = newRequestContext();

	if (operation === 'list') {
		const res = await keeperHubRequest<IDataObject[]>(this, reqCtx, {
			method: 'GET',
			path: '/workflows',
		});
		return { workflows: res.body ?? [], attempts: reqCtx.attempts as unknown as IDataObject[] };
	}

	const workflowId = this.getNodeParameter('workflowId', i) as string;

	if (operation === 'get') {
		const res = await keeperHubRequest<IDataObject>(this, reqCtx, {
			method: 'GET',
			path: `/workflows/${encodeURIComponent(workflowId)}`,
		});
		return { ...(res.body ?? {}), attempts: reqCtx.attempts as unknown as IDataObject[] };
	}

	if (operation === 'execute') {
		const inputJson = this.getNodeParameter('workflowInput', i, '{}') as string;
		let parsed: IDataObject = {};
		try {
			parsed = inputJson ? (JSON.parse(inputJson) as IDataObject) : {};
		} catch {
			throw new NodeOperationError(this.getNode(), 'Workflow Input is not valid JSON', {
				itemIndex: i,
			});
		}

		const idempotencyKey = newIdempotencyKey();
		// Note: the execute route is singular (/workflow/{id}/execute) while every
		// other workflow route is plural. Matching the server, not the pattern.
		const res = await keeperHubRequest<IDataObject>(this, reqCtx, {
			method: 'POST',
			path: `/workflow/${encodeURIComponent(workflowId)}/execute`,
			body: parsed,
			idempotencyKey,
		});

		const executionId = String(res.body?.executionId ?? '');
		const out: IDataObject = {
			workflowId,
			executionId,
			idempotencyKey,
			status: res.body?.status ?? 'unknown',
		};

		const waitForConfirmation = this.getNodeParameter(
			'options.waitForConfirmation',
			i,
			true,
		) as boolean;

		if (waitForConfirmation && executionId) {
			const polled = await pollExecution(this, reqCtx, executionId, {
				timeoutMs: 180_000,
				fallbackIntervalMs: 3000,
				isTerminal: (status) => TERMINAL_STATUSES.has(status),
			});
			out.status = polled.body.status ?? out.status;
			out.polls = polled.polls;
			out.timedOut = polled.timedOut;
			out.auditTrail = polled.body;
		}

		out.attempts = reqCtx.attempts as unknown as IDataObject[];
		return out;
	}

	throw new NodeOperationError(this.getNode(), `Unknown workflow operation "${operation}"`, {
		itemIndex: i,
	});
}

async function runExecution(
	this: IExecuteFunctions,
	i: number,
	operation: string,
): Promise<IDataObject> {
	const reqCtx = newRequestContext();
	const executionId = this.getNodeParameter('executionId', i) as string;
	const source = this.getNodeParameter('executionSource', i, 'direct') as string;

	if (operation === 'get') {
		const path =
			source === 'workflow'
				? `/workflows/executions/${encodeURIComponent(executionId)}/status`
				: `/execute/${encodeURIComponent(executionId)}/status`;
		const res = await keeperHubRequest<IDataObject>(this, reqCtx, { method: 'GET', path });
		return { ...(res.body ?? {}), attempts: reqCtx.attempts as unknown as IDataObject[] };
	}

	if (operation === 'getLogs') {
		const res = await keeperHubRequest<IDataObject>(this, reqCtx, {
			method: 'GET',
			path: `/workflows/executions/${encodeURIComponent(executionId)}/logs`,
		});
		return {
			executionId,
			logs: res.body?.data ?? res.body ?? [],
			attempts: reqCtx.attempts as unknown as IDataObject[],
		};
	}

	throw new NodeOperationError(this.getNode(), `Unknown execution operation "${operation}"`, {
		itemIndex: i,
	});
}
