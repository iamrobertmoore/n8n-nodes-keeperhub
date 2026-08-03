import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { keeperHubRequest, newRequestContext } from './transport';
import { FAILED_STATUSES, TERMINAL_STATUSES } from './types';

interface ExecutionSummary extends IDataObject {
	id?: string;
	executionId?: string;
	status?: string;
	createdAt?: string;
	completedAt?: string;
	transactionHash?: string;
}

/**
 * Makes the integration two-way.
 *
 * Without this, n8n can tell KeeperHub to do things but never hears back, so
 * anything reactive — alert me when an execution fails, log every landed
 * transaction, escalate a run that reverted — has to be built as a polling loop
 * by hand. KeeperHub emits no outbound webhook we can subscribe to, so this
 * polls the executions endpoint and does the bookkeeping once, properly.
 */
export class KeeperHubTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'KeeperHub Trigger',
		name: 'keeperHubTrigger',
		icon: { light: 'file:keeperhub.svg', dark: 'file:keeperhub-dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"]}}',
		description: 'Starts a workflow when a KeeperHub execution reaches a terminal state',
		defaults: { name: 'KeeperHub Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'keeperHubApi', required: true }],
		properties: [
			{
				displayName: 'Workflow Name or ID',
				name: 'workflowId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getWorkflows' },
				required: true,
				default: '',
				description:
					'KeeperHub workflow to watch. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				default: 'any',
				options: [
					{
						name: 'Any Terminal Execution',
						value: 'any',
						description: 'Anything that finished, whether it succeeded or not',
					},
					{
						name: 'Execution Succeeded',
						value: 'succeeded',
						description: 'Only runs that completed successfully',
					},
					{
						name: 'Execution Failed',
						value: 'failed',
						description: 'Only runs that failed, reverted or were cancelled',
					},
				],
			},
			{
				displayName: 'Include Audit Trail',
				name: 'includeAuditTrail',
				type: 'boolean',
				default: true,
				description:
					'Whether to fetch the full execution record for each match. Costs one extra request per execution.',
			},
		],
	};

	methods = {
		loadOptions: {
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

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const workflowId = this.getNodeParameter('workflowId') as string;
		const event = this.getNodeParameter('event') as string;
		const includeAuditTrail = this.getNodeParameter('includeAuditTrail') as boolean;

		if (!workflowId) {
			throw new NodeOperationError(this.getNode(), 'No KeeperHub workflow selected');
		}

		const reqCtx = newRequestContext();
		const res = await keeperHubRequest<ExecutionSummary[] | { data?: ExecutionSummary[] }>(
			this,
			reqCtx,
			{ method: 'GET', path: `/workflows/${encodeURIComponent(workflowId)}/executions` },
		);

		const raw = res.body;
		const executions: ExecutionSummary[] = Array.isArray(raw) ? raw : (raw?.data ?? []);

		const terminal = executions.filter((e) => TERMINAL_STATUSES.has(String(e.status ?? '')));

		const matching = terminal.filter((e) => {
			const failed = FAILED_STATUSES.has(String(e.status ?? ''));
			if (event === 'failed') return failed;
			if (event === 'succeeded') return !failed;
			return true;
		});

		const idOf = (e: ExecutionSummary): string => String(e.executionId ?? e.id ?? '');

		// Manual "Fetch Test Event" should show something rather than nothing, so
		// return the newest match without touching the watermark.
		if (this.getMode() === 'manual') {
			const newest = matching[0];
			if (!newest) return null;
			const enriched = includeAuditTrail
				? await fetchAuditTrail.call(this, idOf(newest), newest)
				: newest;
			return [[{ json: enriched }]];
		}

		const staticData = this.getWorkflowStaticData('node') as { seen?: string[] };
		const seen = new Set(staticData.seen ?? []);

		// First run adopts the current state as the baseline rather than
		// replaying the entire history into the user's workflow.
		if (staticData.seen === undefined) {
			staticData.seen = terminal.map(idOf);
			return null;
		}

		const fresh = matching.filter((e) => idOf(e) !== '' && !seen.has(idOf(e)));

		// Keep the watermark from growing without bound. Terminal executions never
		// change state, so remembering the most recent few hundred is plenty.
		staticData.seen = [...terminal.map(idOf), ...seen].slice(0, 500);

		if (fresh.length === 0) return null;

		const out: INodeExecutionData[] = [];
		for (const execution of fresh) {
			const json = includeAuditTrail
				? await fetchAuditTrail.call(this, idOf(execution), execution)
				: execution;
			out.push({ json });
		}

		return [out];
	}
}

/**
 * The list endpoint returns a summary; the transaction hash and gas figures
 * live on the individual execution record.
 */
async function fetchAuditTrail(
	this: IPollFunctions,
	executionId: string,
	fallback: ExecutionSummary,
): Promise<IDataObject> {
	if (!executionId) return fallback;

	const reqCtx = newRequestContext();
	const res = await keeperHubRequest<IDataObject>(this, reqCtx, {
		method: 'GET',
		path: `/workflows/executions/${encodeURIComponent(executionId)}/status`,
		throwOnError: false,
	});

	if (res.error || !res.body) return fallback;

	const detail = res.body;
	const inner = (detail.result ?? {}) as IDataObject;
	const units = inner.gasUsedUnits ?? detail.gasUsedWei;
	const price = inner.effectiveGasPrice ?? detail.gasPriceWei;

	const merged: IDataObject = { ...fallback, ...detail };
	if (units !== undefined) merged.gasUsedUnits = String(units);
	if (price !== undefined) merged.effectiveGasPriceWei = String(price);
	if (units !== undefined && price !== undefined) {
		try {
			merged.gasCostWei = (BigInt(String(units)) * BigInt(String(price))).toString();
		} catch {
			// Ignore non-integer values rather than guessing.
		}
	}
	delete merged.gasUsedWei;

	return merged;
}
