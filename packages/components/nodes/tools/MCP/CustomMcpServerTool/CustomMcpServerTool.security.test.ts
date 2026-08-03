import { decryptCredentialData } from '../../../../src/utils'
import { MCPToolkit } from '../core'

const mockToolkitInstances: Array<Record<string, any>> = []

jest.mock('../../../../src/utils', () => ({
    decryptCredentialData: jest.fn()
}))

jest.mock('../core', () => ({
    MCPToolkit: jest.fn().mockImplementation((serverParams: Record<string, unknown>, transportType: string) => {
        const instance = {
            serverParams,
            transportType,
            tools: [{ name: 'Get User', description: 'Get a user' }],
            initialize: jest.fn().mockResolvedValue(undefined),
            client: { close: jest.fn().mockResolvedValue(undefined) }
        }
        mockToolkitInstances.push(instance)
        return instance
    })
}))

const { nodeClass: CustomMcpServerTool } = require('./CustomMcpServerTool')

const mockedDecryptCredentialData = decryptCredentialData as jest.MockedFunction<typeof decryptCredentialData>
const MockedMCPToolkit = MCPToolkit as jest.MockedClass<typeof MCPToolkit>

function makeCachePool() {
    const entries = new Map<string, any>()
    const locks = new Map<string, Promise<void>>()
    return {
        entries,
        locks,
        getMCPCache: jest.fn(async (key: string) => entries.get(key)),
        addMCPCache: jest.fn(async (key: string, value: any) => {
            entries.set(key, value)
        }),
        removeMCPCache: jest.fn(async (key: string) => {
            const value = entries.get(key)
            entries.delete(key)
            return value
        }),
        withMCPCacheLock: jest.fn(async (key: string, operation: () => Promise<any>) => {
            const previous = locks.get(key) ?? Promise.resolve()
            let release!: () => void
            const gate = new Promise<void>((resolve) => {
                release = resolve
            })
            const tail = previous.catch(() => undefined).then(() => gate)
            locks.set(key, tail)

            await previous.catch(() => undefined)
            try {
                return await operation()
            } finally {
                release()
                if (locks.get(key) === tail) locks.delete(key)
            }
        })
    }
}

async function waitForMockCalls(mock: jest.Mock, expectedCalls: number): Promise<void> {
    for (let attempt = 0; attempt < 25 && mock.mock.calls.length < expectedCalls; attempt += 1) {
        await Promise.resolve()
    }
    expect(mock).toHaveBeenCalledTimes(expectedCalls)
}

function makeHarness() {
    let record: Record<string, any> = {
        id: 'server-a',
        workspaceId: 'workspace-a',
        name: 'Support MCP',
        serverUrl: 'https://old.example.com/mcp',
        authType: 'CUSTOM_HEADERS',
        authConfig: 'ciphertext-old',
        status: 'AUTHORIZED',
        updatedDate: new Date('2026-08-01T00:00:00.000Z')
    }
    const repository = {
        findOneBy: jest.fn(async ({ id, workspaceId }: { id: string; workspaceId: string }) =>
            record.id === id && record.workspaceId === workspaceId ? record : null
        )
    }
    const cachePool = makeCachePool()
    const options = {
        workspaceId: 'workspace-a',
        appDataSource: { getRepository: jest.fn(() => repository) },
        databaseEntities: { CustomMcpServer: 'CustomMcpServerEntity' },
        cachePool
    }
    return {
        cachePool,
        options,
        repository,
        setRecord: (next: Record<string, any>) => {
            record = next
        },
        getRecord: () => record
    }
}

