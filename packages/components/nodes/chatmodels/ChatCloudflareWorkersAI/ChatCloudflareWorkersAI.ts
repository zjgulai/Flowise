import { ChatCloudflareWorkersAI, type CloudflareWorkersAIInput } from '@langchain/cloudflare'
import type { BaseMessage } from '@langchain/core/messages'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { checkDenyList } from '../../../src/httpSecurity'
import { buildOriginBoundSecureFetch, resolveProviderBaseUrl } from '../providerUtils'

const CLOUDFLARE_OFFICIAL_ORIGIN = 'https://api.cloudflare.com'
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i
const CLOUDFLARE_MODEL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

function validateCloudflareAccountId(input: unknown): string {
    if (typeof input !== 'string' || !CLOUDFLARE_ACCOUNT_ID_PATTERN.test(input)) {
        throw new Error('Cloudflare Account ID must be a 32-character hexadecimal path segment.')
    }
    return input
}

function validateCloudflareModel(input: unknown): string {
    if (typeof input !== 'string') throw new Error('Cloudflare model must use safe @cf/<publisher>/<model> path segments.')

    const segments = input.split('/')
    if (
        segments.length !== 3 ||
        segments[0] !== '@cf' ||
        !CLOUDFLARE_MODEL_SEGMENT_PATTERN.test(segments[1]) ||
        !CLOUDFLARE_MODEL_SEGMENT_PATTERN.test(segments[2])
    ) {
        throw new Error('Cloudflare model must use safe @cf/<publisher>/<model> path segments.')
    }
    return input
}

function getCloudflareRequestPathPrefix(baseUrl: string, accountId: string): string {
    const endpoint = new URL(baseUrl)
    const basePath = endpoint.pathname.replace(/\/+$/, '')
    const officialBasePath = `/client/v4/accounts/${accountId}/ai/run`

    if (endpoint.origin === CLOUDFLARE_OFFICIAL_ORIGIN && basePath !== officialBasePath) {
        throw new Error('Cloudflare official Base URL must use the configured account AI run path.')
    }
    return `${basePath}/`
}

function assertCloudflareRequestPath(target: URL, requestPathPrefix: string): void {
    if (!target.pathname.startsWith(requestPathPrefix)) {
        throw new Error('Cloudflare request path is outside the configured AI run path.')
    }
}

class SecureChatCloudflareWorkersAI extends ChatCloudflareWorkersAI {
    private readonly transportFetch: ReturnType<typeof buildOriginBoundSecureFetch>
    private readonly requestPathPrefix: string

    constructor(fields: CloudflareWorkersAIInput, requestPathPrefix: string) {
        super(fields)
        this.requestPathPrefix = requestPathPrefix
        this.transportFetch = buildOriginBoundSecureFetch(this.baseUrl, (target) =>
            assertCloudflareRequestPath(target, this.requestPathPrefix)
        )
    }

    override async _request(messages: BaseMessage[], options: this['ParsedCallOptions'], stream?: boolean): Promise<Response> {
        this.validateEnvironment()
        const model = validateCloudflareModel(this.model)
        const target = new URL(`${this.baseUrl}/${model}`)
        assertCloudflareRequestPath(target, this.requestPathPrefix)
        const headers = {
            Authorization: `Bearer ${this.cloudflareApiToken}`,
            'Content-Type': 'application/json'
        }
        const data = { messages: this._formatMessages(messages), stream }

        return this.caller.call(async () => {
            const response = await this.transportFetch(target, {
                method: 'POST',
                headers,
                body: JSON.stringify(data),
                signal: options.signal
            })
            if (!response.ok) {
                const error = new Error(`Cloudflare LLM call failed with status code ${response.status}`)
                ;(error as Error & { response?: Response }).response = response
                throw error
            }
            return response
        })
    }
}

class ChatCloudflareWorkersAI_ChatModels implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Cloudflare Workers AI'
        this.name = 'chatCloudflareWorkersAI'
        this.version = 1.0
        this.type = 'ChatCloudflareWorkersAI'
        this.icon = 'cloudflare.svg'
        this.category = 'Chat Models'
        this.description = 'Wrapper around Cloudflare Workers AI chat models'
        this.baseClasses = [this.type, ...getBaseClasses(ChatCloudflareWorkersAI)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['cloudflareApi']
        }
        this.inputs = [
            {
                label: 'Model',
                name: 'model',
                type: 'string',
                default: '@cf/meta/llama-3.1-8b-instruct-fast',
                description: 'Model to use, e.g. @cf/meta/llama-3.1-8b-instruct-fast'
            },
            {
                label: 'Base URL',
                name: 'baseUrl',
                type: 'string',
                description: 'Base URL for Cloudflare Workers AI. Defaults to https://api.cloudflare.com/client/v4/accounts',
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<ChatCloudflareWorkersAI> {
        const model = nodeData.inputs?.model as string
        const baseUrl = nodeData.inputs?.baseUrl as string

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const cloudflareAccountIdInput = getCredentialParam('cloudflareAccountId', credentialData, nodeData)
        if (!cloudflareAccountIdInput) {
            throw new Error('Cloudflare Account ID is missing in credential.')
        }
        const cloudflareAccountId = validateCloudflareAccountId(cloudflareAccountIdInput)

        const cloudflareApiToken = getCredentialParam('cloudflareApiToken', credentialData, nodeData)
        if (!cloudflareApiToken) {
            throw new Error('Cloudflare API Token is missing in credential.')
        }

        const safeModel = validateCloudflareModel(model)
        const activeBaseUrl = resolveProviderBaseUrl(baseUrl, {
            providerLabel: 'Cloudflare Workers AI',
            defaultBaseUrl: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/ai/run`,
            officialOrigins: [CLOUDFLARE_OFFICIAL_ORIGIN],
            allowlistEnvVar: 'CLOUDFLARE_WORKERS_AI_BASE_URL_ALLOWLIST'
        })
        const requestPathPrefix = getCloudflareRequestPathPrefix(activeBaseUrl, cloudflareAccountId)
        await checkDenyList(activeBaseUrl)

        const obj: CloudflareWorkersAIInput = {
            cloudflareAccountId,
            cloudflareApiToken,
            model: safeModel,
            baseUrl: activeBaseUrl
        }

        const chatModel = new SecureChatCloudflareWorkersAI(obj, requestPathPrefix)
        return chatModel
    }
}

module.exports = { nodeClass: ChatCloudflareWorkersAI_ChatModels }
