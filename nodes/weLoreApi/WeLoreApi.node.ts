import {
	INodeType,
	INodeTypeDescription,
	IExecuteFunctions,
	NodeConnectionType,
	ApplicationError,
	IHttpRequestOptions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeProperties,
} from 'n8n-workflow';
import * as fs from 'fs';
import { parse as yamlParse } from 'yaml';
import path from 'node:path';

// Interface for OpenAPI schema
interface IOpenApiSchema {
	paths: {
		[path: string]: {
			[method: string]: {
				summary?: string;
				description?: string;
				operationId?: string;
				parameters?: Array<{
					name: string;
					in: string;
					description?: string;
					required?: boolean;
					schema?: {
						type?: string;
						format?: string;
						enum?: string[];
						default?: any;
					};
				}>;
				requestBody?: {
					content: {
						'application/json': {
							schema: {
								properties: {
									[key: string]: {
										type?: string;
										format?: string;
										description?: string;
										enum?: string[];
										default?: any;
									};
								};
								required?: string[];
							};
						};
					};
				};
			};
		};
	};
}

// Cache for OpenAPI schema
let openApiSchemaCache: IOpenApiSchema | null = null;
let resourcesCache: { [key: string]: { [key: string]: any } } = {};

// Function to fetch OpenAPI schema
async function fetchOpenApiSchema(this: ILoadOptionsFunctions | IExecuteFunctions): Promise<IOpenApiSchema> {
	if (openApiSchemaCache) {
		return openApiSchemaCache;
	}

	try {
		const schemaContent = fs.readFileSync(path.join(__dirname, 'docs.openapi.yaml'), 'utf-8');
		const response = yamlParse(schemaContent);

		openApiSchemaCache = response;
		return response;
	} catch (error) {
		throw new ApplicationError(`Failed to load OpenAPI schema from file: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// Function to extract resources from OpenAPI schema
function extractResources(schema: IOpenApiSchema): INodePropertyOptions[] {
	const resources: { [key: string]: string } = {};
	const excludedSuffixes = ['download', 'fields', 'upload'];

	// Group paths by resource
	for (const path in schema.paths) {
		const pathParts = path.split('/').filter(Boolean);
		if (pathParts.length > 2) {
			if (pathParts[2] == 'manager' && pathParts.length > 3) {
				const resource = pathParts[3];
				if (resource && !excludedSuffixes.some(suffix => resource.endsWith(suffix))) {
					resources[resource] = resource;
				}
			} else {
				const resource = pathParts[2];
				if (resource && !excludedSuffixes.some(suffix => resource.endsWith(suffix))) {
					resources[resource] = resource;
				}
			}
		}
	}

	// Convert to options format
	return Object.keys(resources).map(resource => ({
		name: resource.charAt(0).toUpperCase() + resource.slice(1),
		value: resource,
	}));
}

// Function to extract operations for a resource
function extractOperations(schema: IOpenApiSchema, resource: string): INodePropertyOptions[] {
	const operations: { [key: string]: { name: string; value: string; path: string; method: string } } = {};

	// Find all paths that start with the resource
	for (const path in schema.paths) {
		if (path.startsWith(`/api/{account}/${resource}`) || path.startsWith(`/api/{account}/manager/${resource}`)) {
			for (const method in schema.paths[path]) {
				const endpoint = schema.paths[path][method];
				const operationId = endpoint.operationId || `${method}${path.replace(/\//g, '_')}`;
				const summary = endpoint.summary || `${method.toUpperCase()} ${path}`;

				operations[operationId] = {
					name: summary,
					value: operationId,
					path,
					method,
				};
			}
		}
	}

	// Cache the operations for this resource
	resourcesCache[resource] = operations;

	// Convert to options format
	return Object.values(operations).map(op => ({
		name: op.name,
		value: op.value,
	}));
}

// Function to generate properties for an operation
function generateProperties(schema: IOpenApiSchema, resource: string, operationId: string): INodeProperties[] {
	const properties: INodeProperties[] = [];
	const operation = resourcesCache[resource][operationId];

	if (!operation) {
		throw new ApplicationError(`Operation ${operationId} not found for resource ${resource}`);
	}

	const { path, method } = operation;
	const endpoint = schema.paths[path][method];

	// Add URL parameters
	if (endpoint.parameters) {
		for (const param of endpoint.parameters) {
			if (param.in === 'path' || param.in === 'query') {
				properties.push({
					displayName: param.name,
					name: param.name,
					type: param.schema?.type === 'number' ? 'number' : 'string',
					required: !!param.required,
					default: param.schema?.default || '',
					description: param.description,
				});
			}
		}
	}

	// Add body parameters
	if (endpoint.requestBody?.content?.['application/json']?.schema?.properties) {
		const bodySchema = endpoint.requestBody.content['application/json'].schema;
		const requiredFields = bodySchema.required || [];

		for (const [propName, propSchema] of Object.entries(bodySchema.properties)) {
			properties.push({
				displayName: propName,
				name: propName,
				type: propSchema.type === 'number' ? 'number' : 'string',
				required: requiredFields.includes(propName),
				default: propSchema.default || '',
				description: propSchema.description,
			});
		}
	}

	return properties;
}

// Function to resolve request mapping based on OpenAPI schema
async function resolveMapping(
	this: ILoadOptionsFunctions | IExecuteFunctions,
	resource: string,
	operationId: string,
	account: string,
): Promise<{ request: any; properties: INodeProperties[] }> {
	try {
		const schema = await fetchOpenApiSchema.call(this);

		if (!resourcesCache[resource] || !resourcesCache[resource][operationId]) {
			// Rebuild the cache if needed
			extractOperations(schema, resource);
		}

		const operation = resourcesCache[resource][operationId];
		if (!operation) {
			throw new ApplicationError(`Operation ${operationId} not found for resource ${resource}`);
		}

		const { path, method } = operation;
		const properties = generateProperties(schema, resource, operationId);

		// Build the request object
		const request: any = {
			method: method.toUpperCase(),
			url: path,
		};

		// Handle path parameters
		let processedUrl = path;
		const endpoint = schema.paths[path][method];

		if (endpoint.parameters) {
			processedUrl = processedUrl.replace(`{acccount}`, account);
			for (const param of endpoint.parameters) {
				if (param.in === 'path') {
					processedUrl = processedUrl.replace(`{${param.name}}`, `{{$parameter.${param.name}}}`);
				}
			}
		}

		request.url = 'https://api-weafinity.madfenix.com' + processedUrl;

		return {
			request,
			properties,
		};
	} catch (error) {
		throw new ApplicationError(`Failed to resolve mapping: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export class WeLoreApi implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'weLore API',
		name: 'weLoreApi',
		icon: 'file:welorenode.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
		description: 'Interactúa con la API REST de weLore usando OpenAPI',
		defaults: { name: 'weLore API Tool' },
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		credentials: [
			{ name: 'weLoreApi', required: true },
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
				displayName: 'Account Name',
				name: 'account',
				type: 'string',
				required: true,
				default: 'host',
				description: 'The name of the account',
			},
			{
				displayName: 'Resource Name or ID',
				name: 'resource',
				type: 'options',
				typeOptions: {
						loadOptionsMethod: 'getResources',
				},
				default: '',
				required: true,
				noDataExpression: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Operation Name or ID',
				name: 'operation',
				type: 'options',
				typeOptions: {
					loadOptionsDependsOn: ['resource'],
					loadOptionsMethod: 'getOperations',
				},
				default: '',
				required: true,
				noDataExpression: true,
				description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			// Dynamic properties will be loaded based on the selected resource and operation
			{
				displayName: 'Parameters',
				name: 'parameters',
				type: 'fixedCollection',
				placeholder: 'Add Parameter',
				default: {},
				typeOptions: {
					multipleValues: true,
				},
				options: [
					{
						name: 'parameter',
						displayName: 'Parameter',
						values: [
							{
								displayName: 'Parameter Name or ID',
								name: 'name',
								type: 'options',
								typeOptions: {
									loadOptionsMethod: 'getAdditionalFields',
									loadOptionsDependsOn: ['resource', 'operation'],
								},
								default: '',
								description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
							},
							{
								displayName: 'Value',
								name: 'value',
								type: 'string',
								default: '',
								description: 'Value of the parameter',
							},
						],
					},
				],
			},
		],
	};

	methods = {
		loadOptions: {
			// Get resources from OpenAPI schema
			async getResources(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const schema = await fetchOpenApiSchema.call(this);
					return extractResources(schema);
				} catch (error) {
					throw new ApplicationError(`Failed to load resources: ${error instanceof Error ? error.message : String(error)}`);
				}
			},

			// Get operations for a resource
			async getOperations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				try {
					const resource = this.getCurrentNodeParameter('resource') as string;
					const schema = await fetchOpenApiSchema.call(this);
					return extractOperations(schema, resource);
				} catch (error) {
					throw new ApplicationError(`Failed to load operations: ${error instanceof Error ? error.message : String(error)}`);
				}
			},

			// Get additional fields for a resource and operation
			async getAdditionalFields(
				this: ILoadOptionsFunctions
			): Promise<INodePropertyOptions[]> {
				try {
					const account = this.getCurrentNodeParameter('account') as string;
					const resource = this.getCurrentNodeParameter('resource') as string;
					const operation = this.getCurrentNodeParameter('operation') as string;

					if (!resource || !operation) {
						return [];
					}

					const { properties } = await resolveMapping.call(this, resource, operation, account);

					// Convert properties to options format
					return properties.map(property => ({
						name: property.displayName || property.name,
						value: property.name,
						description: property.description,
					}));
				} catch (error) {
					throw new ApplicationError(`Failed to load additional fields: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
	};

	async execute(this: IExecuteFunctions) {
		const items = this.getInputData();
		const returnData: any[] = [];

		const account = this.getNodeParameter('account', 0) as string;
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Get the dynamic properties and request options for this resource and operation
		const { request, properties } = await resolveMapping.call(this, resource, operation, account);

		for (let i = 0; i < items.length; i++) {
			try {
				// Build the request body and URL parameters
				const body: Record<string, any> = {};
				const queryParameters: Record<string, any> = {};

				// Get parameters from the fixedCollection
				try {
					const parameters = this.getNodeParameter('parameters.parameter', i, []) as Array<{
						name: string;
						value: string;
					}>;

					// Process each parameter
					for (const param of parameters) {
						const { name, value } = param;

						// Find the property definition for this parameter
						const propertyDef = properties.find(p => p.name === name);

						if (!propertyDef) {
							// Skip unknown parameters
							continue;
						}

						// Determine if this is a path parameter, query parameter, or body parameter
						if (request.url.includes(`{{$parameter.${name}}}`)) {
							// This is a path parameter, handled by URL template substitution
							// We need to replace the template with the actual value
							request.url = request.url.replace(`{{$parameter.${name}}}`, value);
						} else if (
							name.toLowerCase().includes('query') ||
							propertyDef.description?.toLowerCase().includes('query parameter') ||
							propertyDef.description?.toLowerCase().includes('in: query')
						) {
							queryParameters[name] = value;
						} else {
							// Default to body parameter
							body[name] = value;
						}
					}
				} catch (error) {
					// No parameters provided, continue with empty body and query
				}

				// Prepare the request options
				const options: IHttpRequestOptions = {
					method: request.method as IHttpRequestMethods,
					url: request.url,
					body: Object.keys(body).length > 0 ? body : undefined,
					qs: Object.keys(queryParameters).length > 0 ? queryParameters : undefined,
					json: true,
				};

				// Execute the request
				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					'weLoreApi',
					options
				);

				// Process the response
				const responseData = await response.json();
				returnData.push(responseData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ error: error.message });
					continue;
				}
				throw error instanceof Error ? error : new Error(String(error));
			}
		}

		return returnData;
	}
}
