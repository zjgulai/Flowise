export {}

const mockConvertSchemaToZod = jest.fn(() => ({}))
const mockGetVars = jest.fn(async () => ({ safeVariable: 'value' }))
const mockDynamicStructuredToolConstructor = jest.fn()
const mockSetVariables = jest.fn()
const mockSetFlowObject = jest.fn()
const mockParseZodSchema = jest.fn(() => ({}))

jest.mock('../../../src/utils', () => ({
    convertSchemaToZod: mockConvertSchemaToZod,
    getBaseClasses: () => [],
    getVars: mockGetVars
}))

jest.mock('./core', () => ({
    DynamicStructuredTool: class DynamicStructuredTool {
        returnDirect = false

        constructor(config: unknown) {
            mockDynamicStructuredToolConstructor(config)
        }

        setVariables(value: unknown) {
            mockSetVariables(value)
        }

        setFlowObject(value: unknown) {
            mockSetFlowObject(value)
        }
    }
}))

jest.mock('../../../src/secureZodParser', () => ({
    SecureZodSchemaParser: { parseZodSchema: mockParseZodSchema }
}))

const { nodeClass: CustomTool } = require('./CustomTool')

const makeHarness = (tool: Record<string, unknown> | null = null) => {
    const repository = {
        findOneBy: jest.fn(async ({ id, workspaceId }: { id: string; workspaceId: string }) =>
            tool?.id === id && tool?.workspaceId === workspaceId ? tool : null
        )
    }
    const appDataSource = {
        getRepository: jest.fn(() => repository)
    }
    return {
        repository,
        appDataSource,
        options: {
            workspaceId: 'workspace-a',
            chatflowid: 'flow-a',
            appDataSource,
            databaseEntities: { Tool: 'ToolEntity' }
        }
    }
}

const unsafeOverrides = {
    customToolFunc: 'return process.env.SECRET',
    customToolSchema: 'z.object({ leaked: z.string() })'
}

describe('Custom Tool runtime tenant boundary', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([undefined, '', '   '])('rejects missing workspace context before repository or code access (%p)', async (workspaceId) => {
        const harness = makeHarness()
        const node = new CustomTool()

        await expect(
            node.init({ inputs: { selectedTool: 'victim-tool', ...unsafeOverrides } }, '', { ...harness.options, workspaceId })
        ).rejects.toThrow('Custom tool workspace context is required')

        expect(harness.appDataSource.getRepository).not.toHaveBeenCalled()
        expect(mockConvertSchemaToZod).not.toHaveBeenCalled()
        expect(mockParseZodSchema).not.toHaveBeenCalled()
        expect(mockDynamicStructuredToolConstructor).not.toHaveBeenCalled()
        expect(mockGetVars).not.toHaveBeenCalled()
    })

    it('rejects a foreign or missing tool before schema and code initialization without exposing its id', async () => {
        const harness = makeHarness({
            id: 'victim-tool',
            workspaceId: 'workspace-b',
            name: 'Victim private tool',
            description: 'private description',
            schema: '[]',
            func: 'return "private"'
        })
        const node = new CustomTool()

        const error = await node
            .init({ inputs: { selectedTool: ' victim-tool ', ...unsafeOverrides } }, '', harness.options)
            .catch((error: Error) => error)

        expect(error.message).toBe('Custom tool is unavailable')
        expect(error.message).not.toContain('victim-tool')
        expect(error.message).not.toContain('workspace-b')
        expect(harness.repository.findOneBy).toHaveBeenCalledWith({ id: 'victim-tool', workspaceId: 'workspace-a' })
        expect(mockConvertSchemaToZod).not.toHaveBeenCalled()
        expect(mockParseZodSchema).not.toHaveBeenCalled()
        expect(mockDynamicStructuredToolConstructor).not.toHaveBeenCalled()
        expect(mockGetVars).not.toHaveBeenCalled()
    })

    it('redacts repository failures and performs no schema or code initialization', async () => {
        const harness = makeHarness()
        harness.repository.findOneBy.mockRejectedValueOnce(new Error('database host and tenant details'))
        const node = new CustomTool()

        const error = await node
            .init({ inputs: { selectedTool: 'victim-tool', ...unsafeOverrides } }, '', harness.options)
            .catch((error: Error) => error)

        expect(error.message).toBe('Custom tool is unavailable')
        expect(error.message).not.toContain('database host')
        expect(mockConvertSchemaToZod).not.toHaveBeenCalled()
        expect(mockParseZodSchema).not.toHaveBeenCalled()
        expect(mockDynamicStructuredToolConstructor).not.toHaveBeenCalled()
        expect(mockGetVars).not.toHaveBeenCalled()
    })

    it('initializes a tool only after an exact same-workspace lookup succeeds', async () => {
        const harness = makeHarness({
            id: 'owned-tool',
            workspaceId: 'workspace-a',
            name: 'Owned tool',
            description: 'Owned description',
            schema: '[]',
            func: 'return "owned"'
        })
        const node = new CustomTool()

        const result = await node.init({ inputs: { selectedTool: ' owned-tool ', returnDirect: true } }, '', harness.options)

        expect(harness.repository.findOneBy).toHaveBeenCalledWith({ id: 'owned-tool', workspaceId: 'workspace-a' })
        expect(mockConvertSchemaToZod).toHaveBeenCalledWith('[]')
        expect(mockDynamicStructuredToolConstructor).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Owned tool', description: 'Owned description', code: 'return "owned"' })
        )
        expect(mockGetVars).toHaveBeenCalled()
        expect(mockSetVariables).toHaveBeenCalledWith({ safeVariable: 'value' })
        expect(mockSetFlowObject).toHaveBeenCalledWith({ chatflowId: 'flow-a' })
        expect(result.returnDirect).toBe(true)
    })
})
