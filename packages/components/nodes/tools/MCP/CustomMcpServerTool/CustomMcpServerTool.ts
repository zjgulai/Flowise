import { Tool } from '@langchain/core/tools'
import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../../src/Interface'
import { MCPToolkit } from '../core'
import { decryptCredentialData } from '../../../../src/utils'
import { DataSource } from 'typeorm'
import { createHash } from 'crypto'

const MCP_CACHE_REFRESH_ERROR = 'MCP server cache refresh failed'
const MCP_TOOLKIT_CLOSE_TIMEOUT_MS = 1_000

function normalizeUpdatedDate(value: unknown): string {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString()
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function createConfigFingerprint(serverRecord: Record<string, any>): string {
    const authConfigDigest = createHash('sha256')
        .update(typeof serverRecord.authConfig === 'string' ? serverRecord.authConfig : '')
        .digest('hex')
    const securityConfig = JSON.stringify({
        workspaceId: serverRecord.workspaceId,
        serverId: serverRecord.id,
        url: serverRecord.serverUrl,
        transportType: 'sse',
        authType: serverRecord.authType,
        authConfigDigest,
        status: serverRecord.status,
        updatedDate: normalizeUpdatedDate(serverRecord.updatedDate)
    })
    return createHash('sha256').update(securityConfig).digest('hex')
}

async function closeToolkitBestEffort(cachedResult: any): Promise<void> {
    const toolkit = cachedResult?.toolkit
    const closeTarget =
        typeof toolkit?.close === 'function' ? toolkit : typeof toolkit?.client?.close === 'function' ? toolkit.client : undefined
    if (!closeTarget) return

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            Promise.resolve().then(() => closeTarget.close.call(closeTarget)),
            new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, MCP_TOOLKIT_CLOSE_TIMEOUT_MS)
            })
        ])
    } catch {
        // Resource cleanup is best effort and must not expose SDK details.
    } finally {
        if (timeout) clearTimeout(timeout)
    }
}

