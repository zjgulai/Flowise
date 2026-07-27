import { BaseCache } from '@langchain/core/caches'
import { ChatDeepSeek, ChatDeepSeekInput } from '@langchain/deepseek'
import { ICommonObject, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { getModels, MODEL_TYPE } from '../../../src/modelLoader'
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import {
    buildSecureProviderConfiguration,
    parseOptionalProviderNumber,
    parseProviderHeaders,
    requireProviderApiKey,
    resolveProviderBaseUrl
} from '../providerUtils'

const DEEPSEEK_ENDPOINT_POLICY = {
    providerLabel: 'Deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    officialOrigins: ['https://api.deepseek.com'],
    allowlistEnvVar: 'DEEPSEEK_BASE_URL_ALLOWLIST'
}

class Deepseek_ChatModels implements INode {
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
        this.label = 'Deepseek'
        this.name = 'chatDeepseek'
        this.version = 1.0
        this.type = 'chatDeepseek'
        this.icon = 'deepseek.svg'
        this.category = 'Chat Models'
        this.description = 'Wrapper around Deepseek large language models that use the Chat endpoint'
        this.baseClasses = [this.type, ...getBaseClasses(ChatDeepSeek)]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['deepseekApi']
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
                default: 'deepseek-v4-flash'
            },
            {
                label: 'Temperature',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                default: 0.7,
                optional: true
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
                additionalParams: true
            },
            {
                label: 'Frequency Penalty',
                name: 'frequencyPenalty',
                type: 'number',
                step: 0.1,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Presence Penalty',
                name: 'presencePenalty',
                type: 'number',
                step: 0.1,
                optional: true,
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
                label: 'Stop Sequence',
                name: 'stopSequence',
                type: 'string',
                rows: 4,
                optional: true,
                description: 'List of stop words to use when generating. Use comma to separate multiple stop words.',
                additionalParams: true
            },
            {
                label: 'Base Path',
                name: 'basepath',
                type: 'string',
                optional: true,
                default: 'https://api.deepseek.com',
                description: 'Deepseek API 基础地址；自定义 origin 必须由 DEEPSEEK_BASE_URL_ALLOWLIST 明确允许。',
                additionalParams: true
            },
            {
                label: 'Base Options',
                name: 'baseOptions',
                type: 'json',
                optional: true,
                additionalParams: true,
                description: 'Additional HTTP headers for the Deepseek client. This must be a JSON object.'
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listModels(): Promise<INodeOptionsValue[]> {
            return await getModels(MODEL_TYPE.CHAT, 'deepseek')
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const temperature = parseOptionalProviderNumber(nodeData.inputs?.temperature, 'Temperature', { min: 0, max: 2 })
        const modelName = (nodeData.inputs?.modelName as string) || 'deepseek-v4-flash'
        const maxTokens = parseOptionalProviderNumber(nodeData.inputs?.maxTokens, 'Max Tokens', { integer: true, min: 1 })
        const topP = parseOptionalProviderNumber(nodeData.inputs?.topP, 'Top Probability', { min: 0, max: 1 })
        const frequencyPenalty = parseOptionalProviderNumber(nodeData.inputs?.frequencyPenalty, 'Frequency Penalty')
        const presencePenalty = parseOptionalProviderNumber(nodeData.inputs?.presencePenalty, 'Presence Penalty')
        const timeout = parseOptionalProviderNumber(nodeData.inputs?.timeout, 'Timeout', { integer: true, min: 1 })
        const stopSequence = nodeData.inputs?.stopSequence as string
        const streaming = nodeData.inputs?.streaming as boolean
        const thinking = nodeData.inputs?.thinking
        const reasoningEffort = nodeData.inputs?.reasoningEffort

        if (thinking === true || thinking === 'true' || reasoningEffort || modelName === 'deepseek-reasoner') {
            throw new Error('Deepseek reasoning and thinking are not supported by this node transport')
        }
        const basePath = resolveProviderBaseUrl(nodeData.inputs?.basepath, DEEPSEEK_ENDPOINT_POLICY)
        const baseOptions = parseProviderHeaders(nodeData.inputs?.baseOptions, 'Deepseek')

        if (nodeData.inputs?.credentialId) {
            nodeData.credential = nodeData.inputs?.credentialId
        }
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const apiKey = requireProviderApiKey(getCredentialParam('deepseekApiKey', credentialData, nodeData), 'Deepseek')

        const cache = nodeData.inputs?.cache as BaseCache

        const obj: ChatDeepSeekInput = {
            modelName,
            apiKey,
            streaming: streaming ?? true,
            maxRetries: 0
        }

        if (temperature !== undefined) obj.temperature = temperature
        if (maxTokens !== undefined) obj.maxTokens = maxTokens
        if (topP !== undefined) obj.topP = topP
        if (frequencyPenalty !== undefined) obj.frequencyPenalty = frequencyPenalty
        if (presencePenalty !== undefined) obj.presencePenalty = presencePenalty
        if (timeout !== undefined) obj.timeout = timeout
        if (cache) obj.cache = cache
        if (stopSequence) {
            const stopSequenceArray = stopSequence
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean)
            if (stopSequenceArray.length) obj.stop = stopSequenceArray
        }
        if (modelName.startsWith('deepseek-v4')) obj.modelKwargs = { thinking: { type: 'disabled' } }

        obj.configuration = buildSecureProviderConfiguration(basePath, baseOptions)

        const model = new ChatDeepSeek(obj)
        return model
    }
}

module.exports = { nodeClass: Deepseek_ChatModels }
