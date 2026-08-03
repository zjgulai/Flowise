import { DataSource } from 'typeorm'
import { FLOWISE_REQUEST_ERROR, requestFlowisePrediction } from '../../../src/internalFlowRequest'
import { getCredentialData, getCredentialParam } from '../../../src/utils'
import { isValidUUID } from '../../../src/validator'
import {
    ICommonObject,
    IDatabaseEntity,
    INode,
    INodeData,
    INodeOptionsValue,
    INodeParams,
    ISeqAgentNode,
    ISeqAgentsState
} from '../../../src/Interface'
import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages'
import { v4 as uuidv4 } from 'uuid'

class ExecuteFlow_SeqAgents implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    credential: INodeParams

    constructor() {
        this.label = 'Execute Flow'
        this.name = 'seqExecuteFlow'
        this.version = 1.0
        this.type = 'ExecuteFlow'
        this.icon = 'executeflow.svg'
        this.category = 'Sequential Agents'
        this.description = `Execute chatflow/agentflow and return final response`
        this.baseClasses = [this.type]
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['chatflowApi'],
            optional: true
        }
        this.inputs = [
            {
                label: 'Sequential Node',
                name: 'sequentialNode',
                type: 'Start | Agent | Condition | LLMNode | ToolNode | CustomFunction | ExecuteFlow',
                description:
                    'Can be connected to one of the following nodes: Start, Agent, Condition, LLM Node, Tool Node, Custom Function, Execute Flow',
                list: true
            },
            {
                label: 'Name',
                name: 'seqExecuteFlowName',
                type: 'string'
            },
            {
                label: 'Select Flow',
                name: 'selectedFlow',
                type: 'asyncOptions',
                loadMethod: 'listFlows'
            },
            {
                label: 'Input',
                name: 'seqExecuteFlowInput',
                type: 'options',
                description: 'Select one of the following or enter custom input',
                freeSolo: true,
                loadPreviousNodes: true,
                options: [
                    {
                        label: '{{ question }}',
                        name: 'userQuestion',
                        description: 'Use the user question from the chat as input.'
                    }
                ]
            },
            {
                label: 'Override Config',
                name: 'overrideConfig',
                description: 'Override the config passed to the flow.',
                type: 'json',
                workspaceExportPolicy: 'rebind',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Base URL',
                name: 'baseURL',
                type: 'string',
                description:
                    'Base URL to Flowise. By default, the server canonical APP_URL is used. Explicit external targets never receive a Flow API credential.',
                placeholder: 'https://flowise.example.com',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Start new session per message',
                name: 'startNewSession',
                type: 'boolean',
                description:
                    'Whether to continue the session or start a new one with each interaction. Useful for flows with memory if you want to avoid it.',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Return Value As',
                name: 'returnValueAs',
                type: 'options',
                options: [
                    { label: 'AI Message', name: 'aiMessage' },
                    { label: 'Human Message', name: 'humanMessage' },
                    {
                        label: 'State Object',
                        name: 'stateObj',
                        description: "Return as state object, ex: { foo: bar }. This will update the custom state 'foo' to 'bar'"
                    }
                ],
                default: 'aiMessage'
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
                const data = {
                    label: chatflows[i].name,
                    name: chatflows[i].id
                } as INodeOptionsValue
                returnData.push(data)
            }
            return returnData
        }
    }

    async init(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const selectedFlowId = nodeData.inputs?.selectedFlow as string
        const _seqExecuteFlowName = nodeData.inputs?.seqExecuteFlowName as string
        if (!_seqExecuteFlowName) throw new Error('Execute Flow node name is required!')
        const seqExecuteFlowName = _seqExecuteFlowName.toLowerCase().replace(/\s/g, '_').trim()
        const startNewSession = nodeData.inputs?.startNewSession as boolean
        const sequentialNodes = nodeData.inputs?.sequentialNode as ISeqAgentNode[]
        const seqExecuteFlowInput = nodeData.inputs?.seqExecuteFlowInput as string
        const overrideConfig =
            typeof nodeData.inputs?.overrideConfig === 'string' &&
            nodeData.inputs.overrideConfig.startsWith('{') &&
            nodeData.inputs.overrideConfig.endsWith('}')
                ? JSON.parse(nodeData.inputs.overrideConfig)
                : nodeData.inputs?.overrideConfig

        if (!sequentialNodes || !sequentialNodes.length) throw new Error('Execute Flow must have a predecessor!')

        const configuredBaseUrl = nodeData.inputs?.baseURL
        const returnValueAs = nodeData.inputs?.returnValueAs as string

        // Validate selectedFlowId is a valid UUID
        if (!selectedFlowId || !isValidUUID(selectedFlowId)) {
            throw new Error('Invalid flow ID: must be a valid UUID')
        }

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const chatflowApiKey = getCredentialParam('chatflowApiKey', credentialData, nodeData)

        if (selectedFlowId === options.chatflowid) throw new Error('Cannot call the same agentflow!')

        const sessionId = options.sessionId
        const chatId = options.chatId

        const executeFunc = async (state: ISeqAgentsState) => {
            let flowInput = ''
            if (seqExecuteFlowInput === 'userQuestion') {
                flowInput = input
            } else if (seqExecuteFlowInput && seqExecuteFlowInput.startsWith('{{') && seqExecuteFlowInput.endsWith('}}')) {
                const nodeId = seqExecuteFlowInput.replace('{{', '').replace('}}', '').replace(/\$/g, '').trim()
                const messageOutputs = ((state.messages as unknown as BaseMessage[]) ?? []).filter(
                    (message) => message.additional_kwargs && message.additional_kwargs?.nodeId === nodeId
                )
                const messageOutput = messageOutputs[messageOutputs.length - 1]

                if (messageOutput) {
                    flowInput = JSON.stringify(messageOutput.content)
                }
            }

            const body = {
                question: flowInput,
                chatId: startNewSession ? uuidv4() : chatId,
                overrideConfig: {
                    sessionId: startNewSession ? uuidv4() : sessionId,
                    ...(overrideConfig ?? {})
                }
            }

            try {
                const responseData = await requestFlowisePrediction({
                    configuredBaseUrl,
                    flowId: selectedFlowId,
                    apiKey: chatflowApiKey,
                    body
                })
                let response = responseData?.text ?? ''

                if (typeof response === 'object') {
                    response = JSON.stringify(response)
                }

                if (returnValueAs === 'humanMessage') {
                    return {
                        messages: [
                            new HumanMessage({
                                content: response,
                                additional_kwargs: {
                                    nodeId: nodeData.id
                                }
                            })
                        ]
                    }
                }

                return {
                    messages: [
                        new AIMessage({
                            content: response,
                            additional_kwargs: {
                                nodeId: nodeData.id
                            }
                        })
                    ]
                }
            } catch {
                throw new Error(FLOWISE_REQUEST_ERROR)
            }
        }

        const startLLM = sequentialNodes[0].startLLM

        const returnOutput: ISeqAgentNode = {
            id: nodeData.id,
            node: executeFunc,
            name: seqExecuteFlowName,
            label: _seqExecuteFlowName,
            type: 'utilities',
            output: 'ExecuteFlow',
            llm: startLLM,
            startLLM,
            multiModalMessageContent: sequentialNodes[0]?.multiModalMessageContent,
            predecessorAgents: sequentialNodes
        }

        return returnOutput
    }
}

module.exports = { nodeClass: ExecuteFlow_SeqAgents }
