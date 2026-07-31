import {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class KeeperHubApi implements ICredentialType {
	name = 'keeperHubApi';

	displayName = 'KeeperHub API';

	icon = 'file:keeperhub.svg' as const;

	documentationUrl = 'https://docs.keeperhub.com/api/authentication';

	properties: INodeProperties[] = [
		{
			displayName:
				'Need a key? Sign in at <a href="https://app.keeperhub.com" target="_blank">app.keeperhub.com</a>, then create an <b>organization</b> key (starts with <code>kh_</code>) under API Keys. Creating a key is session-only, so it cannot be done from n8n.',
			name: 'signupNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'kh_...',
			description:
				'Organization-scoped KeeperHub API key. Must start with kh_. User-scoped wfb_ keys authenticate webhook triggers only and will not work here.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://app.keeperhub.com/api',
			description: 'KeeperHub API base URL. Change only for self-hosted deployments.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Deliberately probes /projects rather than /workflows.
	 *
	 * GET /api/workflows resolves auth with `required: false` and returns
	 * `200 []` to anonymous and invalid callers alike, so it cannot
	 * distinguish a bad key from an empty account. KeeperHub's own CLI moved
	 * its credential probe off that endpoint for the same reason
	 * (KeeperHub/cli#75, KEEP-1049). /projects returns a real 401.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/projects',
		},
	};
}