describe('Custom MCP server toolkit cache security', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockToolkitInstances.length = 0
        mockedDecryptCredentialData.mockImplementation(async (ciphertext: string) => ({
            headers: { Authorization: `Bearer ${ciphertext}` }
        }))
    })

    it('binds the cache to workspace, server and the current persisted security configuration', async () => {
        const harness = makeHarness()
        const node = new CustomMcpServerTool()
        const nodeData = { inputs: { mcpServerId: 'server-a' } }

        await expect(node.getTools(nodeData, harness.options)).resolves.toEqual([expect.objectContaining({ name: 'Get_User' })])
        expect(harness.cachePool.addMCPCache).toHaveBeenCalledWith(
            'customMcpServer:workspace-a:server-a',
            expect.objectContaining({ configFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
        )
        const firstFingerprint = harness.cachePool.addMCPCache.mock.calls[0][1].configFingerprint
        expect(firstFingerprint).not.toContain('ciphertext-old')
        expect(firstFingerprint).not.toContain('old.example.com')

        const firstToolkit = mockToolkitInstances[0]
        await expect(firstToolkit.getToolCallHeaders()).resolves.toEqual({ Authorization: 'Bearer ciphertext-old' })
        harness.setRecord({
            ...harness.getRecord(),
            serverUrl: 'https://new.example.com/mcp',
            authConfig: 'ciphertext-new',
            updatedDate: new Date('2026-08-02T00:00:00.000Z')
        })
        await expect(firstToolkit.getToolCallHeaders()).rejects.toThrow('MCP server cache refresh failed')

        await expect(node.getTools(nodeData, harness.options)).resolves.toEqual([expect.objectContaining({ name: 'Get_User' })])

        expect(firstToolkit.client.close).toHaveBeenCalledTimes(1)
        expect(harness.cachePool.removeMCPCache).toHaveBeenCalledWith('customMcpServer:workspace-a:server-a')
        expect(MockedMCPToolkit).toHaveBeenLastCalledWith(
            {
                url: 'https://new.example.com/mcp',
                headers: { Authorization: 'Bearer ciphertext-new' }
            },
            'sse'
        )
        const secondFingerprint = harness.cachePool.addMCPCache.mock.calls[1][1].configFingerprint
        expect(secondFingerprint).toMatch(/^[a-f0-9]{64}$/)
        expect(secondFingerprint).not.toBe(firstFingerprint)

        await expect(node.getTools(nodeData, harness.options)).resolves.toEqual([expect.objectContaining({ name: 'Get_User' })])
        expect(MockedMCPToolkit).toHaveBeenCalledTimes(2)
    })

    it('evicts stale cache before a bounded close and lets a queued refresh finish when close never settles', async () => {
        jest.useFakeTimers()
        try {
            const harness = makeHarness()
            const node = new CustomMcpServerTool()
            const nodeData = { inputs: { mcpServerId: 'server-a' } }

            await node.getTools(nodeData, harness.options)
            const staleToolkit = mockToolkitInstances[0]
            staleToolkit.client.close.mockImplementation(() => new Promise<void>(() => undefined))
            harness.setRecord({
                ...harness.getRecord(),
                serverUrl: 'https://new.example.com/mcp',
                authConfig: 'ciphertext-new',
                updatedDate: new Date('2026-08-02T00:00:00.000Z')
            })

            const refreshRequest = node.getTools(nodeData, harness.options)
            await waitForMockCalls(staleToolkit.client.close, 1)
            expect(harness.cachePool.entries.has('customMcpServer:workspace-a:server-a')).toBe(false)

            const queuedRequest = node.getTools(nodeData, harness.options)
            await Promise.resolve()
            expect(MockedMCPToolkit).toHaveBeenCalledTimes(1)

            await jest.advanceTimersByTimeAsync(1_000)
            await expect(Promise.all([refreshRequest, queuedRequest])).resolves.toEqual([
                [expect.objectContaining({ name: 'Get_User' })],
                [expect.objectContaining({ name: 'Get_User' })]
            ])
            expect(MockedMCPToolkit).toHaveBeenCalledTimes(2)
            expect(harness.cachePool.entries.get('customMcpServer:workspace-a:server-a').toolkit).toBe(mockToolkitInstances[1])
            expect(harness.cachePool.locks.size).toBe(0)
        } finally {
            jest.useRealTimers()
        }
    })

    it('does not share a server id cache entry across workspaces', async () => {
        const harness = makeHarness()
        const node = new CustomMcpServerTool()
        const nodeData = { inputs: { mcpServerId: 'server-a' } }

        await node.getTools(nodeData, harness.options)
        harness.setRecord({
            ...harness.getRecord(),
            workspaceId: 'workspace-b',
            serverUrl: 'https://workspace-b.example.com/mcp',
            updatedDate: new Date('2026-08-02T00:00:00.000Z')
        })

        await node.getTools(nodeData, { ...harness.options, workspaceId: 'workspace-b' })

        expect(harness.cachePool.addMCPCache.mock.calls.map(([key]) => key)).toEqual([
            'customMcpServer:workspace-a:server-a',
            'customMcpServer:workspace-b:server-a'
        ])
        expect(MockedMCPToolkit).toHaveBeenCalledTimes(2)
    })

    it('re-reads persistent config inside the scoped lock so an older waiter cannot restore stale credentials', async () => {
        const harness = makeHarness()
        const node = new CustomMcpServerTool()
        const nodeData = { inputs: { mcpServerId: 'server-a' } }
        let releaseOlder!: () => void
        let markOlderWaiting!: () => void
        const olderWaiting = new Promise<void>((resolve) => {
            markOlderWaiting = resolve
        })
        const olderGate = new Promise<void>((resolve) => {
            releaseOlder = resolve
        })
        let lockCalls = 0
        harness.cachePool.withMCPCacheLock.mockImplementation(async (_key: string, operation: () => Promise<any>) => {
            lockCalls += 1
            if (lockCalls === 1) {
                markOlderWaiting()
                await olderGate
            }
            return operation()
        })

        const olderRequest = node.getTools(nodeData, harness.options)
        await olderWaiting
        harness.setRecord({
            ...harness.getRecord(),
            serverUrl: 'https://new.example.com/mcp',
            authConfig: 'ciphertext-new',
            updatedDate: new Date('2026-08-02T00:00:00.000Z')
        })

        await node.getTools(nodeData, harness.options)
        releaseOlder()
        await olderRequest

        expect(MockedMCPToolkit).toHaveBeenCalledTimes(1)
        expect(mockToolkitInstances[0].serverParams).toEqual({
            url: 'https://new.example.com/mcp',
            headers: { Authorization: 'Bearer ciphertext-new' }
        })
        expect(harness.cachePool.entries.get('customMcpServer:workspace-a:server-a').toolkit).toBe(mockToolkitInstances[0])
    })

    it('bounds temporary toolkit cleanup after persistent config drift and releases the lock for a fresh initialization', async () => {
        jest.useFakeTimers()
        try {
            const harness = makeHarness()
            const oldRecord = { ...harness.getRecord() }
            const newRecord = {
                ...oldRecord,
                serverUrl: 'https://new.example.com/mcp',
                authConfig: 'ciphertext-new',
                updatedDate: new Date('2026-08-02T00:00:00.000Z')
            }
            harness.setRecord(newRecord)
            harness.repository.findOneBy.mockResolvedValueOnce(oldRecord).mockResolvedValueOnce(newRecord)
            const driftingToolkit = {
                serverParams: undefined as any,
                transportType: undefined as any,
                tools: [{ name: 'Get User', description: 'Get a user' }],
                initialize: jest.fn().mockResolvedValue(undefined),
                client: { close: jest.fn(() => new Promise<void>(() => undefined)) }
            }
            MockedMCPToolkit.mockImplementationOnce((serverParams: any, transportType: any) => {
                driftingToolkit.serverParams = serverParams
                driftingToolkit.transportType = transportType
                mockToolkitInstances.push(driftingToolkit)
                return driftingToolkit as any
            })
            const node = new CustomMcpServerTool()
            const nodeData = { inputs: { mcpServerId: 'server-a' } }

            const driftRequest = node.getTools(nodeData, harness.options).catch((error: Error) => error)
            await waitForMockCalls(driftingToolkit.client.close, 1)
            const queuedRequest = node.getTools(nodeData, harness.options)
            await jest.advanceTimersByTimeAsync(1_000)

            await expect(driftRequest).resolves.toEqual(expect.objectContaining({ message: 'MCP server cache refresh failed' }))
            await expect(queuedRequest).resolves.toEqual([expect.objectContaining({ name: 'Get_User' })])
            expect(MockedMCPToolkit).toHaveBeenCalledTimes(2)
            expect(harness.cachePool.entries.get('customMcpServer:workspace-a:server-a').toolkit).toBe(mockToolkitInstances[1])
            expect(harness.cachePool.locks.size).toBe(0)
        } finally {
            jest.useRealTimers()
        }
    })

    it('bounds cleanup after toolkit initialization fails and does not expose the SDK error or strand the lock', async () => {
        jest.useFakeTimers()
        try {
            const harness = makeHarness()
            const failedToolkit = {
                tools: [],
                initialize: jest.fn().mockRejectedValue(new Error('sensitive SDK initialization detail')),
                client: { close: jest.fn(() => new Promise<void>(() => undefined)) }
            }
            MockedMCPToolkit.mockImplementationOnce(() => {
                mockToolkitInstances.push(failedToolkit)
                return failedToolkit as any
            })
            const node = new CustomMcpServerTool()
            const nodeData = { inputs: { mcpServerId: 'server-a' } }

            const failedRequest = node.getTools(nodeData, harness.options).catch((error: Error) => error)
            await waitForMockCalls(failedToolkit.client.close, 1)
            const queuedRequest = node.getTools(nodeData, harness.options)
            await jest.advanceTimersByTimeAsync(1_000)

            await expect(failedRequest).resolves.toEqual(expect.objectContaining({ message: 'MCP server cache refresh failed' }))
            await expect(queuedRequest).resolves.toEqual([expect.objectContaining({ name: 'Get_User' })])
            expect(MockedMCPToolkit).toHaveBeenCalledTimes(2)
            expect(harness.cachePool.entries.get('customMcpServer:workspace-a:server-a').toolkit).toBe(mockToolkitInstances[1])
            expect(harness.cachePool.locks.size).toBe(0)
        } finally {
            jest.useRealTimers()
        }
    })
})
