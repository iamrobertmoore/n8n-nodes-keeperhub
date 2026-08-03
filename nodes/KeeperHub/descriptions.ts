import type { INodeProperties } from 'n8n-workflow';

const isDirectWrite = { resource: ['transfer', 'contract'] };

export const description: INodeProperties[] = [
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		default: 'transfer',
		options: [
			{
				name: 'Transfer',
				value: 'transfer',
				description: 'Send native or ERC-20 tokens onchain',
			},
			{
				name: 'Contract',
				value: 'contract',
				description: 'Read from or write to a smart contract',
			},
			{
				name: 'Workflow',
				value: 'workflow',
				description: 'List, fetch or run a KeeperHub workflow',
			},
			{
				name: 'Execution',
				value: 'execution',
				description: 'Fetch the audit trail for a run',
			},
		],
	},

	// ---- Operations -------------------------------------------------------
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['transfer'] } },
		default: 'send',
		options: [
			{
				name: 'Send',
				value: 'send',
				description: 'Simulate, submit and confirm a token transfer',
				action: 'Send a transfer',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contract'] } },
		default: 'call',
		options: [
			{
				name: 'Call',
				value: 'call',
				description: 'Call a contract function (reads return immediately, writes are confirmed)',
				action: 'Call a contract function',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['workflow'] } },
		default: 'execute',
		options: [
			{ name: 'Execute', value: 'execute', action: 'Execute a workflow' },
			{ name: 'Get', value: 'get', action: 'Get a workflow' },
			{ name: 'List', value: 'list', action: 'List workflows' },
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['execution'] } },
		default: 'get',
		options: [
			{ name: 'Get', value: 'get', action: 'Get an execution' },
			{ name: 'Get Logs', value: 'getLogs', action: 'Get execution logs' },
		],
	},

	// ---- Shared: chain ----------------------------------------------------
	{
		displayName: 'Chain Name or ID',
		name: 'chainId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getChains' },
		required: true,
		default: 11155111,
		displayOptions: { show: isDirectWrite },
		description:
			'Chain to execute on. Loaded live from the KeeperHub API; testnets are listed first. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},

	// ---- Transfer ---------------------------------------------------------
	{
		displayName: 'Recipient',
		name: 'recipientMode',
		type: 'options',
		default: 'address',
		displayOptions: { show: { resource: ['transfer'] } },
		options: [
			{
				name: 'Address Book Entry',
				value: 'addressBook',
				description:
					'Pick a saved recipient by name. Safest for AI agents — they never handle raw hex.',
			},
			{
				name: 'Address',
				value: 'address',
				description: 'Enter a 0x address directly',
			},
		],
		description:
			'Where to send. Choosing from the address book means the address is resolved by KeeperHub rather than typed or generated.',
	},
	{
		displayName: 'Recipient Name or ID',
		name: 'addressBookEntry',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getAddressBook' },
		required: true,
		default: '',
		displayOptions: { show: { resource: ['transfer'], recipientMode: ['addressBook'] } },
		description:
			'Saved recipient from your KeeperHub address book, matched by label. Choose from the list, or specify a label using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Recipient Address',
		name: 'recipientAddress',
		type: 'string',
		required: true,
		default: '',
		placeholder: '0x...',
		displayOptions: { show: { resource: ['transfer'], recipientMode: ['address'] } },
		description: 'Address to send to',
	},
	{
		displayName: 'Amount',
		name: 'amount',
		type: 'string',
		required: true,
		default: '',
		placeholder: '0.001',
		displayOptions: { show: { resource: ['transfer'] } },
		description: 'Human-readable amount, not wei. For example 0.001.',
	},
	{
		displayName: 'Token Address',
		name: 'tokenAddress',
		type: 'string',
		default: '',
		placeholder: '0x... (leave empty for the native token)',
		displayOptions: { show: { resource: ['transfer'] } },
		description: 'ERC-20 contract address. Leave empty to send the chain native token.',
	},

	// ---- Contract ---------------------------------------------------------
	{
		displayName: 'Contract Address',
		name: 'contractAddress',
		type: 'string',
		required: true,
		default: '',
		placeholder: '0x...',
		displayOptions: { show: { resource: ['contract'] } },
	},
	{
		displayName: 'Function Name',
		name: 'functionName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'balanceOf',
		displayOptions: { show: { resource: ['contract'] } },
	},
	{
		displayName: 'Function Arguments',
		name: 'functionArgs',
		type: 'string',
		default: '',
		placeholder: '["0xabc...", "1000"]',
		displayOptions: { show: { resource: ['contract'] } },
		description: 'JSON-encoded array of arguments',
	},
	{
		displayName: 'ABI',
		name: 'abi',
		type: 'string',
		typeOptions: { rows: 3 },
		default: '',
		displayOptions: { show: { resource: ['contract'] } },
		description:
			'Contract ABI as a JSON string. Leave empty to let KeeperHub fetch it from the block explorer.',
	},
	{
		displayName: 'Value (Wei)',
		name: 'value',
		type: 'string',
		default: '',
		displayOptions: { show: { resource: ['contract'] } },
		description: 'Wei to send with a payable function',
	},

	// ---- Workflow ---------------------------------------------------------
	{
		displayName: 'Workflow Name or ID',
		name: 'workflowId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getWorkflows' },
		required: true,
		default: '',
		displayOptions: { show: { resource: ['workflow'], operation: ['get', 'execute'] } },
		description:
			'KeeperHub workflow to act on. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	},
	{
		displayName: 'Workflow Input',
		name: 'workflowInput',
		type: 'json',
		default: '{}',
		displayOptions: { show: { resource: ['workflow'], operation: ['execute'] } },
		description: 'JSON passed to the workflow trigger node',
	},

	// ---- Execution --------------------------------------------------------
	{
		displayName: 'Execution ID',
		name: 'executionId',
		type: 'string',
		required: true,
		default: '',
		displayOptions: { show: { resource: ['execution'] } },
	},
	{
		displayName: 'Execution Source',
		name: 'executionSource',
		type: 'options',
		default: 'direct',
		displayOptions: { show: { resource: ['execution'], operation: ['get'] } },
		options: [
			{
				name: 'Direct Execution',
				value: 'direct',
				description: 'A transfer or contract call made by this node',
			},
			{
				name: 'Workflow Execution',
				value: 'workflow',
				description: 'A run of a KeeperHub workflow',
			},
		],
		description:
			'Direct executions and workflow executions live on different routes, so the ID alone is not enough to tell them apart',
	},

	// ---- Options ----------------------------------------------------------
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: isDirectWrite },
		options: [
			{
				displayName: 'Simulate First',
				name: 'simulateFirst',
				type: 'boolean',
				default: true,
				description:
					'Whether to run a dry-run before submitting. Strongly recommended: it catches reverts without spending gas.',
			},
			{
				displayName: 'Abort on Simulation Failure',
				name: 'abortOnSimulationFailure',
				type: 'boolean',
				default: true,
				description:
					'Whether to stop when the simulation says the transaction would revert. Turn off to submit anyway.',
			},
			{
				displayName: 'Wait for Confirmation',
				name: 'waitForConfirmation',
				type: 'boolean',
				default: true,
				description:
					'Whether to poll until the execution reaches a terminal state and return the transaction hash',
			},
			{
				displayName: 'Fail on Reverted Execution',
				name: 'failOnRevert',
				type: 'boolean',
				default: true,
				description:
					'Whether to raise an error when the execution finishes in a failed state. Turn off to inspect the audit trail instead.',
			},
			{
				displayName: 'Timeout (Seconds)',
				name: 'timeoutSeconds',
				type: 'number',
				default: 180,
				description: 'How long to wait for a terminal state before giving up',
			},
			{
				displayName: 'Poll Interval (Seconds)',
				name: 'pollIntervalSeconds',
				type: 'number',
				default: 3,
				description:
					'Fallback interval between status checks. The server X-Poll-Interval-Hint header takes precedence when present.',
			},
			{
				displayName: 'Max Attempts',
				name: 'maxAttempts',
				type: 'number',
				default: 4,
				description:
					'Maximum HTTP attempts per call. Retries apply to rate limits and 5xx responses; Retry-After is honoured.',
			},
			{
				displayName: 'Base Backoff (Ms)',
				name: 'baseBackoffMs',
				type: 'number',
				default: 800,
				description: 'Starting delay for exponential backoff with full jitter',
			},
			{
				displayName: 'Gas Limit Multiplier',
				name: 'gasLimitMultiplier',
				type: 'string',
				default: '',
				placeholder: '1.2',
				description: 'Multiplier applied to the estimated gas limit',
			},
			{
				displayName: 'Idempotency Key',
				name: 'idempotencyKey',
				type: 'string',
				default: '',
				description:
					'Reuse a key to safely replay a submission within KeeperHub 24-hour window. Leave empty to generate one per item.',
			},
		],
	},
];
