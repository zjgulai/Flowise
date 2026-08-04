import { DataSource } from 'typeorm'
import { z } from 'zod/v3'
import { RunnableConfig } from '@langchain/core/runnables'
import { CallbackManagerForToolRun, Callbacks, CallbackManager, parseCallbackConfigArg } from '@langchain/core/callbacks/manager'
import { StructuredTool } from '@langchain/core/tools'
import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { requestFlowisePrediction } from '../../../src/internalFlowRequest'
import { getCredentialData, getCredentialParam, parseWithTypeConversion } from '../../../src/utils'
import { isValidUUID } from '../../../src/validator'
import { v4 as uuidv4 } from 'uuid'

class ChatflowTool_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'Chatflow Tool'
        this.name = 'ChatflowTool'
        this.version = 5.1
        this.type = 'ChatflowTool'
        this.icon = 'chatflowTool.svg'
        this.category = 'Tools'
        this.description = 'Use as a tool to execute another chatflow'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['chatflowApi'],
            optional: true
        }
        this.inputs = [
            {
                label: 'Select Chatflow',
                name: 'selectedChatflow',
                type: 'asyncOptions',
                loadMethod: 'listChatflows'
            },
            {
                label: 'Tool Name',
                name: 'name',
                type: 'string'
            },
            {
                label: 'Tool Description',
                name: 'description',
                type: 'string',
                description: 'Description of what the tool does. This is for LLM to determine when to use this tool.',
                rows: 3,
                placeholder:
                    'State of the Union QA - useful for when you need to ask questions about the most recent state of the union address.'
            },
            {
                label: 'Return Direct',
                name: 'returnDirect',
                type: 'boolean',
                optional: true
            },
            {
                label: 'Override Config',
                name: 'overrideConfig',
                description: 'Override the config passed to the Chatflow.',
                type: 'json',
                workspaceExportPolicy: 'rebind',
                optional: true,
                additionalParams: true,
                acceptVariable: true
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
                    'Whether to continue the session with the Chatflow tool or start a new one with each interaction. Useful for Chatflows with memory if you want to avoid it.',
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Use Question from Chat',
                name: 'useQuestionFromChat',
                type: 'boolean',
                description:
                    'Whether to use the question from the chat as input to the chatflow. If turned on, this will override the custom input.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Custom Input',
                name: 'customInput',
                type: 'string',
                description: 'Custom input to be passed to the chatflow. Leave empty to let LLM decides the input.',
                optional: true,
                additionalParams: true,
                show: {
                    useQuestionFromChat: false
                }
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listChatflows(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity
            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const chatflows = await appDataSource.getRepository(databaseEntities['ChatFlow']).findBy(searchOptions)

            for (let i = 0; i < chatflows.length; i += 1) {
                let type = chatflows[i].type
                if (type === 'AGENTFLOW') {
                    type = 'AgentflowV2'
                } else if (type === 'MULTIAGENT') {
                    type = 'AgentflowV1'
                } else if (type === 'ASSISTANT') {
                    type = 'Custom Assistant'
                } else {
                    type = 'Chatflow'
                }
                const data = {
                    label: chatflows[i].name,
                    name: chatflows[i].id,
                    description: type
                } as INodeOptionsValue
                returnData.push(data)
            }
            return returnData
        }
    }

    async init(nodeData: INodeData, input: string, options: ICommonObject): Promise<any> {
        const selectedChatflowId = nodeData.inputs?.selectedChatflow as string
        const _name = nodeData.inputs?.name as string
        const description = nodeData.inputs?.description as string
        const useQuestionFromChat = nodeData.inputs?.useQuestionFromChat as boolean
        const returnDirect = nodeData.inputs?.returnDirect as boolean
        const customInput = nodeData.inputs?.customInput as string
        const overrideConfig =
            typeof nodeData.inputs?.overrideConfig === 'string' &&
            nodeData.inputs.overrideConfig.startsWith('{') &&
            nodeData.inputs.overrideConfig.endsWith('}')
                ? JSON.parse(nodeData.inputs.overrideConfig)
                : nodeData.inputs?.overrideConfig

        const startNewSession = nodeData.inputs?.startNewSession as boolean

        const configuredBaseUrl = nodeData.inputs?.baseURL

        // Validate selectedChatflowId is a valid UUID
        if (!selectedChatflowId || !isValidUUID(selectedChatflowId)) {
            throw new Error('Invalid chatflow ID: must be a valid UUID')
        }

        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const chatflowApiKey = getCredentialParam('chatflowApiKey', credentialData, nodeData)

        if (selectedChatflowId === options.chatflowid) throw new Error('Cannot call the same chatflow!')

        let toolInput = ''
        if (useQuestionFromChat) {
            toolInput = input
        } else if (customInput) {
            toolInput = customInput
        }

        let name = _name || 'chatflow_tool'

        return new ChatflowTool({
            name,
            baseURL: configuredBaseUrl,
            description,
            returnDirect,
            chatflowid: selectedChatflowId,
            startNewSession,
            apiKey: chatflowApiKey,
            input: toolInput,
            overrideConfig
        })
    }
}

