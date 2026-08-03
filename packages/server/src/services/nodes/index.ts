import { ClientType, INodeOptionsValue } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { cloneDeep, omit } from 'lodash'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { INodeData, MODE } from '../../Interface'
import { databaseEntities } from '../../utils'
import { OMIT_QUEUE_JOB_DATA } from '../../utils/constants'
import { executeCustomNodeFunction } from '../../utils/executeCustomNodeFunction'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import credentialsService from '../credentials'
import { decorateDynamicOptions, decorateNodeMetadata } from '../component-metadata-localization'
import { createWorkspaceOAuth2RefreshCapability } from '../oauth2CredentialRefresh'
import { filterNodeByClient } from './filterNodeByClient'

export { filterNodeByClient }

const MAX_NODE_LOAD_BODY_BYTES = 100_000
const MAX_NODE_LOAD_CREDENTIALS = 32
/**
 * Known dynamic methods whose current implementation performs unsafe work during
 * metadata loading. They remain visible in metadata but fail closed until their
 * implementation has a side-effect-free, workspace-bound transport contract.
 */
export const NODE_LOAD_DENY_CAPABILITIES: Record<string, { category: string; reason: string }> = {
    'customMCP.listActions': { category: 'Tools (MCP)', reason: 'user-controlled command or SSE target' },
    'customMcpServerTool.listActions': {
        category: 'Tools (MCP)',
        reason: 'runtime transport patched; metadata re-enable awaits dedicated validation'
    },
    'openAPIToolkit.listEndpoints': { category: 'Tools', reason: 'schema dereference may resolve external refs' },
    'openAPIToolkit.listServers': { category: 'Tools', reason: 'schema dereference may resolve external refs' },
    'supergatewayMCP.listActions': { category: 'Tools (MCP)', reason: 'user-controlled gateway target starts a child process' },
    'toolAgentflow.listToolInputArgs': { category: 'Agent Flows', reason: 'dynamically imports and initializes a selected tool' }
}
export const INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES = new Set(Object.keys(NODE_LOAD_DENY_CAPABILITIES))

type NodeLoadAuthorization = { permissions?: string[]; isOrganizationAdmin?: boolean }
type NodeLoadCapabilityKind =
    | 'flowProvider'
    | 'documentProvider'
    | 'agentflowLocal'
    | 'agentDocumentRead'
    | 'toolLocal'
    | 'toolNetwork'
    | 'toolProvider'
    | 'assistantProvider'
    | 'documentRead'

