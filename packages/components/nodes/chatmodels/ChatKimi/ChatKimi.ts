import { ChatOpenAI, ChatOpenAIFields } from '@langchain/openai'
import { BaseCache } from '@langchain/core/caches'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import { getModels, MODEL_TYPE } from '../../../src/modelLoader'
import {
    buildSecureProviderConfiguration,
    parseOptionalProviderNumber,
    parseProviderHeaders,
    requireProviderApiKey,
    resolveProviderBaseUrl
} from '../providerUtils'

const KIMI_ENDPOINT_POLICY = {
    providerLabel: 'Kimi',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    officialOrigins: ['https://api.moonshot.cn'],
    allowlistEnvVar: 'KIMI_BASE_URL_ALLOWLIST'
}

class ChatKimi_ChatModels implements INode {
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
        this.label = 'Kimi (Moonshot)'
        this.name = 'chatKimi'
        this.version = 1.0
        this.type = 'ChatKimi'
        this.icon = 'kimi.svg'
        this.category = 'Chat Models'
        this.description = 'Kimi (Moonshot AI) 大语言模型，支持 OpenAI 兼容 API'
        this.baseClasses = [this.type, ...getBaseClasses(ChatOpenAI)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['kimiApi']
        }
        this.inputs = [
            {
                label: 'Cache',
                name: 'cache',
                type: 'BaseCache',
                optional: true
            },
            {
                label: 'Model Name',
                name: 'modelName',
                type: 'asyncOptions',
                loadMethod: 'listModels',
                default: 'kimi-k2.6'
            },
            {
                label: 'Temperature',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                optional: true,
                description: 'Leave empty for the provider default. K2 thinking uses 1; K2.6/K2.5 non-thinking uses 0.6.'
            },
            {
                label: 'Streaming',
                name: 'streaming',
                type: 'boolean',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Max Tokens',
                name: 'maxTokens',
                type: 'number',
                step: 1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Top Probability',
                name: 'topP',
                type: 'number',
                step: 0.1,
                optional: true,
                description: 'K2.7/K2.6/K2.5 require 0.95 when this value is supplied.',
                additionalParams: true
            },
            {
                label: 'Frequency Penalty',
                name: 'frequencyPenalty',
                type: 'number',
                step: 0.1,
                optional: true,
                description: 'K2.7/K2.6/K2.5 require 0 when this value is supplied.',
                additionalParams: true
            },
            {
                label: 'Presence Penalty',
                name: 'presencePenalty',
                type: 'number',
                step: 0.1,
                optional: true,
                description: 'K2.7/K2.6/K2.5 require 0 when this value is supplied.',
                additionalParams: true
            },
            {
                label: 'Timeout',
                name: 'timeout',
                type: 'number',
                step: 1,
                optional: true,
                description: 'Request timeout in milliseconds.',
                additionalParams: true
            },
            {
                label: 'Base Path',
                name: 'basepath',
                type: 'string',
                optional: true,
                default: 'https://api.moonshot.cn/v1',
                description: 'Kimi API 基础地址；自定义 origin 必须由 KIMI_BASE_URL_ALLOWLIST 明确允许。',
                additionalParams: true
            },
            {
                label: 'Base Options',
                name: 'baseOptions',
                type: 'json',
                optional: true,
                description: 'Additional HTTP headers for the Kimi client. This must be a JSON object.',
                additionalParams: true
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.CHAT, 'kimi')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const temperature = parseOptionalProviderNumber(nodeData.inputs?.temperature, 'Temperature', { min: 0, max: 1 })
        const modelName = (nodeData.inputs?.modelName as string) || 'kimi-k2.6'
        const maxTokens = parseOptionalProviderNumber(nodeData.inputs?.maxTokens, 'Max Tokens', { integer: true, min: 1 })
        const topP = parseOptionalProviderNumber(nodeData.inputs?.topP, 'Top Probability', { min: 0, max: 1 })
        const frequencyPenalty = parseOptionalProviderNumber(nodeData.inputs?.frequencyPenalty, 'Frequency Penalty', { min: -2, max: 2 })
        const presencePenalty = parseOptionalProviderNumber(nodeData.inputs?.presencePenalty, 'Presence Penalty', { min: -2, max: 2 })
        const timeout = parseOptionalProviderNumber(nodeData.inputs?.timeout, 'Timeout', { integer: true, min: 1 })
        const streaming = nodeData.inputs?.streaming as boolean
        const thinking = nodeData.inputs?.thinking
        const basePath = resolveProviderBaseUrl(nodeData.inputs?.basepath, KIMI_ENDPOINT_POLICY)
        const baseOptions = parseProviderHeaders(nodeData.inputs?.baseOptions, 'Kimi')
        const cache = nodeData.inputs?.cache as BaseCache

        const isKimiK27 = modelName.startsWith('kimi-k2.7')
        const isKimiK25Or26 = modelName === 'kimi-k2.5' || modelName === 'kimi-k2.6'
        if (thinking === true || thinking === 'true' || isKimiK27) {
            throw new Error('Kimi reasoning and thinking are not supported by this node transport')
        }
        if (isKimiK25Or26) {
            if (temperature !== undefined && temperature !== 0.6) throw new Error(`${modelName} temperature must be 0.6`)
            if (topP !== undefined && topP !== 0.95) throw new Error(`${modelName} Top Probability must be 0.95`)
            if (frequencyPenalty !== undefined && frequencyPenalty !== 0) throw new Error(`${modelName} Frequency Penalty must be 0`)
            if (presencePenalty !== undefined && presencePenalty !== 0) throw new Error(`${modelName} Presence Penalty must be 0`)
        }

        if (nodeData.inputs?.credentialId) {
            nodeData.credential = nodeData.inputs.credentialId
        }
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const kimiApiKey = requireProviderApiKey(getCredentialParam('kimiApiKey', credentialData, nodeData), 'Kimi')

        const obj: ChatOpenAIFields = {
            modelName,
            apiKey: kimiApiKey,
            streaming: streaming ?? true,
            maxRetries: 0
        }

        if (temperature !== undefined) obj.temperature = temperature
        if (maxTokens !== undefined && !isKimiK25Or26) obj.maxTokens = maxTokens
        if (topP !== undefined) obj.topP = topP
        if (frequencyPenalty !== undefined) obj.frequencyPenalty = frequencyPenalty
        if (presencePenalty !== undefined) obj.presencePenalty = presencePenalty
        if (timeout !== undefined) obj.timeout = timeout
        if (cache) obj.cache = cache
        if (isKimiK25Or26) {
            obj.modelKwargs = {
                thinking: { type: 'disabled' },
                ...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {})
            }
        }

        obj.configuration = buildSecureProviderConfiguration(basePath, baseOptions)

        const model = new ChatOpenAI(obj)
        return model
    }
}

module.exports = { nodeClass: ChatKimi_ChatModels }
