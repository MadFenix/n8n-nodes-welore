import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	NodeConnectionType,
	ApplicationError,
	ICredentialDataDecryptedObject,
	IHttpRequestOptions, IHttpRequestMethods,
} from 'n8n-workflow';

const resolveMapping = (resource: string, operation: string) => {
	if (resource === 'user') {
		if (operation === 'createUser') {
			return {
				request: { method: 'POST', url: '/users', body: { name: '=name', role: '=role' } },
				properties: [
					{ displayName: 'Name', name: 'name', type: 'string', required: true, default: '' },
					{ displayName: 'Role', name: 'role', type: 'string', default: '' },
				],
			};
		}
		if (operation === 'getUser') {
			return {
				request: { method: 'GET', url: '/users/{{$parameter.userId}}' },
				properties: [
					{ displayName: 'User ID', name: 'userId', type: 'string', required: true, default: '' },
				],
			};
		}
	}
	if (resource === 'lore' && operation === 'getLore') {
		return {
			request: { method: 'GET', url: '/lore/{{$parameter.slug}}' },
			properties: [
				{ displayName: 'Slug', name: 'slug', type: 'string', required: true, default: '' },
			],
		};
	}
	throw new ApplicationError(`No mapping defined for ${resource}.${operation}`);
}

export class WeLoreApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'weLore API',
		name: 'weLoreApi',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Interactúa con la API REST de weLore usando resourceMapper',
		defaults: { name: 'weLore API Tool' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{ name: 'weLoreCredentialsApi', required: true },
		],
		requestDefaults: {
			baseURL: '={{$credentials.baseUrl}}',
			headers: {
				Authorization: 'Bearer {{$credentials.token}}',
				'Content-Type': 'application/json',
			},
		},
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				options: [
					{ name: 'User', value: 'user' },
					{ name: 'Lore Entry', value: 'lore' },
				],
				default: 'user',
				required: true,
				noDataExpression: true,
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				displayOptions: { show: { resource: ['user', 'lore'] } },
				options: [
					{ name: 'Create User', value: 'createUser', action: 'Create a user' },
					{ name: 'Get User', value: 'getUser', action: 'Get a user' },
					{ name: 'Get Lore Entry', value: 'getLore', action: 'Get a lore entry' },
				],
				default: 'createUser',
				required: true,
				noDataExpression: true,
			},
		],
	};

	async execute(this: IExecuteFunctions) {
		const items = this.getInputData();
		const returnData: any[] = [];

		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0, '') as string;

		for (let i = 0; i < items.length; i++) {
			const requestOptions = resolveMapping(resource, operation);

			// Make credentials retrieval optional
			let credentials: ICredentialDataDecryptedObject = {};
			try {
				credentials = await this.getCredentials('WeLoreApi') as ICredentialDataDecryptedObject;
			} catch (error) {
				// If credentials are not provided, continue without them
				if (!(error.message && error.message.includes('does not require credentials'))) {
					throw error;
				}
			}

			const headers: Record<string, string> = {};
			if (credentials.token) {
				headers['Authorization'] = `Bearer ${credentials.token}`;
			}

			// Execute the request
			try {
				const options: IHttpRequestOptions = {
					method: requestOptions.request.method.toUpperCase() as IHttpRequestMethods,
					url: credentials.baseUrl + requestOptions.request.url,
					body: {
						name: 'Valentí',
						role: 'Productor',
					},
					json: true,
				};

				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'weLoreApi',
					options
				);

				if (!response.ok) {
					const errorText = await response.text();
					throw new ApplicationError(`Request failed with status code ${response.status}: ${errorText}`);
				}

				return await response.json();
			} catch (error) {
				throw error instanceof Error ? error : new Error(String(error));
			}
		}

		return returnData;
	}
}