export const NODE_LOAD_CAPABILITIES: Record<string, { category: string; kind: NodeLoadCapabilityKind }> = {
    'openAI.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'googlevertexai.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'togetherAI.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'azureOpenAI.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'awsBedrock.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'awsBedrock.listRegions': { category: 'LLMs', kind: 'flowProvider' },
    'cohere.listModels': { category: 'LLMs', kind: 'flowProvider' },
    'chatAnthropic.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatAnthropic_LlamaIndex.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatKimi.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatMistral_LlamaIndex.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatPerplexity.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatMistralAI.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatCerebras.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'awsChatBedrock.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'awsChatBedrock.listRegions': { category: 'Chat Models', kind: 'flowProvider' },
    'chatBaiduWenxin.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatGoogleVertexAI.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatGoogleVertexAI.listRegions': { category: 'Chat Models', kind: 'flowProvider' },
    'groqChat.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'azureChatOpenAI_LlamaIndex.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatGoogleGenerativeAI.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatGroq_LlamaIndex.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatDeepseek.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'azureChatOpenAI.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatOpenAI_LlamaIndex.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatOpenAI.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'chatCohere.listModels': { category: 'Chat Models', kind: 'flowProvider' },
    'AWSBedrockEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'AWSBedrockEmbeddings.listRegions': { category: 'Embeddings', kind: 'flowProvider' },
    'googleGenerativeAiEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'cohereEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'mistralAIEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'googlevertexaiEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'googlevertexaiEmbeddings.listRegions': { category: 'Embeddings', kind: 'flowProvider' },
    'voyageAIEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'openAIEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'openAIEmbedding_LlamaIndex.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'baiduQianfanEmbeddings.listModels': { category: 'Embeddings', kind: 'flowProvider' },
    'awsBedrockKBRetriever.listRegions': { category: 'Retrievers', kind: 'flowProvider' },
    'googleDrive.listFiles': { category: 'Document Loaders', kind: 'documentProvider' },
    'googleSheets.listSpreadsheets': { category: 'Document Loaders', kind: 'documentProvider' },
    'S3.listRegions': { category: 'Document Loaders', kind: 'documentProvider' },
    's3Directory.listRegions': { category: 'Document Loaders', kind: 'documentProvider' },
    'documentStoreVS.listStores': { category: 'Vector Stores', kind: 'documentRead' },
    'documentStore.listStores': { category: 'Document Loaders', kind: 'documentRead' },
    'kendra.listRegions': { category: 'Vector Stores', kind: 'flowProvider' },
    'seqExecuteFlow.listFlows': { category: 'Sequential Agents', kind: 'agentflowLocal' },
    'loopAgentflow.listPreviousNodes': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'loopAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'executeFlowAgentflow.listFlows': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'executeFlowAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'humanInputAgentflow.listModels': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'conditionAgentAgentflow.listModels': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAgentflow.listModels': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAgentflow.listEmbeddings': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAgentflow.listTools': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAgentflow.listStores': { category: 'Agent Flows', kind: 'agentDocumentRead' },
    'agentAgentflow.listVectorStores': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'customFunctionAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'retrieverAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'retrieverAgentflow.listStores': { category: 'Agent Flows', kind: 'agentDocumentRead' },
    'llmAgentflow.listModels': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'llmAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'toolAgentflow.listTools': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'toolAgentflow.listRuntimeStateKeys': { category: 'Agent Flows', kind: 'agentflowLocal' },
    'agentAsTool.listAgentflows': { category: 'Tools', kind: 'toolLocal' },
    'ChatflowTool.listChatflows': { category: 'Tools', kind: 'toolLocal' },
    'customTool.listTools': { category: 'Tools', kind: 'toolLocal' },
    'awsSNS.listTopics': { category: 'Tools', kind: 'toolProvider' },
    'awsDynamoDBKVStorage.listTables': { category: 'Tools', kind: 'toolProvider' },
    'braveSearchMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'browserlessMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'composio.listApps': { category: 'Tools', kind: 'toolProvider' },
    'composio.listActions': { category: 'Tools', kind: 'toolProvider' },
    'composio.listConnections': { category: 'Tools', kind: 'toolProvider' },
    'customMcpServerTool.listServers': { category: 'Tools (MCP)', kind: 'toolLocal' },
    'githubMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'pipedreamMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'postgreSQLMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    // The command and module path are fixed by the component; request data cannot select a process.
    'sequentialThinkingMCP.listActions': { category: 'Tools (MCP)', kind: 'toolNetwork' },
    'slackMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'teradataMCP.listActions': { category: 'Tools (MCP)', kind: 'toolProvider' },
    'openAIAssistant.listAssistants': { category: 'Agents', kind: 'assistantProvider' }
}

const hasAnyPermission = (authorization: NodeLoadAuthorization, permissions: string[]): boolean =>
    Boolean(authorization.isOrganizationAdmin || permissions.some((permission) => authorization.permissions?.includes(permission)))

const assertNodeLoadCategoryPermission = (
    category: unknown,
    nodeName: string,
    methodName: string,
    authorization: NodeLoadAuthorization,
    providerBacked: boolean
): void => {
    if (authorization.isOrganizationAdmin) return
    const flowEdit = ['chatflows:create', 'chatflows:update', 'agentflows:create', 'agentflows:update']
    const agentflowEdit = ['agentflows:create', 'agentflows:update']
    const documentStoreEdit = [
        'documentStores:create',
        'documentStores:update',
        'documentStores:add-loader',
        'documentStores:upsert-config'
    ]

    const capability = NODE_LOAD_CAPABILITIES[`${nodeName}.${methodName}`]
    if (!capability || capability.category !== category) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Node load method is not authorized')
    }
    let permitted = false
    if (capability.kind === 'flowProvider') permitted = hasAnyPermission(authorization, flowEdit)
    else if (capability.kind === 'documentProvider') permitted = hasAnyPermission(authorization, documentStoreEdit)
    else if (capability.kind === 'agentflowLocal') permitted = hasAnyPermission(authorization, agentflowEdit)
    else if (capability.kind === 'agentDocumentRead') {
        permitted = hasAnyPermission(authorization, agentflowEdit) && hasAnyPermission(authorization, ['documentStores:view'])
    } else if (capability.kind === 'documentRead') {
        permitted =
            hasAnyPermission(authorization, ['documentStores:view']) && hasAnyPermission(authorization, [...flowEdit, ...documentStoreEdit])
    } else if (capability.kind === 'toolLocal') {
        permitted = hasAnyPermission(authorization, ['tools:view']) && hasAnyPermission(authorization, flowEdit)
    } else if (capability.kind === 'toolProvider' || capability.kind === 'toolNetwork') {
        permitted = hasAnyPermission(authorization, ['tools:create', 'tools:update']) && hasAnyPermission(authorization, flowEdit)
    } else if (capability.kind === 'assistantProvider') {
        permitted = hasAnyPermission(authorization, flowEdit) && hasAnyPermission(authorization, ['assistants:view'])
    }
    if (providerBacked || capability.kind.endsWith('Provider')) {
        // The current RBAC model has no per-credential "use" permission. Requiring
        // credentials:view in addition to module edit authority is the narrowest
        // expressible use grant; workspace ownership is still checked below.
        permitted = permitted && hasAnyPermission(authorization, ['credentials:view'])
    }
    if (!permitted) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Node load method is not authorized')
}

