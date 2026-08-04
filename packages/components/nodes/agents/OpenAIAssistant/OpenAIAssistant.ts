import {
    ICommonObject,
    IDatabaseEntity,
    INode,
    INodeData,
    INodeOptionsValue,
    INodeParams,
    IServerSideEventStreamer,
    IUsedTool
} from '../../../src/Interface'
import OpenAI from 'openai'
import { DataSource } from 'typeorm'
import { getCredentialData, getCredentialParam } from '../../../src/utils'
import fetch from 'node-fetch'
import { flatten } from 'lodash'
import { toolSchemaToJsonSchema } from '../../../src/utils'
import { AnalyticHandler } from '../../../src/handler'
import { Moderation, checkInputs, streamResponse } from '../../moderation/Moderation'
import { formatResponse } from '../../outputparsers/OutputParserHelpers'
import { addSingleFileToStorage } from '../../../src/storageUtils'
import { DynamicStructuredTool } from '../../tools/OpenAPIToolkit/core'
import {
    OPENAI_ASSISTANT_POLL_FAILED_ERROR,
    OPENAI_ASSISTANT_DOWNLOAD_ERROR,
    OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES,
    OPENAI_ASSISTANT_SESSION_ERROR,
    OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR,
    DownloadBudget,
    ToolExecutionBudget,
    buildPerRunTools,
    createDownloadBudget,
    createIrreversibleCommitTracker,
    createToolExecutionBudget,
    downloadAndStoreBounded,
    IrreversibleCommitTracker,
    prepareToolActions,
    requireChatflowId,
    requireSelectedAssistantId,
    requireWorkspaceId,
    serialPoll,
    toAssistantOption,
    withAbortTimeout
} from './runtimeGuards'

const lenticularBracketRegex = /【[^】]*】/g
const imageRegex = /<img[^>]*\/>/g
const INPUT_MODERATION_FAILED_ERROR = 'Input moderation failed'

function getSafeModerationMessage(error: unknown, moderations: Moderation[]): string {
    const errorMessage = error instanceof Error ? error.message : ''
    const configuredMessages = moderations
        .map((moderation) => (moderation as any)?.moderationErrorMessage)
        .filter((message): message is string => typeof message === 'string' && message.length > 0 && message.length <= 500)
    return configuredMessages.includes(errorMessage) ? errorMessage : INPUT_MODERATION_FAILED_ERROR
}

