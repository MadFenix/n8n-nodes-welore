import {
	IAuthenticateGeneric,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class WeLoreApi implements ICredentialType {
	name = 'weLoreApi';
	displayName = 'weLore API';
	documentationUrl = 'https://api-weafinity.madfenix.com/docs';
	properties: INodeProperties[] = [
		{
			displayName: 'Token',
			name: 'token',
			type: 'string',
			typeOptions: { password: true },
			default: '',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: 'Bearer={{credentials.token}}',
			},
		},
	};
}