const collectCredentialIds = (value: unknown, depth = 0, found = new Set<string>()): Set<string> => {
    if (depth > 8 || found.size > MAX_NODE_LOAD_CREDENTIALS || value === null || value === undefined) return found
    if (Array.isArray(value)) {
        for (const item of value) collectCredentialIds(item, depth + 1, found)
        return found
    }
    if (typeof value !== 'object') return found
    for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
        if (key === 'credential' || key === 'credentialId' || key === 'FLOWISE_CREDENTIAL_ID') {
            if (typeof candidate === 'string' && candidate.trim() && candidate.length <= 256) found.add(candidate)
            else if (candidate !== undefined && candidate !== null && candidate !== '') {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load credential')
            }
        }
        collectCredentialIds(candidate, depth + 1, found)
    }
    return found
}

const validateNodeLoadRequest = (
    nodeName: string,
    requestBody: any,
    authorization: NodeLoadAuthorization,
    componentNodes: Record<string, any>
): { nodeInstance: any; methodName: string; credentialIds: string[] } => {
    if (
        typeof nodeName !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(nodeName) ||
        !requestBody ||
        typeof requestBody !== 'object' ||
        Array.isArray(requestBody) ||
        Buffer.byteLength(JSON.stringify(requestBody), 'utf8') > MAX_NODE_LOAD_BODY_BYTES
    ) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load request')
    }
    const nodeInstance = componentNodes[nodeName]
    const methodName = requestBody.loadMethod
    const capabilityKey = `${nodeName}.${String(methodName)}`
    if (
        !nodeInstance ||
        nodeInstance.name !== nodeName ||
        typeof methodName !== 'string' ||
        !/^[A-Za-z0-9_]{1,128}$/.test(methodName) ||
        INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES.has(capabilityKey) ||
        !Array.isArray(nodeInstance.inputs) ||
        !nodeInstance.loadMethods ||
        !Object.prototype.hasOwnProperty.call(nodeInstance.loadMethods, methodName) ||
        typeof nodeInstance.loadMethods[methodName] !== 'function'
    ) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load method')
    }
    const methodDeclared = nodeInstance.inputs.some((input: any) => {
        const declared = input?.loadMethod
        return declared === methodName || (Array.isArray(declared) && declared.includes(methodName))
    })
    const methodExplicitlyAllowed = Object.prototype.hasOwnProperty.call(NODE_LOAD_CAPABILITIES, capabilityKey)
    if (!methodDeclared && !methodExplicitlyAllowed) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load method')
    }

    if (requestBody.inputs !== undefined) {
        if (!requestBody.inputs || typeof requestBody.inputs !== 'object' || Array.isArray(requestBody.inputs)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load inputs')
        }
        const allowedInputs = new Set(
            nodeInstance.inputs.map((input: any) => input?.name).filter((name: unknown) => typeof name === 'string')
        )
        allowedInputs.add('FLOWISE_CREDENTIAL_ID')
        allowedInputs.add('credential')
        if (Object.keys(requestBody.inputs).some((key) => !allowedInputs.has(key))) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load inputs')
        }
    }

    const credentialIds = [...collectCredentialIds(requestBody)]
    if (credentialIds.length > MAX_NODE_LOAD_CREDENTIALS) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid node load credentials')
    }
    const providerBacked = Boolean(nodeInstance.credential || credentialIds.length > 0)
    assertNodeLoadCategoryPermission(nodeInstance.category, nodeName, methodName, authorization, providerBacked)
    return { nodeInstance, methodName, credentialIds }
}

// Get all component nodes
const getAllNodes = async (client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = []
        for (const nodeName in appServer.nodesPool.componentNodes) {
            const clonedNode = cloneDeep(appServer.nodesPool.componentNodes[nodeName])
            dbResponse.push(decorateNodeMetadata(filterNodeByClient(clonedNode, client)))
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: nodesService.getAllNodes - ${getErrorMessage(error)}`)
    }
}

// Get all component nodes for a specific category
const getAllNodesForCategory = async (category: string, client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        const dbResponse = []
        for (const nodeName in appServer.nodesPool.componentNodes) {
            const componentNode = appServer.nodesPool.componentNodes[nodeName]
            if (componentNode.category === category) {
                const clonedNode = cloneDeep(componentNode)
                dbResponse.push(decorateNodeMetadata(filterNodeByClient(clonedNode, client)))
            }
        }
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodesService.getAllNodesForCategory - ${getErrorMessage(error)}`
        )
    }
}