class OpenAIAssistant_Agents implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    badge: string
    deprecateMessage: string

    constructor() {
        this.label = 'OpenAI Assistant'
        this.name = 'openAIAssistant'
        this.version = 4.0
        this.type = 'OpenAIAssistant'
        this.category = 'Agents'
        this.icon = 'assistant.svg'
        this.description = `An agent that uses OpenAI Assistant API to pick the tool and args to call`
        this.badge = 'DEPRECATING'
        this.deprecateMessage =
            'OpenAI Assistants API will shut down on August 26, 2026. Migrate to Custom Assistant or OpenAI Responses API; see the OpenAI Assistants migration guide.'
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Select Assistant',
                name: 'selectedAssistant',
                type: 'asyncOptions',
                loadMethod: 'listAssistants'
            },
            {
                label: 'Allowed Tools',
                name: 'tools',
                type: 'Tool',
                list: true
            },
            {
                label: 'Input Moderation',
                description: 'Detect text that could generate harmful output and prevent it from being sent to the language model',
                name: 'inputModeration',
                type: 'Moderation',
                optional: true,
                list: true
            },
            {
                label: 'Tool Choice',
                name: 'toolChoice',
                type: 'string',
                description:
                    'Controls which (if any) tool is called by the model. Can be "none", "auto", "required", or the name of a tool. Refer <a href="https://platform.openai.com/docs/api-reference/runs/createRun#runs-createrun-tool_choice" target="_blank">here</a> for more information',
                placeholder: 'file_search',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Parallel Tool Calls',
                name: 'parallelToolCalls',
                type: 'boolean',
                description: 'Whether to enable parallel function calling during tool use. Defaults to true',
                default: true,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Disable File Download',
                name: 'disableFileDownload',
                type: 'boolean',
                description:
                    'Messages can contain text, images, or files. In some cases, you may want to prevent others from downloading the files. Learn more from OpenAI File Annotation <a target="_blank" href="https://platform.openai.com/docs/assistants/how-it-works/managing-threads-and-messages">docs</a>',
                optional: true,
                additionalParams: true
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listAssistants(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const workspaceId = requireWorkspaceId(options)
            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity
            if (!appDataSource || !databaseEntities?.['Assistant']) return []

            const assistants = await appDataSource.getRepository(databaseEntities['Assistant']).findBy({
                workspaceId,
                type: 'OPENAI'
            })
            return assistants.map(toAssistantOption).filter((assistant): assistant is INodeOptionsValue => Boolean(assistant))
        }
    }

    async init(): Promise<any> {
        return null
    }

    async clearChatMessages(nodeData: INodeData, options: ICommonObject, sessionIdObj: { type: string; id: string }): Promise<void> {
        const selectedAssistantId = requireSelectedAssistantId(nodeData.inputs?.selectedAssistant)
        const appDataSource = options.appDataSource as DataSource
        const databaseEntities = options.databaseEntities as IDatabaseEntity
        const workspaceId = requireWorkspaceId(options)
        const chatflowId = requireChatflowId(options)

        if (
            !sessionIdObj ||
            !['chatId', 'threadId'].includes(sessionIdObj.type) ||
            typeof sessionIdObj.id !== 'string' ||
            !sessionIdObj.id
        ) {
            throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
        }
        const scopedChatId = typeof options.chatId === 'string' ? options.chatId.trim() : ''
        if (sessionIdObj.type === 'threadId' && !scopedChatId) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)

        const assistant = await appDataSource.getRepository(databaseEntities['Assistant']).findOneBy({
            id: selectedAssistantId,
            workspaceId,
            type: 'OPENAI'
        })

        if (!assistant) throw new Error('OpenAI Assistant not found')

        let sessionId = ''
        if (sessionIdObj.type === 'chatId') {
            const chatmsg = await appDataSource.getRepository(databaseEntities['ChatMessage']).findOneBy({
                chatId: sessionIdObj.id,
                chatflowid: chatflowId
            })
            if (!chatmsg?.sessionId) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
            sessionId = chatmsg.sessionId
        } else {
            const chatmsg = await appDataSource.getRepository(databaseEntities['ChatMessage']).findOneBy({
                sessionId: sessionIdObj.id,
                chatflowid: chatflowId,
                chatId: scopedChatId
            })
            if (!chatmsg?.sessionId) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
            sessionId = chatmsg.sessionId
        }
        if (!sessionId.startsWith('thread_')) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)

        const credentialData = await getCredentialData(assistant.credential ?? '', options)
        const openAIApiKey = getCredentialParam('openAIApiKey', credentialData, nodeData)
        if (!openAIApiKey) throw new Error('OpenAI API key not found')

        const openai = new OpenAI({ apiKey: openAIApiKey })
        try {
            const result = await openai.beta.threads.delete(sessionId)
            if (result?.id !== sessionId || result?.deleted !== true) throw new Error('OpenAI Assistant thread cleanup failed')
        } catch {
            options.logger?.error('OpenAI Assistant thread cleanup failed')
            throw new Error('OpenAI Assistant thread cleanup failed')
        }
    }

    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<string | object> {
        const selectedAssistantId = requireSelectedAssistantId(nodeData.inputs?.selectedAssistant)
        const appDataSource = options.appDataSource as DataSource
        const databaseEntities = options.databaseEntities as IDatabaseEntity
        const disableFileDownload = nodeData.inputs?.disableFileDownload as boolean
        const moderations = nodeData.inputs?.inputModeration as Moderation[]
        const _toolChoice = nodeData.inputs?.toolChoice as string
        const parallelToolCalls = nodeData.inputs?.parallelToolCalls as boolean
        const workspaceId = requireWorkspaceId(options)
        const chatflowId = requireChatflowId(options)
        const chatId = typeof options.chatId === 'string' ? options.chatId.trim() : ''
        if (!chatId) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)

        const assistant = await appDataSource.getRepository(databaseEntities['Assistant']).findOneBy({
            id: selectedAssistantId,
            workspaceId,
            type: 'OPENAI'
        })
        if (!assistant) throw new Error('OpenAI Assistant not found')

        let assistantDetails: ICommonObject
        try {
            assistantDetails = JSON.parse(assistant.details)
        } catch {
            throw new Error('OpenAI Assistant configuration is invalid')
        }
        const openAIAssistantId = typeof assistantDetails?.id === 'string' ? assistantDetails.id : ''
        if (!openAIAssistantId) throw new Error('OpenAI Assistant configuration is invalid')

        const shouldStreamResponse = options.shouldStreamResponse
        const sseStreamer: IServerSideEventStreamer = options.sseStreamer as IServerSideEventStreamer
        const checkStorage = options.checkStorage
            ? (options.checkStorage as (orgId: string, subscriptionId: string, usageCacheManager: any) => Promise<void>)
            : undefined
        const updateStorageUsage = options.updateStorageUsage
            ? (options.updateStorageUsage as (
                  orgId: string,
                  workspaceId: string,
                  totalSize: number,
                  usageCacheManager: any
              ) => Promise<void>)
            : undefined

        if (moderations && moderations.length > 0) {
            try {
                input = await checkInputs(moderations, input)
            } catch (error) {
                const safeMessage = getSafeModerationMessage(error, moderations)
                if (safeMessage === INPUT_MODERATION_FAILED_ERROR) {
                    options.logger?.error('OpenAI Assistant input moderation failed')
                }
                await new Promise((resolve) => setTimeout(resolve, 500))
                if (shouldStreamResponse) {
                    streamResponse(sseStreamer, chatId, safeMessage)
                }
                return formatResponse(safeMessage)
            }
        }

        let tools = nodeData.inputs?.tools
        tools = flatten(tools)
        const formattedTools = tools?.map((tool: any) => formatToOpenAIAssistantTool(tool)) ?? []
        if (
            _toolChoice &&
            !['file_search', 'code_interpreter', 'none', 'auto', 'required'].includes(_toolChoice) &&
            !formattedTools.some((tool: OpenAI.Beta.FunctionTool) => tool.function.name === _toolChoice)
        ) {
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }

        const usedTools: IUsedTool[] = []
        const fileAnnotations: Array<{ filePath: string; fileName: string }> = []
        const artifacts: Array<{ type: string; data: string }> = []

        const credentialData = await getCredentialData(assistant.credential ?? '', options)
        const openAIApiKey = getCredentialParam('openAIApiKey', credentialData, nodeData)
        if (!openAIApiKey) throw new Error('OpenAI API key not found')

        const openai = new OpenAI({ apiKey: openAIApiKey })

        // Start analytics
        const analyticHandlers = AnalyticHandler.getInstance(nodeData, options)
        await analyticHandlers.init()
        const parentIds = await analyticHandlers.onChainStart('OpenAIAssistant', input)

        try {
            // Retrieve assistant
            const retrievedAssistant = await openai.beta.assistants.retrieve(openAIAssistantId)
            if (retrievedAssistant.id !== openAIAssistantId) throw new Error('OpenAI Assistant configuration is invalid')
            const runTools = buildPerRunTools(retrievedAssistant.tools, formattedTools)
            if (['file_search', 'code_interpreter'].includes(_toolChoice) && !runTools.some((tool) => tool.type === _toolChoice)) {
                throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
            }
            const chatmessage = await appDataSource.getRepository(databaseEntities['ChatMessage']).findOneBy({
                chatId,
                chatflowid: chatflowId
            })

            let threadId = ''
            let isNewThread = false
            if (!chatmessage) {
                const thread = await openai.beta.threads.create({})
                if (typeof thread.id !== 'string' || !thread.id.startsWith('thread_')) {
                    throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
                }
                threadId = thread.id
                isNewThread = true
            } else {
                const storedSessionId = typeof chatmessage.sessionId === 'string' ? chatmessage.sessionId : ''
                if (!storedSessionId.startsWith('thread_')) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
                const thread = await openai.beta.threads.retrieve(storedSessionId)
                if (thread.id !== storedSessionId) throw new Error(OPENAI_ASSISTANT_SESSION_ERROR)
                threadId = thread.id
            }

            // List all runs, in case existing thread is still running
            if (!isNewThread) {
                await serialPoll({
                    operation: (signal) => openai.beta.threads.runs.list(threadId, undefined, { signal }),
                    evaluate: (allRuns) => {
                        const latestRun = allRuns.data?.[0]
                        if (!latestRun) return { done: true, value: undefined }
                        if (['cancelled', 'completed', 'expired', 'failed', 'incomplete'].includes(latestRun.status)) {
                            return { done: true, value: undefined }
                        }
                        if (latestRun.status === 'requires_action') throw new Error(OPENAI_ASSISTANT_POLL_FAILED_ERROR)
                        return { done: false }
                    },
                    onRetry: () => options.logger?.warn('OpenAI Assistant polling retry scheduled')
                })
            }

            // Add message to thread
            await openai.beta.threads.messages.create(threadId, {
                role: 'user',
                content: input
            })

            // Run assistant thread
            const llmIds = await analyticHandlers.onLLMStart('ChatOpenAI', input, parentIds)
            const toolBudget = createToolExecutionBudget()
            const downloadBudget = createDownloadBudget(toolBudget.deadlineAt)

            let text = ''
            let runThreadId = ''
            let isStreamingStarted = false

            let toolChoice: any
            if (_toolChoice) {
                if (_toolChoice === 'file_search') {
                    toolChoice = { type: 'file_search' }
                } else if (_toolChoice === 'code_interpreter') {
                    toolChoice = { type: 'code_interpreter' }
                } else if (_toolChoice === 'none' || _toolChoice === 'auto' || _toolChoice === 'required') {
                    toolChoice = _toolChoice
                } else {
                    toolChoice = { type: 'function', function: { name: _toolChoice } }
                }
            }

            if (shouldStreamResponse) {
                const storageCommitTracker = createIrreversibleCommitTracker()
                const accountStoredBytes = updateStorageUsage
                    ? (totalSize: number) => updateStorageUsage(options.orgId, options.workspaceId, totalSize, options.usageCacheManager)
                    : undefined
                try {
                    await withAbortTimeout(
                        async (signal) => {
                            const streamThread = await openai.beta.threads.runs.create(
                                threadId,
                                {
                                    assistant_id: retrievedAssistant.id,
                                    stream: true,
                                    tools: runTools,
                                    tool_choice: toolChoice,
                                    parallel_tool_calls: parallelToolCalls
                                },
                                { signal }
                            )

                            for await (const event of streamThread) {
                                if (signal.aborted || Date.now() >= toolBudget.deadlineAt) {
                                    throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
                                }
                                if (event.event === 'thread.run.created') {
                                    runThreadId = event.data.id
                                }

                                if (event.event === 'thread.message.delta') {
                                    const chunk = event.data.delta.content?.[0]

                                    if (chunk && 'text' in chunk) {
                                        if (chunk.text?.annotations?.length) {
                                            const message_content = chunk.text
                                            const annotations = chunk.text?.annotations

                                            // Iterate over the annotations
                                            for (let index = 0; index < annotations.length; index++) {
                                                const annotation = annotations[index]
                                                let filePath = ''

                                                // Gather citations based on annotation attributes
                                                const file_citation = (annotation as OpenAI.Beta.Threads.Messages.FileCitationAnnotation)
                                                    .file_citation
                                                if (file_citation && !disableFileDownload) {
                                                    const cited_file = await retrieveFileMetadata(
                                                        openai,
                                                        file_citation.file_id,
                                                        downloadBudget,
                                                        signal,
                                                        options
                                                    )
                                                    // eslint-disable-next-line no-useless-escape
                                                    const fileName = cited_file.filename.split(/[\/\\]/).pop() ?? cited_file.filename
                                                    if (!disableFileDownload) {
                                                        if (checkStorage)
                                                            await checkStorage(
                                                                options.orgId,
                                                                options.subscriptionId,
                                                                options.usageCacheManager
                                                            )

                                                        const { path } = await downloadFile(
                                                            openAIApiKey,
                                                            cited_file,
                                                            fileName,
                                                            options.orgId,
                                                            options,
                                                            downloadBudget,
                                                            signal,
                                                            storageCommitTracker,
                                                            accountStoredBytes,
                                                            options.chatflowid,
                                                            chatId
                                                        )
                                                        if (signal.aborted || Date.now() >= toolBudget.deadlineAt) {
                                                            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
                                                        }
                                                        filePath = path
                                                        fileAnnotations.push({
                                                            filePath,
                                                            fileName
                                                        })
                                                    }
                                                } else {
                                                    const file_path = (annotation as OpenAI.Beta.Threads.Messages.FilePathAnnotation)
                                                        .file_path
                                                    if (file_path && !disableFileDownload) {
                                                        const cited_file = await retrieveFileMetadata(
                                                            openai,
                                                            file_path.file_id,
                                                            downloadBudget,
                                                            signal,
                                                            options
                                                        )
                                                        // eslint-disable-next-line no-useless-escape
                                                        const fileName = cited_file.filename.split(/[\/\\]/).pop() ?? cited_file.filename
                                                        if (!disableFileDownload) {
                                                            if (checkStorage)
                                                                await checkStorage(
                                                                    options.orgId,
                                                                    options.subscriptionId,
                                                                    options.usageCacheManager
                                                                )

                                                            const { path } = await downloadFile(
                                                                openAIApiKey,
                                                                cited_file,
                                                                fileName,
                                                                options.orgId,
                                                                options,
                                                                downloadBudget,
                                                                signal,
                                                                storageCommitTracker,
                                                                accountStoredBytes,
                                                                options.chatflowid,
                                                                chatId
                                                            )
                                                            if (signal.aborted || Date.now() >= toolBudget.deadlineAt) {
                                                                throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
                                                            }
                                                            filePath = path
                                                            fileAnnotations.push({
                                                                filePath,
                                                                fileName
                                                            })
                                                        }
                                                    }
                                                }

                                                // Replace the text with a footnote
                                                message_content.value = message_content.value?.replace(
                                                    `${annotation.text}`,
                                                    `${disableFileDownload ? '' : filePath}`
                                                )
                                            }

                                            // Remove lenticular brackets
                                            message_content.value = message_content.value?.replace(lenticularBracketRegex, '')

                                            text += message_content.value ?? ''

                                            if (message_content.value) {
                                                if (!isStreamingStarted) {
                                                    isStreamingStarted = true
                                                    if (sseStreamer) {
                                                        sseStreamer.streamStartEvent(chatId, message_content.value)
                                                    }
                                                }
                                                if (sseStreamer) {
                                                    sseStreamer.streamTokenEvent(chatId, message_content.value)
                                                }
                                            }

                                            if (fileAnnotations.length) {
                                                if (!isStreamingStarted) {
                                                    isStreamingStarted = true
                                                    if (sseStreamer) {
                                                        sseStreamer.streamStartEvent(chatId, ' ')
                                                    }
                                                }
                                                if (sseStreamer) {
                                                    sseStreamer.streamFileAnnotationsEvent(chatId, fileAnnotations)
                                                }
                                            }
                                        } else {
                                            text += chunk.text?.value
                                            if (!isStreamingStarted) {
                                                isStreamingStarted = true
                                                if (sseStreamer) {
                                                    sseStreamer.streamStartEvent(chatId, chunk.text?.value || '')
                                                }
                                            }
                                            if (sseStreamer) {
                                                sseStreamer.streamTokenEvent(chatId, chunk.text?.value || '')
                                            }
                                        }
                                    }

                                    if (chunk && 'image_file' in chunk && chunk.image_file?.file_id && !disableFileDownload) {
                                        const fileId = chunk.image_file.file_id
                                        const fileObj = await retrieveFileMetadata(openai, fileId, downloadBudget, signal, options)

                                        if (checkStorage)
                                            await checkStorage(options.orgId, options.subscriptionId, options.usageCacheManager)

                                        const { filePath } = await downloadImg(
                                            openai,
                                            fileId,
                                            `${fileObj.filename}.png`,
                                            fileObj.bytes,
                                            options.orgId,
                                            options,
                                            downloadBudget,
                                            signal,
                                            storageCommitTracker,
                                            accountStoredBytes,
                                            options.chatflowid,
                                            chatId
                                        )
                                        if (signal.aborted || Date.now() >= toolBudget.deadlineAt) {
                                            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
                                        }
                                        artifacts.push({ type: 'png', data: filePath })

                                        if (!isStreamingStarted) {
                                            isStreamingStarted = true
                                            if (sseStreamer) {
                                                sseStreamer.streamStartEvent(chatId, ' ')
                                            }
                                        }
                                        if (sseStreamer) {
                                            sseStreamer.streamArtifactsEvent(chatId, artifacts)
                                        }
                                    }
                                }

                                if (event.event === 'thread.run.requires_action') {
                                    runThreadId = event.data.id
                                    const toolCalls = event.data.required_action?.submit_tool_outputs.tool_calls
                                    if (toolCalls) {
                                        try {
                                            const submitToolOutputs = await executeToolCalls({
                                                toolCalls,
                                                tools,
                                                budget: toolBudget,
                                                analyticHandlers,
                                                parentIds,
                                                threadId,
                                                chatId,
                                                input,
                                                usedTools,
                                                options
                                            })
                                            if (signal.aborted || Date.now() >= toolBudget.deadlineAt) {
                                                throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
                                            }
                                            const result = await handleToolSubmission({
                                                openai,
                                                threadId,
                                                runThreadId,
                                                submitToolOutputs,
                                                tools,
                                                analyticHandlers,
                                                parentIds,
                                                llmIds,
                                                sseStreamer,
                                                chatId,
                                                options,
                                                input,
                                                usedTools,
                                                text,
                                                isStreamingStarted,
                                                budget: toolBudget,
                                                abortSignal: signal
                                            })
                                            text = result.text
                                            isStreamingStarted = result.isStreamingStarted
                                        } catch {
                                            options.logger?.error('OpenAI Assistant tool submission failed')
                                            await cancelRunSafely(openai, threadId, runThreadId, options)
                                            const errMsg = OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR
                                            await analyticHandlers.onLLMError(llmIds, errMsg)
                                            await analyticHandlers.onChainError(parentIds, errMsg, true)
                                            throw new Error(errMsg)
                                        }
                                    }
                                }
                            }
                        },
                        Math.max(1, toolBudget.deadlineAt - Date.now()),
                        undefined,
                        () => storageCommitTracker.waitForIdle()
                    )
                } catch {
                    options.logger?.error('OpenAI Assistant streaming run failed')
                    await cancelRunSafely(openai, threadId, runThreadId, options)
                    await analyticHandlers.onLLMError(llmIds, 'OpenAI Assistant streaming run failed')
                    throw new Error('OpenAI Assistant streaming run failed')
                }

                // List messages
                const messages = await openai.beta.threads.messages.list(threadId)
                const messageData = messages.data ?? []
                const assistantMessages = messageData.filter((msg) => msg.role === 'assistant')
                if (!assistantMessages.length) return ''

                // Remove images from the logging text
                let llmOutput = text.replace(imageRegex, '')
                llmOutput = llmOutput.replace('<br/>', '')

                await analyticHandlers.onLLMEnd(llmIds, llmOutput)
                await analyticHandlers.onChainEnd(parentIds, messageData, true)
                return {
                    text,
                    usedTools,
                    artifacts,
                    fileAnnotations,
                    assistant: { assistantId: openAIAssistantId, threadId, runId: runThreadId, messages: messageData }
                }
            }

            // Polling run status
            const runThread = await withAbortTimeout(
                (signal) =>
                    openai.beta.threads.runs.create(
                        threadId,
                        {
                            assistant_id: retrievedAssistant.id,
                            tools: runTools,
                            tool_choice: toolChoice,
                            parallel_tool_calls: parallelToolCalls
                        },
                        { signal }
                    ),
                Math.max(1, toolBudget.deadlineAt - Date.now())
            )
            runThreadId = runThread.id

            try {
                await serialPoll({
                    operation: async (signal) => {
                        const run = await openai.beta.threads.runs.retrieve(runThread.id, { thread_id: threadId }, { signal })
                        if (run.status !== 'requires_action') return run

                        const toolCalls = run.required_action?.submit_tool_outputs.tool_calls
                        const submitToolOutputs = await executeToolCalls({
                            toolCalls,
                            tools,
                            budget: toolBudget,
                            analyticHandlers,
                            parentIds,
                            threadId,
                            chatId,
                            input,
                            usedTools,
                            options
                        })
                        await openai.beta.threads.runs.submitToolOutputs(
                            runThread.id,
                            {
                                tool_outputs: submitToolOutputs,
                                thread_id: threadId
                            },
                            { signal }
                        )
                        return { ...run, status: 'in_progress' as const }
                    },
                    evaluate: (run) => {
                        if (run.status === 'completed') return { done: true, value: undefined }
                        if (['cancelled', 'expired', 'failed', 'incomplete'].includes(run.status)) {
                            throw new Error(OPENAI_ASSISTANT_POLL_FAILED_ERROR)
                        }
                        if (!['queued', 'in_progress', 'cancelling'].includes(run.status)) {
                            throw new Error(OPENAI_ASSISTANT_POLL_FAILED_ERROR)
                        }
                        return { done: false }
                    },
                    maxWaitMs: Math.max(1, toolBudget.deadlineAt - Date.now()),
                    onRetry: () => options.logger?.warn('OpenAI Assistant polling retry scheduled')
                })
            } catch {
                options.logger?.error('OpenAI Assistant run failed')
                await cancelRunSafely(openai, threadId, runThreadId, options)
                await analyticHandlers.onLLMError(llmIds, OPENAI_ASSISTANT_POLL_FAILED_ERROR)
                throw new Error(OPENAI_ASSISTANT_POLL_FAILED_ERROR)
            }

            // List messages
            const messages = await openai.beta.threads.messages.list(threadId)
            const messageData = messages.data ?? []
            const assistantMessages = messageData.filter((msg) => msg.role === 'assistant')
            if (!assistantMessages.length) return ''

            let returnVal = ''
            for (let i = 0; i < assistantMessages[0].content.length; i += 1) {
                if (assistantMessages[0].content[i].type === 'text') {
                    const content = assistantMessages[0].content[i] as OpenAI.Beta.Threads.Messages.TextContentBlock

                    if (content.text.annotations) {
                        const message_content = content.text
                        const annotations = message_content.annotations

                        // Iterate over the annotations
                        for (let index = 0; index < annotations.length; index++) {
                            const annotation = annotations[index]
                            let filePath = ''

                            // Gather citations based on annotation attributes
                            const file_citation = (annotation as OpenAI.Beta.Threads.Messages.FileCitationAnnotation).file_citation

                            if (file_citation && !disableFileDownload) {
                                const cited_file = await retrieveFileMetadata(
                                    openai,
                                    file_citation.file_id,
                                    downloadBudget,
                                    undefined,
                                    options
                                )
                                // eslint-disable-next-line no-useless-escape
                                const fileName = cited_file.filename.split(/[\/\\]/).pop() ?? cited_file.filename
                                if (!disableFileDownload) {
                                    if (checkStorage) await checkStorage(options.orgId, options.subscriptionId, options.usageCacheManager)

                                    const { path, totalSize } = await downloadFile(
                                        openAIApiKey,
                                        cited_file,
                                        fileName,
                                        options.orgId,
                                        options,
                                        downloadBudget,
                                        undefined,
                                        undefined,
                                        undefined,
                                        options.chatflowid,
                                        chatId
                                    )
                                    filePath = path

                                    if (updateStorageUsage)
                                        await updateStorageUsage(options.orgId, options.workspaceId, totalSize, options.usageCacheManager)

                                    fileAnnotations.push({
                                        filePath,
                                        fileName
                                    })
                                }
                            } else {
                                const file_path = (annotation as OpenAI.Beta.Threads.Messages.FilePathAnnotation).file_path
                                if (file_path && !disableFileDownload) {
                                    const cited_file = await retrieveFileMetadata(
                                        openai,
                                        file_path.file_id,
                                        downloadBudget,
                                        undefined,
                                        options
                                    )
                                    // eslint-disable-next-line no-useless-escape
                                    const fileName = cited_file.filename.split(/[\/\\]/).pop() ?? cited_file.filename
                                    if (!disableFileDownload) {
                                        if (checkStorage)
                                            await checkStorage(options.orgId, options.subscriptionId, options.usageCacheManager)

                                        const { path, totalSize } = await downloadFile(
                                            openAIApiKey,
                                            cited_file,
                                            fileName,
                                            options.orgId,
                                            options,
                                            downloadBudget,
                                            undefined,
                                            undefined,
                                            undefined,
                                            options.chatflowid,
                                            chatId
                                        )
                                        filePath = path

                                        if (updateStorageUsage)
                                            await updateStorageUsage(
                                                options.orgId,
                                                options.workspaceId,
                                                totalSize,
                                                options.usageCacheManager
                                            )

                                        fileAnnotations.push({
                                            filePath,
                                            fileName
                                        })
                                    }
                                }
                            }

                            // Replace the text with a footnote
                            message_content.value = message_content.value.replace(
                                `${annotation.text}`,
                                `${disableFileDownload ? '' : filePath}`
                            )
                        }

                        returnVal += message_content.value
                    } else {
                        returnVal += content.text.value
                    }

                    returnVal = returnVal.replace(lenticularBracketRegex, '')
                } else if (!disableFileDownload) {
                    const content = assistantMessages[0].content[i] as OpenAI.Beta.Threads.Messages.ImageFileContentBlock
                    const fileId = content.image_file.file_id
                    const fileObj = await retrieveFileMetadata(openai, fileId, downloadBudget, undefined, options)

                    if (checkStorage) await checkStorage(options.orgId, options.subscriptionId, options.usageCacheManager)

                    const { filePath, totalSize } = await downloadImg(
                        openai,
                        fileId,
                        `${fileObj.filename}.png`,
                        fileObj.bytes,
                        options.orgId,
                        options,
                        downloadBudget,
                        undefined,
                        undefined,
                        undefined,
                        options.chatflowid,
                        chatId
                    )

                    if (updateStorageUsage)
                        await updateStorageUsage(options.orgId, options.workspaceId, totalSize, options.usageCacheManager)

                    artifacts.push({ type: 'png', data: filePath })
                }
            }

            let llmOutput = returnVal.replace(imageRegex, '')
            llmOutput = llmOutput.replace('<br/>', '')

            await analyticHandlers.onLLMEnd(llmIds, llmOutput)
            await analyticHandlers.onChainEnd(parentIds, messageData, true)

            return {
                text: returnVal,
                usedTools,
                artifacts,
                fileAnnotations,
                assistant: { assistantId: openAIAssistantId, threadId, runId: runThreadId, messages: messageData }
            }
        } catch {
            const errMsg = 'OpenAI Assistant execution failed'
            await analyticHandlers.onChainError(parentIds, errMsg, true)
            throw new Error(errMsg)
        }
    }
}

