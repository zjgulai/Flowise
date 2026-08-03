import {
    ICommonObject,
    IDatabaseEntity,
    INode,
    INodeData,
    INodeOptionsValue,
    INodeParams,
    IServerSideEventStreamer
} from '../../../src/Interface'
import { FLOWISE_REQUEST_ERROR, requestFlowisePrediction } from '../../../src/internalFlowRequest'
import { getCredentialData, getCredentialParam, processTemplateVariables, parseJsonBody } from '../../../src/utils'
import { isValidUUID } from '../../../src/validator'
import { DataSource } from 'typeorm'
import { BaseMessageLike } from '@langchain/core/messages'
import { updateFlowState } from '../utils'
import { flatten } from 'lodash'

class ExecuteFlow_Agentflow implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    color: string
    baseClasses: string[]
    documentation?: string
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Execute Flow'
        this.name = 'executeFlowAgentflow'
        this.version = 1.2
        this.type = 'ExecuteFlow'
        this.category = 'Agent Flows'
        this.description = 'Execute another flow'
        this.baseClasses = [this.type]
        this.color = '#a3b18a'
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['chatflowApi'],
            optional: true
        }
        this.inputs = [
            {
                label: 'Select Flow',
                name: 'executeFlowSelectedFlow',
                type: 'asyncOptions',
                loadMethod: 'listFlows'
            },
            {
                label: 'Input',
                name: 'executeFlowInput',
                type: 'string',
                rows: 4,
                acceptVariable: true
            },
            {
                label: 'Override Config',
                name: 'executeFlowOverrideConfig',
                description: 'Override the config passed to the flow',
                type: 'json',
                workspaceExportPolicy: 'rebind',
                optional: true,
                acceptVariable: true
            },
            {
                label: 'Base URL',
                name: 'executeFlowBaseURL',
                type: 'string',
                description:
                    'Base URL to Flowise. By default, the server canonical APP_URL is used. Explicit external targets never receive a Flow API credential.',
                placeholder: 'https://flowise.example.com',
                optional: true
            },
            {
                label: 'Return Response As',
                name: 'executeFlowReturnResponseAs',
                type: 'options',
                options: [
                    {
                        label: 'User Message',
                        name: 'userMessage'
                    },
                    {
                        label: 'Assistant Message',
                        name: 'assistantMessage'
                    }
                ],
                default: 'userMessage'
            },
            {
                label: 'Update Flow State',
                name: 'executeFlowUpdateState',
                description: 'Update runtime state during the execution of the workflow',
                type: 'array',
                optional: true,
                acceptVariable: true,
                array: [
                    {
                        label: 'Key',
                        name: 'key',
                        type: 'asyncOptions',
                        loadMethod: 'listRuntimeStateKeys'
                    },
                    {
                        label: 'Value',
                        name: 'value',
                        type: 'string',
                        acceptVariable: true,
                        acceptNodeOutputAsVariable: true
                    }
                ]
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listFlows(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity
            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const chatflows = await appDataSource.getRepository(databaseEntities['ChatFlow']).findBy(searchOptions)

            for (let i = 0; i < chatflows.length; i += 1) {
                let cfType = 'Chatflow'
                if (chatflows[i].type === 'AGENTFLOW') {
                    cfType = 'Agentflow V2'
                } else if (chatflows[i].type === 'MULTIAGENT') {
                    cfType = 'Agentflow V1'
                }
                const data = {
                    label: chatflows[i].name,
                    name: chatflows[i].id,
                    description: cfType
                } as INodeOptionsValue
                returnData.push(data)
            }

            // order by label
            return returnData.sort((a, b) => a.label.localeCompare(b.label))
        },
        async listRuntimeStateKeys(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const previousNodes = options.previousNodes as ICommonObject[]
            const startAgentflowNode = previousNodes.find((node) => node.name === 'startAgentflow')
            const state = startAgentflowNode?.inputs?.startState as ICommonObject[]
            return state.map((item) => ({ label: item.key, name: item.key }))
        }
    }

    async run(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const configuredBaseUrl = nodeData.inputs?.executeFlowBaseURL
        const selectedFlowId = nodeData.inputs?.executeFlowSelectedFlow as string
        const flowInput = nodeData.inputs?.executeFlowInput as string
        const returnResponseAs = nodeData.inputs?.executeFlowReturnResponseAs as string
        const _executeFlowUpdateState = nodeData.inputs?.executeFlowUpdateState

        let overrideConfig = nodeData.inputs?.executeFlowOverrideConfig
        if (typeof overrideConfig === 'string' && overrideConfig.startsWith('{') && overrideConfig.endsWith('}')) {
            try {
                overrideConfig = parseJsonBody(overrideConfig)
            } catch (parseError) {
                throw new Error(`Invalid JSON in executeFlowOverrideConfig: ${parseError.message}`)
            }
        }

        const state = options.agentflowRuntime?.state as ICommonObject
        const runtimeChatHistory = (options.agentflowRuntime?.chatHistory as BaseMessageLike[]) ?? []
        const isLastNode = options.isLastNode as boolean
        const sseStreamer: IServerSideEventStreamer | undefined = options.sseStreamer

        try {
            const credentialData = await getCredentialData(nodeData.credential ?? '', options)
            const chatflowApiKey = getCredentialParam('chatflowApiKey', credentialData, nodeData)

            if (!selectedFlowId || !isValidUUID(selectedFlowId)) throw new Error(FLOWISE_REQUEST_ERROR)

            if (selectedFlowId === options.chatflowid) throw new Error('Cannot call the same agentflow!')

            const response = await requestFlowisePrediction({
                configuredBaseUrl,
                flowId: selectedFlowId,
                apiKey: chatflowApiKey,
                flowiseTool: true,
                body: {
                    question: flowInput,
                    chatId: options.chatId,
                    overrideConfig
                }
            })

            let resultText = ''
            const { sourceDocuments, usedTools, artifacts, fileAnnotations } = response
            const flattenedSourceDocuments = Array.isArray(sourceDocuments) ? flatten(sourceDocuments) : []
            const flattenedUsedTools = Array.isArray(usedTools) ? flatten(usedTools) : []
            const flattenedArtifacts = Array.isArray(artifacts) ? flatten(artifacts) : []
            if (response.text) resultText = response.text
            else if (response.json) resultText = '```json\n' + JSON.stringify(response.json, null, 2)
            else resultText = JSON.stringify(response, null, 2)

            if (isLastNode && sseStreamer) {
                sseStreamer.streamTokenEvent(options.chatId, resultText)
                if (flattenedSourceDocuments.length > 0) {
                    sseStreamer.streamSourceDocumentsEvent(options.chatId, flattenedSourceDocuments)
                }
                if (flattenedUsedTools.length > 0) {
                    sseStreamer.streamUsedToolsEvent(options.chatId, flattenedUsedTools)
                }
                if (flattenedArtifacts.length > 0) {
                    sseStreamer.streamArtifactsEvent(options.chatId, flattenedArtifacts)
                }
                if (fileAnnotations) {
                    sseStreamer.streamFileAnnotationsEvent(options.chatId, fileAnnotations)
                }
            }

            // Update flow state if needed
            let newState = { ...state }
            if (_executeFlowUpdateState && Array.isArray(_executeFlowUpdateState) && _executeFlowUpdateState.length > 0) {
                newState = updateFlowState(state, _executeFlowUpdateState)
            }

            // Process template variables in state
            newState = processTemplateVariables(newState, resultText)

            // Only add to runtime chat history if this is the first node
            const inputMessages = []
            if (!runtimeChatHistory.length) {
                inputMessages.push({ role: 'user', content: flowInput })
            }

            let returnRole = 'user'
            if (returnResponseAs === 'assistantMessage') {
                returnRole = 'assistant'
            }

            const returnOutput = {
                id: nodeData.id,
                name: this.name,
                input: {
                    messages: [
                        {
                            role: 'user',
                            content: flowInput
                        }
                    ]
                },
                output: {
                    content: resultText,
                    ...(flattenedSourceDocuments.length > 0 && { sourceDocuments: flattenedSourceDocuments }),
                    ...(flattenedUsedTools.length > 0 && { usedTools: flattenedUsedTools }),
                    ...(flattenedArtifacts.length > 0 && { artifacts: flattenedArtifacts }),
                    ...(fileAnnotations && fileAnnotations.length > 0 && { fileAnnotations })
                },
                state: newState,
                chatHistory: [
                    ...inputMessages,
                    {
                        role: returnRole,
                        content: resultText,
                        name: nodeData?.label ? nodeData?.label.toLowerCase().replace(/\s/g, '_').trim() : nodeData?.id,
                        ...((flattenedArtifacts.length > 0 ||
                            (fileAnnotations && fileAnnotations.length > 0) ||
                            flattenedUsedTools.length > 0) && {
                            additional_kwargs: {
                                ...(flattenedArtifacts.length > 0 && { artifacts: flattenedArtifacts }),
                                ...(fileAnnotations && fileAnnotations.length > 0 && { fileAnnotations }),
                                ...(flattenedUsedTools.length > 0 && { usedTools: flattenedUsedTools })
                            }
                        })
                    }
                ]
            }

            return returnOutput
        } catch {
            throw new Error(FLOWISE_REQUEST_ERROR)
        }
    }
}

module.exports = { nodeClass: ExecuteFlow_Agentflow }