class CustomMcpServerTool implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Custom MCP Server'
        this.name = 'customMcpServerTool'
        this.version = 1.0
        this.type = 'Custom MCP Server Tool'
        this.icon = 'customMCP.png'
        this.category = 'Tools (MCP)'
        this.description = 'Use tools from authorized MCP servers configured in workspace'
        this.inputs = [
            {
                label: 'Custom MCP Server',
                name: 'mcpServerId',
                type: 'asyncOptions',
                loadMethod: 'listServers'
            },
            {
                label: 'Available Actions',
                name: 'mcpActions',
                type: 'asyncMultiOptions',
                loadMethod: 'listActions',
                refresh: true
            }
        ]
        this.baseClasses = ['Tool']
    }

    //@ts-ignore
    loadMethods = {
        listServers: async (_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const appDataSource = options.appDataSource as DataSource
                const databaseEntities = options.databaseEntities as IDatabaseEntity
                if (!appDataSource || !databaseEntities?.['CustomMcpServer']) {
                    return []
                }

                const workspaceId = (options.searchOptions as ICommonObject | undefined)?.workspaceId as string | undefined
                if (!workspaceId) return []

                const mcpServers = await appDataSource.getRepository(databaseEntities['CustomMcpServer']).find({
                    where: { workspaceId, status: 'AUTHORIZED' },
                    order: { updatedDate: 'DESC' }
                })

                return mcpServers.map((server: any) => {
                    let maskedUrl: string
                    try {
                        const parsed = new URL(server.serverUrl)
                        maskedUrl = parsed.pathname && parsed.pathname !== '/' ? `${parsed.origin}/************` : parsed.origin
                    } catch {
                        maskedUrl = '************'
                    }
                    return {
                        label: server.name,
                        name: server.id,
                        description: maskedUrl
                    }
                })
            } catch (error) {
                return []
            }
        },
        listActions: async (nodeData: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> => {
            try {
                const toolset = await this.getTools(nodeData, options)
                toolset.sort((a: any, b: any) => a.name.localeCompare(b.name))

                return toolset.map(({ name, ...rest }) => ({
                    label: name.toUpperCase(),
                    name: name,
                    description: rest.description || name
                }))
            } catch (error) {
                return [
                    {
                        label: 'No Available Actions',
                        name: 'error',
                        description: 'Select an authorized MCP server first, then refresh'
                    }
                ]
            }
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const tools = await this.getTools(nodeData, options)

        const _mcpActions = nodeData.inputs?.mcpActions
        let mcpActions: string[] = []
        if (_mcpActions) {
            try {
                mcpActions = typeof _mcpActions === 'string' ? JSON.parse(_mcpActions) : _mcpActions
            } catch {
                // Fail closed without logging user-controlled parser details.
                mcpActions = []
            }
        }

        return tools.filter((tool: any) => mcpActions.includes(tool.name))
    }

    async getTools(nodeData: INodeData, options: ICommonObject): Promise<Tool[]> {
        const serverId = nodeData.inputs?.mcpServerId as string
        if (!serverId) {
            throw new Error('MCP Server is required')
        }

        const appDataSource = options.appDataSource as DataSource
        const databaseEntities = options.databaseEntities as IDatabaseEntity
        if (!appDataSource || !databaseEntities?.['CustomMcpServer']) {
            throw new Error('Database not available')
        }

        const workspaceId =
            (options.workspaceId as string | undefined) ??
            ((options.searchOptions as ICommonObject | undefined)?.workspaceId as string | undefined)
        if (!workspaceId) {
            throw new Error('Workspace context is required to load MCP server')
        }

        const repository = appDataSource.getRepository(databaseEntities['CustomMcpServer'])
        const loadAuthorizedRecord = async (): Promise<any> => {
            const serverRecord = await repository.findOneBy({ id: serverId, workspaceId })
            if (!serverRecord) throw new Error(`MCP server ${serverId} not found`)
            if (serverRecord.status !== 'AUTHORIZED') {
                throw new Error(`MCP server "${serverRecord.name}" is not authorized. Please authorize it in the Tools page first.`)
            }
            return serverRecord
        }
        const buildServerParams = async (serverRecord: any): Promise<Record<string, unknown>> => {
            // Decrypt on every load, including cache hits, so a stale in-memory
            // secret cannot bypass a current credential-decryption failure.
            let headers: Record<string, string> = {}
            if (serverRecord.authType === 'CUSTOM_HEADERS') {
                if (!serverRecord.authConfig) throw new Error('MCP server credentials unavailable')
                try {
                    const decrypted = await decryptCredentialData(serverRecord.authConfig)
                    if (decrypted?.headers && typeof decrypted.headers === 'object' && !Array.isArray(decrypted.headers)) {
                        headers = decrypted.headers as Record<string, string>
                    } else throw new Error('Invalid MCP header configuration')
                } catch {
                    throw new Error('MCP server credentials unavailable')
                }
            }
            return {
                url: serverRecord.serverUrl,
                ...(Object.keys(headers).length > 0 ? { headers } : {})
            }
        }
        const initializeToolkit = async (
            serverParams: Record<string, unknown>,
            configFingerprint: string
        ): Promise<{ toolkit: MCPToolkit; tools: Tool[] }> => {
            const toolkit = new MCPToolkit(serverParams, 'sse')
            toolkit.getToolCallHeaders = async () => {
                try {
                    const latestRecord = await loadAuthorizedRecord()
                    if (createConfigFingerprint(latestRecord) !== configFingerprint) throw new Error(MCP_CACHE_REFRESH_ERROR)
                    const latestParams = await buildServerParams(latestRecord)
                    return (latestParams.headers as Record<string, string> | undefined) ?? {}
                } catch {
                    // Previously returned tool objects must fail closed after a
                    // URL or credential rotation instead of reusing old config.
                    throw new Error(MCP_CACHE_REFRESH_ERROR)
                }
            }
            try {
                await toolkit.initialize()
                const tools = (toolkit.tools ?? []).map((tool: Tool) => {
                    tool.name = this.formatToolName(tool.name)
                    return tool
                }) as Tool[]
                return { toolkit, tools }
            } catch {
                await closeToolkitBestEffort({ toolkit })
                throw new Error(MCP_CACHE_REFRESH_ERROR)
            }
        }
        const initializeVerifiedToolkit = async (
            serverParams: Record<string, unknown>,
            configFingerprint: string
        ): Promise<{ toolkit: MCPToolkit; tools: Tool[] }> => {
            const initialized = await initializeToolkit(serverParams, configFingerprint)
            try {
                const latestRecord = await loadAuthorizedRecord()
                if (createConfigFingerprint(latestRecord) !== configFingerprint) throw new Error(MCP_CACHE_REFRESH_ERROR)
                return initialized
            } catch {
                await closeToolkitBestEffort(initialized)
                throw new Error(MCP_CACHE_REFRESH_ERROR)
            }
        }

        const cachePool = options.cachePool as any
        const supportsSafeCache =
            cachePool &&
            typeof cachePool.getMCPCache === 'function' &&
            typeof cachePool.addMCPCache === 'function' &&
            typeof cachePool.removeMCPCache === 'function' &&
            typeof cachePool.withMCPCacheLock === 'function'
        if (!supportsSafeCache) {
            const serverRecord = await loadAuthorizedRecord()
            const configFingerprint = createConfigFingerprint(serverRecord)
            const serverParams = await buildServerParams(serverRecord)
            return (await initializeVerifiedToolkit(serverParams, configFingerprint)).tools
        }

        const cacheKey = `customMcpServer:${workspaceId}:${serverId}`
        return cachePool.withMCPCacheLock(cacheKey, async () => {
            // The record must be read after acquiring the scoped lock. A caller
            // that waited behind a rotation must never restore its older snapshot.
            const serverRecord = await loadAuthorizedRecord()
            const configFingerprint = createConfigFingerprint(serverRecord)
            const serverParams = await buildServerParams(serverRecord)
            const cachedResult = await cachePool.getMCPCache(cacheKey)
            if (cachedResult?.configFingerprint === configFingerprint && Array.isArray(cachedResult.tools)) {
                return cachedResult.tools as Tool[]
            }

            if (cachedResult) {
                let removedResult: any
                try {
                    // Detach stale credentials before cleanup. A broken SDK
                    // close must never keep the old entry reachable.
                    removedResult = await cachePool.removeMCPCache(cacheKey)
                } catch {
                    throw new Error(MCP_CACHE_REFRESH_ERROR)
                }
                await closeToolkitBestEffort(removedResult ?? cachedResult)
            }

            const initialized = await initializeVerifiedToolkit(serverParams, configFingerprint)
            try {
                await cachePool.addMCPCache(cacheKey, { ...initialized, configFingerprint })
            } catch {
                await closeToolkitBestEffort(initialized)
                throw new Error(MCP_CACHE_REFRESH_ERROR)
            }
            return initialized.tools
        })
    }

    /**
     * Formats the tool name to ensure it is a valid identifier by replacing spaces and special characters with underscores.
     * This is necessary because tool names may be used as identifiers in various contexts where special characters could cause issues.
     * For example, a tool named "Get User Info" would be formatted to "Get_User_Info".
     * This method can be enhanced further to handle edge cases as needed.
     */
    private formatToolName = (name: string): string => name.trim().replace(/[^a-zA-Z0-9_-]/g, '_')
}

module.exports = { nodeClass: CustomMcpServerTool }
