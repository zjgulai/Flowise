import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockAssertCredentialInWorkspace = jest.fn()
const mockGoogleListFiles = jest.fn()
const mockListStores = jest.fn()
const mockListTools = jest.fn()
const mockListToolInputArgs = jest.fn()
const mockListRuntimeStateKeys = jest.fn()
const mockListAssistants = jest.fn()
const mockUnsafeNetworkList = jest.fn()

jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockAssertCredentialInWorkspace(...args) }
}))
jest.mock('../component-metadata-localization', () => ({
    decorateDynamicOptions: (_nodeName: string, _methodName: string, options: unknown) => options,
    decorateNodeMetadata: (node: unknown) => node
}))
jest.mock('../../utils', () => ({ databaseEntities: {} }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: {} }))

import nodesService, { INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES, NODE_LOAD_CAPABILITIES } from '.'
import { ZH_CN_DYNAMIC_POLICIES } from '../component-metadata-localization/catalog/zhCNDynamicPolicies'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

const component = (name: string, category: string, method: string, fn: jest.Mock, credential = false) => ({
    name,
    category,
    inputs: [{ name: 'selection', loadMethod: method }],
    ...(credential ? { credential: { name: 'credential' } } : {}),
    loadMethods: { [method]: fn }
})

describe('node load method capability map', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockAssertCredentialInWorkspace.mockResolvedValue(undefined)
        mockGoogleListFiles.mockResolvedValue([{ label: 'file', name: 'file' }])
        mockListStores.mockResolvedValue([{ label: 'store', name: 'store' }])
        mockListTools.mockResolvedValue([{ label: 'tool', name: 'tool' }])
        mockListToolInputArgs.mockResolvedValue([{ label: 'arg', name: 'arg' }])
        mockListRuntimeStateKeys.mockResolvedValue([{ label: 'state', name: 'state' }])
        mockListAssistants.mockResolvedValue([{ label: 'assistant', name: 'assistant' }])
        mockUnsafeNetworkList.mockResolvedValue([{ label: 'unsafe', name: 'unsafe' }])
        const toolAgentflow = {
            name: 'toolAgentflow',
            category: 'Agent Flows',
            inputs: [{ name: 'selectedTool', loadMethod: 'listTools' }, { name: 'toolInputArgs' }, { name: 'runtimeState' }],
            loadMethods: {
                listTools: mockListTools,
                listToolInputArgs: mockListToolInputArgs,
                listRuntimeStateKeys: mockListRuntimeStateKeys
            }
        }
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            cachePool: {},
            nodesPool: {
                componentNodes: {
                    googleDrive: component('googleDrive', 'Document Loaders', 'listFiles', mockGoogleListFiles, true),
                    documentStoreVS: component('documentStoreVS', 'Vector Stores', 'listStores', mockListStores),
                    customTool: component('customTool', 'Tools', 'listTools', mockListTools),
                    toolAgentflow,
                    openAIAssistant: component('openAIAssistant', 'Agents', 'listAssistants', mockListAssistants, true),
                    customMCP: component('customMCP', 'Tools (MCP)', 'listActions', mockUnsafeNetworkList)
                }
            }
        })
    })

    it('partitions every known dynamic method into one explicit allow or intentional deny', () => {
        const knownMethods = Object.keys(ZH_CN_DYNAMIC_POLICIES).sort()
        const allowedMethods = Object.keys(NODE_LOAD_CAPABILITIES)
        const deniedMethods = [...INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES]

        expect(new Set(allowedMethods).size).toBe(allowedMethods.length)
        expect(allowedMethods.filter((method) => INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES.has(method))).toEqual([])
        expect([...allowedMethods, ...deniedMethods].sort()).toEqual(knownMethods)
        expect(deniedMethods.sort()).toEqual(
            [
                'customMCP.listActions',
                'customMcpServerTool.listActions',
                'openAPIToolkit.listEndpoints',
                'openAPIToolkit.listServers',
                'supergatewayMCP.listActions',
                'toolAgentflow.listToolInputArgs'
            ].sort()
        )
    })

    it('blocks a chatflow viewer from provider-backed Google Drive metadata', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('googleDrive', { loadMethod: 'listFiles', credential: 'credential-1' }, 'workspace-1', {
                permissions: ['chatflows:view', 'credentials:view']
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockGoogleListFiles).not.toHaveBeenCalled()
    })

    it('requires both document-store edit authority and the current credentials:view use contract', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('googleDrive', { loadMethod: 'listFiles', credential: 'credential-1' }, 'workspace-1', {
                permissions: ['documentStores:add-loader']
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockGoogleListFiles).not.toHaveBeenCalled()

        await expect(
            nodesService.getSingleNodeAsyncOptions('googleDrive', { loadMethod: 'listFiles', credential: 'credential-1' }, 'workspace-1', {
                permissions: ['documentStores:add-loader', 'credentials:view']
            })
        ).resolves.toEqual([{ label: 'file', name: 'file' }])
        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-1')
        expect(mockGoogleListFiles).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                workspaceId: 'workspace-1',
                skipVariables: true,
                canViewVariables: false,
                refreshOAuth2Credential: expect.any(Function)
            })
        )
    })

    it('blocks cross-category roles from document stores and custom tools', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('documentStoreVS', { loadMethod: 'listStores' }, 'workspace-1', {
                permissions: ['chatflows:view']
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        await expect(
            nodesService.getSingleNodeAsyncOptions('customTool', { loadMethod: 'listTools' }, 'workspace-1', {
                permissions: ['documentStores:view']
            })
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockListStores).not.toHaveBeenCalled()
        expect(mockListTools).not.toHaveBeenCalled()
    })

    it('overrides request search scope with the active workspace before local metadata reads', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions(
                'documentStoreVS',
                { loadMethod: 'listStores', searchOptions: { workspaceId: 'workspace-b', status: 'SYNC' } },
                'workspace-a',
                { permissions: ['chatflows:update', 'documentStores:view'] }
            )
        ).resolves.toEqual([{ label: 'store', name: 'store' }])

        expect(mockListStores).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ searchOptions: { workspaceId: 'workspace-a', status: 'SYNC' } })
        )
    })

    it('allows safe toolAgentflow metadata while intentionally denying input-argument initialization', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('toolAgentflow', { loadMethod: 'listTools' }, 'workspace-1', {
                permissions: ['agentflows:update']
            })
        ).resolves.toEqual([{ label: 'tool', name: 'tool' }])
        await expect(
            nodesService.getSingleNodeAsyncOptions(
                'toolAgentflow',
                { loadMethod: 'listRuntimeStateKeys', previousNodes: [] },
                'workspace-1',
                { permissions: ['agentflows:update'] }
            )
        ).resolves.toEqual([{ label: 'state', name: 'state' }])

        await expect(
            nodesService.getSingleNodeAsyncOptions(
                'toolAgentflow',
                {
                    loadMethod: 'listToolInputArgs',
                    currentNode: {
                        inputs: {
                            selectedTool: 'customFunction',
                            selectedToolConfig: { javascriptFunction: 'SENTINEL_CODE', FLOWISE_CREDENTIAL_ID: 'credential-1' }
                        }
                    }
                },
                'workspace-1',
                { permissions: ['agentflows:update', 'credentials:view', 'tools:update'] }
            )
        ).rejects.toMatchObject({ statusCode: 400 })
        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expect(mockListToolInputArgs).not.toHaveBeenCalled()
        expect(mockListTools).toHaveBeenCalledTimes(1)
        expect(mockListRuntimeStateKeys).toHaveBeenCalledTimes(1)
    })

    it('fails before executing intentionally denied network or process metadata methods', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('customMCP', { loadMethod: 'listActions' }, 'workspace-1', {
                permissions: ['chatflows:update', 'tools:update']
            })
        ).rejects.toMatchObject({ statusCode: 400 })
        expect(mockUnsafeNetworkList).not.toHaveBeenCalled()
    })

    it('allows assistant listing only with assistant view and credential-use authority', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('openAIAssistant', { loadMethod: 'listAssistants' }, 'workspace-1', {
                permissions: ['chatflows:update', 'assistants:view']
            })
        ).rejects.toMatchObject({ statusCode: 403 })

        await expect(
            nodesService.getSingleNodeAsyncOptions('openAIAssistant', { loadMethod: 'listAssistants' }, 'workspace-1', {
                permissions: ['chatflows:update', 'assistants:view', 'credentials:view']
            })
        ).resolves.toEqual([{ label: 'assistant', name: 'assistant' }])
        expect(mockListAssistants).toHaveBeenCalledTimes(1)
    })

    it('fails closed for an unlisted node and method pair even when the registry declares it', async () => {
        const unlisted = component('unlistedProvider', 'Chat Models', 'listModels', mockGoogleListFiles, true)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            cachePool: {},
            nodesPool: { componentNodes: { unlistedProvider: unlisted } }
        })

        await expect(
            nodesService.getSingleNodeAsyncOptions(
                'unlistedProvider',
                { loadMethod: 'listModels', credential: 'credential-1' },
                'workspace-1',
                { permissions: ['chatflows:update', 'credentials:view'] }
            )
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockGoogleListFiles).not.toHaveBeenCalled()
    })
})