async function retrieveFileMetadata(
    openai: OpenAI,
    fileId: string,
    downloadBudget: DownloadBudget,
    parentSignal: AbortSignal | undefined,
    options: ICommonObject
): Promise<any> {
    const remainingMs = downloadBudget.deadlineAt - Date.now()
    if (remainingMs <= 0 || downloadBudget.files >= downloadBudget.maxFiles || downloadBudget.bytes >= downloadBudget.maxBytes) {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }

    try {
        return await withAbortTimeout((signal) => openai.files.retrieve(fileId, { signal }), remainingMs, parentSignal)
    } catch {
        options.logger?.error('OpenAI Assistant file metadata retrieval failed')
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
}

const downloadImg = async (
    openai: OpenAI,
    fileId: string,
    fileName: string,
    declaredBytes: number | undefined,
    orgId: string,
    options: ICommonObject,
    downloadBudget: DownloadBudget,
    parentSignal: AbortSignal | undefined,
    commitTracker: IrreversibleCommitTracker | undefined,
    onStored: ((totalSize: number) => Promise<void>) | undefined,
    ...paths: string[]
): Promise<{ filePath: string; totalSize: number }> => {
    try {
        const { path, totalSize } = await downloadAndStoreBounded({
            getResponse: (signal) => openai.files.content(fileId, { signal }),
            kind: 'image',
            store: (data) => addSingleFileToStorage('image/png', data, fileName, orgId, ...paths),
            parentSignal,
            deadlineAt: downloadBudget.deadlineAt,
            budget: downloadBudget,
            declaredBytes,
            commitTracker,
            onStored: onStored ? ({ totalSize }) => onStored(totalSize) : undefined
        })
        return { filePath: path, totalSize }
    } catch {
        options.logger?.error('OpenAI Assistant file download failed')
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
}

const downloadFile = async (
    openAIApiKey: string,
    fileObj: any,
    fileName: string,
    orgId: string,
    options: ICommonObject,
    downloadBudget: DownloadBudget,
    parentSignal: AbortSignal | undefined,
    commitTracker: IrreversibleCommitTracker | undefined,
    onStored: ((totalSize: number) => Promise<void>) | undefined,
    ...paths: string[]
): Promise<{ path: string; totalSize: number }> => {
    try {
        if (typeof fileObj?.bytes === 'number' && fileObj.bytes > OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES) {
            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        }
        return await downloadAndStoreBounded({
            getResponse: (signal) =>
                fetch(`https://api.openai.com/v1/files/${fileObj.id}/content`, {
                    method: 'GET',
                    headers: { Accept: '*/*', Authorization: `Bearer ${openAIApiKey}` },
                    signal: signal as any
                }),
            kind: 'file',
            store: (data) => addSingleFileToStorage('application/octet-stream', data, fileName, orgId, ...paths),
            parentSignal,
            deadlineAt: downloadBudget.deadlineAt,
            budget: downloadBudget,
            declaredBytes: fileObj?.bytes,
            commitTracker,
            onStored: onStored ? ({ totalSize }) => onStored(totalSize) : undefined
        })
    } catch {
        options.logger?.error('OpenAI Assistant file download failed')
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
}

async function cancelRunSafely(openai: OpenAI, threadId: string, runId: string, options: ICommonObject): Promise<void> {
    if (!threadId || !runId) return
    try {
        await withAbortTimeout((signal) => openai.beta.threads.runs.cancel(runId, { thread_id: threadId }, { signal }), 5_000)
    } catch {
        options.logger?.warn('OpenAI Assistant run cancellation failed')
    }
}

interface ExecuteToolCallsParams {
    toolCalls: any[] | undefined
    tools: any[]
    budget: ToolExecutionBudget
    analyticHandlers: AnalyticHandler
    parentIds: ICommonObject
    threadId: string
    chatId: string
    input: string
    usedTools: IUsedTool[]
    options: ICommonObject
}

async function executeToolCalls(params: ExecuteToolCallsParams): Promise<Array<{ tool_call_id: string; output: string }>> {
    const actions = prepareToolActions(params.toolCalls ?? [], params.tools, params.budget)
    const outputs: Array<{ tool_call_id: string; output: string }> = []

    for (const action of actions) {
        const toolIds = await params.analyticHandlers.onToolStart(action.tool.name, action.toolInput, params.parentIds)
        try {
            const remainingMs = params.budget.deadlineAt - Date.now()
            if (remainingMs <= 0) throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
            const toolOutput = await withAbortTimeout<any>(
                (signal) =>
                    action.tool.call(action.toolInput, undefined, undefined, {
                        sessionId: params.threadId,
                        chatId: params.chatId,
                        input: params.input,
                        signal
                    }),
                remainingMs
            )
            const serializedOutput = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput)
            if (typeof serializedOutput !== 'string') throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
            const outputBytes = Buffer.byteLength(serializedOutput)
            if (
                outputBytes > params.budget.maxSingleOutputBytes ||
                params.budget.outputBytes + outputBytes > params.budget.maxOutputBytes
            ) {
                throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
            }
            params.budget.outputBytes += outputBytes
            await params.analyticHandlers.onToolEnd(toolIds, toolOutput)
            outputs.push({
                tool_call_id: action.toolCallId,
                output: serializedOutput
            })
            params.usedTools.push({
                tool: action.tool.name,
                toolInput: action.toolInput,
                toolOutput
            })
        } catch {
            await params.analyticHandlers.onToolError(toolIds, new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR))
            params.options.logger?.error('OpenAI Assistant tool execution failed')
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }
    }

    return outputs
}

interface ToolSubmissionParams {
    openai: OpenAI
    threadId: string
    runThreadId: string
    submitToolOutputs: any[]
    tools: any[]
    analyticHandlers: AnalyticHandler
    parentIds: ICommonObject
    llmIds: ICommonObject
    sseStreamer: IServerSideEventStreamer
    chatId: string
    options: ICommonObject
    input: string
    usedTools: IUsedTool[]
    text: string
    isStreamingStarted: boolean
    budget: ToolExecutionBudget
    abortSignal: AbortSignal
}

interface ToolSubmissionResult {
    text: string
    isStreamingStarted: boolean
}

async function handleToolSubmission(params: ToolSubmissionParams): Promise<ToolSubmissionResult> {
    const {
        openai,
        threadId,
        runThreadId,
        submitToolOutputs,
        tools,
        analyticHandlers,
        parentIds,
        llmIds,
        sseStreamer,
        chatId,
        options,
        input,
        usedTools,
        budget,
        abortSignal
    } = params

    let updatedText = params.text
    let updatedIsStreamingStarted = params.isStreamingStarted

    try {
        if (abortSignal.aborted || Date.now() >= budget.deadlineAt) {
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }
        const stream = openai.beta.threads.runs.submitToolOutputsStream(
            runThreadId,
            {
                tool_outputs: submitToolOutputs,
                thread_id: threadId
            },
            { signal: abortSignal }
        )

        for await (const event of stream) {
            if (abortSignal.aborted || Date.now() >= budget.deadlineAt) {
                throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
            }
            if (event.event === 'thread.message.delta') {
                const chunk = event.data.delta.content?.[0]
                if (chunk && 'text' in chunk && chunk.text?.value) {
                    updatedText += chunk.text.value
                    if (!updatedIsStreamingStarted) {
                        updatedIsStreamingStarted = true
                        if (sseStreamer) {
                            sseStreamer.streamStartEvent(chatId, chunk.text.value)
                        }
                    }
                    if (sseStreamer) {
                        sseStreamer.streamTokenEvent(chatId, chunk.text.value)
                    }
                }
            } else if (event.event === 'thread.run.requires_action') {
                const toolCalls = event.data.required_action?.submit_tool_outputs.tool_calls
                if (toolCalls) {
                    const nestedToolOutputs = await executeToolCalls({
                        toolCalls,
                        tools,
                        budget,
                        analyticHandlers,
                        parentIds,
                        threadId,
                        chatId,
                        input,
                        usedTools,
                        options
                    })
                    if (abortSignal.aborted || Date.now() >= budget.deadlineAt) {
                        throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
                    }
                    // Recursively handle nested tool submissions
                    const result = await handleToolSubmission({
                        openai,
                        threadId,
                        runThreadId,
                        submitToolOutputs: nestedToolOutputs,
                        tools,
                        analyticHandlers,
                        parentIds,
                        llmIds,
                        sseStreamer,
                        chatId,
                        options,
                        input,
                        usedTools,
                        text: updatedText,
                        isStreamingStarted: updatedIsStreamingStarted,
                        budget,
                        abortSignal
                    })
                    updatedText = result.text
                    updatedIsStreamingStarted = result.isStreamingStarted
                }
            }
        }

        if (sseStreamer) {
            sseStreamer.streamUsedToolsEvent(chatId, usedTools)
        }

        return {
            text: updatedText,
            isStreamingStarted: updatedIsStreamingStarted
        }
    } catch {
        options.logger?.error('OpenAI Assistant tool submission failed')
        await cancelRunSafely(openai, threadId, runThreadId, options)
        const errMsg = OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR
        await analyticHandlers.onLLMError(llmIds, errMsg)
        await analyticHandlers.onChainError(parentIds, errMsg, true)
        throw new Error(errMsg)
    }
}

interface JSONSchema {
    type?: string
    properties?: Record<string, JSONSchema>
    additionalProperties?: boolean
    required?: string[]
    [key: string]: any
}

const formatToOpenAIAssistantTool = (tool: any): OpenAI.Beta.FunctionTool => {
    const parameters = toolSchemaToJsonSchema(tool.schema) as JSONSchema

    // For strict tools, we need to:
    // 1. Set additionalProperties to false
    // 2. Make all parameters required
    // 3. Set the strict flag
    if (tool instanceof DynamicStructuredTool && tool.isStrict()) {
        // Get all property names from the schema
        const properties = parameters.properties || {}
        const allPropertyNames = Object.keys(properties)

        parameters.additionalProperties = false
        parameters.required = allPropertyNames

        // Handle nested objects
        for (const [_, prop] of Object.entries(properties)) {
            if (prop.type === 'object') {
                prop.additionalProperties = false
                if (prop.properties) {
                    prop.required = Object.keys(prop.properties)
                }
            }
        }
    }

    const functionTool: OpenAI.Beta.FunctionTool = {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters
        }
    }

    // Add strict property if the tool is marked as strict
    if (tool instanceof DynamicStructuredTool && tool.isStrict()) {
        ;(functionTool.function as any).strict = true
    }

    return functionTool
}

module.exports = { nodeClass: OpenAIAssistant_Agents }