class ChatflowTool extends StructuredTool {
    static lc_name() {
        return 'ChatflowTool'
    }

    name = 'chatflow_tool'

    description = 'Execute another chatflow'

    input = ''

    chatflowid = ''

    startNewSession = false

    baseURL?: unknown

    apiKey?: unknown

    overrideConfig?: object

    schema = z.object({
        input: z.string().describe('input question')
        // overrideConfig: z.record(z.any()).optional().describe('override config'), // This will be passed to the Agent, so comment it for now.
    }) as any

    constructor({
        name,
        description,
        returnDirect,
        input,
        chatflowid,
        startNewSession,
        baseURL,
        apiKey,
        overrideConfig
    }: {
        name: string
        description: string
        returnDirect: boolean
        input: string
        chatflowid: string
        startNewSession: boolean
        baseURL?: unknown
        apiKey?: unknown
        overrideConfig?: object
    }) {
        super()
        this.name = name
        this.description = description
        this.input = input
        this.baseURL = baseURL
        this.startNewSession = startNewSession
        this.apiKey = apiKey
        this.chatflowid = chatflowid
        this.overrideConfig = overrideConfig
        this.returnDirect = returnDirect
    }

    async call(
        arg: z.infer<typeof this.schema>,
        configArg?: RunnableConfig | Callbacks,
        tags?: string[],
        flowConfig?: { sessionId?: string; chatId?: string; input?: string }
    ): Promise<string> {
        const config = parseCallbackConfigArg(configArg)
        if (config.runName === undefined) {
            config.runName = this.name
        }
        let parsed
        try {
            parsed = await parseWithTypeConversion(this.schema, arg)
        } catch (e) {
            throw new Error(`Received tool input did not match expected schema: ${JSON.stringify(arg)}`)
        }
        const callbackManager_ = await CallbackManager.configure(
            config.callbacks,
            this.callbacks,
            config.tags || tags,
            this.tags,
            config.metadata,
            this.metadata,
            { verbose: this.verbose }
        )
        const runManager = await callbackManager_?.handleToolStart(
            this.toJSON(),
            typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
            undefined,
            undefined,
            undefined,
            undefined,
            config.runName
        )
        let result
        try {
            result = await this._call(parsed, runManager, flowConfig)
        } catch (e) {
            await runManager?.handleToolError(e)
            throw e
        }
        if (result && typeof result !== 'string') {
            result = JSON.stringify(result)
        }
        await runManager?.handleToolEnd(result)
        return result
    }

    // @ts-ignore
    protected async _call(
        arg: z.infer<typeof this.schema>,
        _?: CallbackManagerForToolRun,
        flowConfig?: { sessionId?: string; chatId?: string; input?: string }
    ): Promise<string> {
        const inputQuestion = this.input || arg.input

        const body = {
            question: inputQuestion,
            chatId: this.startNewSession ? uuidv4() : flowConfig?.chatId,
            overrideConfig: {
                sessionId: this.startNewSession ? uuidv4() : flowConfig?.sessionId,
                ...(this.overrideConfig ?? {}),
                ...(arg.overrideConfig ?? {})
            }
        }

        const responseData = await requestFlowisePrediction({
            configuredBaseUrl: this.baseURL,
            flowId: this.chatflowid,
            apiKey: this.apiKey,
            flowiseTool: true,
            body
        })
        let response = responseData?.text ?? ''

        if (typeof response === 'object') {
            response = JSON.stringify(response)
        }

        return response
    }
}

module.exports = { nodeClass: ChatflowTool_Tools }