// Get specific component node via name
const getNodeByName = async (nodeName: string, client?: ClientType) => {
    try {
        const appServer = getRunningExpressApp()
        if (Object.prototype.hasOwnProperty.call(appServer.nodesPool.componentNodes, nodeName)) {
            const clonedNode = cloneDeep(appServer.nodesPool.componentNodes[nodeName])
            return decorateNodeMetadata(filterNodeByClient(clonedNode, client))
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} not found`)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: nodesService.getAllNodes - ${getErrorMessage(error)}`)
    }
}

// Returns specific component node icon via name
const getSingleNodeIcon = async (nodeName: string) => {
    try {
        const appServer = getRunningExpressApp()
        if (Object.prototype.hasOwnProperty.call(appServer.nodesPool.componentNodes, nodeName)) {
            const nodeInstance = appServer.nodesPool.componentNodes[nodeName]
            if (nodeInstance.icon === undefined) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} icon not found`)
            }

            if (nodeInstance.icon.endsWith('.svg') || nodeInstance.icon.endsWith('.png') || nodeInstance.icon.endsWith('.jpg')) {
                const filepath = nodeInstance.icon
                return filepath
            } else {
                throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Node ${nodeName} icon is missing icon`)
            }
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} not found`)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodesService.getSingleNodeIcon - ${getErrorMessage(error)}`
        )
    }
}

const getSingleNodeAsyncOptions = async (
    nodeName: string,
    requestBody: any,
    workspaceId?: string,
    authorization: NodeLoadAuthorization = {}
): Promise<any> => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Node load method is not authorized')
        const appServer = getRunningExpressApp()
        const nodeData: INodeData = requestBody
        if (Object.prototype.hasOwnProperty.call(appServer.nodesPool.componentNodes, nodeName)) {
            const { nodeInstance, methodName, credentialIds } = validateNodeLoadRequest(
                nodeName,
                requestBody,
                authorization,
                appServer.nodesPool.componentNodes
            )
            for (const credentialId of credentialIds) {
                await credentialsService.assertCredentialInWorkspace(credentialId, workspaceId)
            }

            try {
                const dbResponse: INodeOptionsValue[] = await nodeInstance.loadMethods![methodName]!.call(nodeInstance, nodeData, {
                    appDataSource: appServer.AppDataSource,
                    databaseEntities: databaseEntities,
                    workspaceId,
                    componentNodes: appServer.nodesPool.componentNodes,
                    previousNodes: requestBody.previousNodes,
                    currentNode: requestBody.currentNode,
                    searchOptions: {
                        ...(requestBody.searchOptions &&
                        typeof requestBody.searchOptions === 'object' &&
                        !Array.isArray(requestBody.searchOptions)
                            ? requestBody.searchOptions
                            : {}),
                        workspaceId
                    },
                    cachePool: appServer.cachePool,
                    skipVariables: true,
                    canViewVariables: false,
                    refreshOAuth2Credential: createWorkspaceOAuth2RefreshCapability(workspaceId)
                })

                return decorateDynamicOptions(nodeName, methodName, dbResponse)
            } catch (error) {
                return []
            }
        } else {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Node ${nodeName} not found`)
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            throw error
        }
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodesService.getSingleNodeAsyncOptions - ${getErrorMessage(error)}`
        )
    }
}

// execute custom function node
const executeCustomFunction = async (requestBody: any, workspaceId?: string, orgId?: string, canViewVariables?: boolean) => {
    const appServer = getRunningExpressApp()
    const executeData = {
        appDataSource: appServer.AppDataSource,
        componentNodes: appServer.nodesPool.componentNodes,
        data: requestBody,
        isExecuteCustomFunction: true,
        canViewVariables,
        orgId,
        workspaceId
    }

    if (process.env.MODE === MODE.QUEUE) {
        const predictionQueue = appServer.queueManager.getQueue('prediction')

        const job = await predictionQueue.addJob(omit(executeData, OMIT_QUEUE_JOB_DATA))
        logger.debug(`[server]: Execute Custom Function Job added to queue by ${orgId}: ${job.id}`)

        const queueEvents = predictionQueue.getQueueEvents()
        const result = await job.waitUntilFinished(queueEvents)
        if (!result) {
            throw new Error('Failed to execute custom function')
        }

        return result
    } else {
        return await executeCustomNodeFunction(executeData)
    }
}

export default {
    getAllNodes,
    getNodeByName,
    getSingleNodeIcon,
    getSingleNodeAsyncOptions,
    executeCustomFunction,
    getAllNodesForCategory
}
