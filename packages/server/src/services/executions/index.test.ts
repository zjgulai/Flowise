import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { In } from 'typeorm'

const mockQueryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn()
}

const mockExecutionRepository = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(() => mockQueryBuilder)
}

const mockChatMessageRepository = {
    update: jest.fn()
}

const getMockRepository = (entity: { name?: string }) =>
    entity?.name === 'ChatMessage' ? mockChatMessageRepository : mockExecutionRepository

const mockTransactionManager = {
    getRepository: jest.fn(getMockRepository)
}

const mockDataSource = {
    getRepository: jest.fn(getMockRepository),
    transaction: jest.fn(async (callback: (manager: typeof mockTransactionManager) => unknown) => callback(mockTransactionManager))
}

jest.mock('../../database/entities/Execution', () => ({ Execution: class Execution {} }))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: mockDataSource
    })
}))
jest.mock('../../utils', () => ({
    _removeCredentialId: (value: unknown) => value
}))

import executionsService from './index'

describe('executionsService.getExecutionById tenant boundary', () => {
    const executionId = '00000000-0000-4000-8000-000000000001'

    beforeEach(() => {
        jest.clearAllMocks()
        mockExecutionRepository.findOne.mockResolvedValue(null)
    })

    it.each([undefined, '', '   '])('rejects missing workspace context before querying the repository (%p)', async (workspaceId) => {
        await expect(executionsService.getExecutionById(executionId, workspaceId)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })
        expect(mockExecutionRepository.findOne).not.toHaveBeenCalled()
    })

    it('queries by execution id and the trimmed active workspace', async () => {
        const ownedExecution = { id: executionId, workspaceId: 'workspace-a' }
        mockExecutionRepository.findOne.mockResolvedValue(ownedExecution)

        await expect(executionsService.getExecutionById(executionId, ' workspace-a ')).resolves.toBe(ownedExecution)
        expect(mockExecutionRepository.findOne).toHaveBeenCalledWith({
            where: { id: executionId, workspaceId: 'workspace-a' }
        })
    })

    it('preserves NOT_FOUND for an execution outside the active workspace', async () => {
        mockExecutionRepository.findOne.mockResolvedValue(null)

        await expect(executionsService.getExecutionById(executionId, 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND,
            message: `Execution ${executionId} not found`
        })
        expect(mockExecutionRepository.findOne).toHaveBeenCalledWith({
            where: { id: executionId, workspaceId: 'workspace-a' }
        })
    })
})

describe('executionsService.getPublicExecutionById', () => {
    const executionId = '00000000-0000-4000-8000-000000000001'

    beforeEach(() => {
        jest.clearAllMocks()
        mockExecutionRepository.findOne.mockResolvedValue(null)
    })

    it('preserves NOT_FOUND for a missing or private execution', async () => {
        mockExecutionRepository.findOne.mockResolvedValue(null)

        await expect(executionsService.getPublicExecutionById(executionId)).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND,
            message: '公开执行记录不存在'
        })
    })

    it.each([undefined, '', 'not-a-uuid'])('rejects an invalid public execution id before querying the repository', async (invalidId) => {
        await expect(executionsService.getPublicExecutionById(invalidId as unknown as string)).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND,
            message: '公开执行记录不存在'
        })
        expect(mockExecutionRepository.findOne).not.toHaveBeenCalled()
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockExecutionRepository.findOne.mockRejectedValue(new Error('database unavailable'))

        const error = await executionsService.getPublicExecutionById(executionId).catch((error) => error)

        expect(error).toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: '读取公开执行记录失败'
        })
        expect(error.message).not.toContain('database unavailable')
    })

    it('redacts nested error details from a public execution while preserving non-error data', async () => {
        mockExecutionRepository.findOne.mockResolvedValue({
            id: 'execution-1',
            isPublic: true,
            executionData: JSON.stringify([
                {
                    nodeId: 'node-1',
                    data: { output: 'safe output', error: { message: 'provider secret', requestId: 'internal-id' } },
                    error: 'database connection string'
                }
            ])
        })

        const execution = await executionsService.getPublicExecutionById(executionId)
        const executionData = JSON.parse(execution?.executionData || '[]')

        expect(executionData[0].nodeId).toBe('node-1')
        expect(executionData[0].data.output).toBe('safe output')
        expect(executionData[0].error).toBe('执行失败，详细信息仅对管理员可见')
        expect(executionData[0].data.error).toBe('执行失败，详细信息仅对管理员可见')
        expect(JSON.stringify(executionData)).not.toContain('provider secret')
        expect(JSON.stringify(executionData)).not.toContain('internal-id')
        expect(JSON.stringify(executionData)).not.toContain('database connection string')
    })

    it('does not accidentally treat a generic error as an InternalFlowiseError', () => {
        expect(new Error('ordinary')).not.toBeInstanceOf(InternalFlowiseError)
    })
})

describe('executionsService.getAllExecutions tenant-safe parent join', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockQueryBuilder.getManyAndCount.mockResolvedValue([
            [
                {
                    id: 'execution-a',
                    agentflow: {
                        id: 'flow-a',
                        name: 'Safe flow name',
                        type: 'AGENTFLOW',
                        flowData: 'private flow data',
                        mcpServerConfig: '{"token":"private-mcp-value"}',
                        webhookSecret: 'private-webhook-value',
                        webhookSecretConfigured: true,
                        chatbotConfig: 'private chatbot config'
                    }
                }
            ],
            1
        ])
    })

    it.each([undefined, '', '   '])('rejects missing workspace context before creating a query builder (%p)', async (workspaceId) => {
        await expect(executionsService.getAllExecutions({ workspaceId })).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })
        expect(mockExecutionRepository.createQueryBuilder).not.toHaveBeenCalled()
        expect(mockQueryBuilder.getManyAndCount).not.toHaveBeenCalled()
    })

    it('joins an agentflow only when its workspace matches the execution workspace', async () => {
        const result = await executionsService.getAllExecutions({ workspaceId: ' workspace-a ' })

        expect(mockExecutionRepository.createQueryBuilder).toHaveBeenCalledWith('execution')
        expect(mockQueryBuilder.leftJoin).toHaveBeenCalledWith(
            'execution.agentflow',
            'agentflow',
            'agentflow.workspaceId = execution.workspaceId'
        )
        expect(mockQueryBuilder.leftJoinAndSelect).not.toHaveBeenCalled()
        expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith(['agentflow.id', 'agentflow.name', 'agentflow.type'])
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('execution.workspaceId = :workspaceId', {
            workspaceId: 'workspace-a'
        })
        expect(result).toEqual({
            data: [
                {
                    id: 'execution-a',
                    agentflow: { id: 'flow-a', name: 'Safe flow name', type: 'AGENTFLOW' }
                }
            ],
            total: 1
        })
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain('private flow data')
        expect(serialized).not.toContain('private-mcp-value')
        expect(serialized).not.toContain('private-webhook-value')
        expect(serialized).not.toContain('private chatbot config')
    })
})

describe('executionsService.getExecutionsByIdsForExport', () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)

    beforeEach(() => {
        jest.clearAllMocks()
        mockExecutionRepository.find.mockResolvedValue([])
    })

    it('queries only referenced executions in bounded workspace-scoped batches', async () => {
        await expect(executionsService.getExecutionsByIdsForExport(ids, ' workspace-a ')).resolves.toEqual([])

        expect(mockExecutionRepository.find).toHaveBeenCalledTimes(3)
        for (const [index, batch] of [ids.slice(0, 400), ids.slice(400, 800), ids.slice(800)].entries()) {
            expect(mockExecutionRepository.find.mock.calls[index][0]).toEqual({
                where: { id: In(batch), workspaceId: 'workspace-a' },
                order: { id: 'ASC' },
                take: 10_001
            })
        }
    })

    it('rejects a malformed referenced execution before querying', async () => {
        await expect(executionsService.getExecutionsByIdsForExport(['not-a-uuid'], 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.UNPROCESSABLE_ENTITY
        })
        expect(mockExecutionRepository.find).not.toHaveBeenCalled()
    })
})

describe('executionsService.updateExecution field and tenant boundary', () => {
    const executionId = '00000000-0000-4000-8000-000000000030'

    beforeEach(() => {
        jest.clearAllMocks()
        mockExecutionRepository.findOneBy.mockResolvedValue(null)
        mockExecutionRepository.update.mockResolvedValue({ affected: 0 })
    })

    it('allows only an exact boolean isPublic update on an owned execution', async () => {
        const executionAfterConcurrentChange = {
            id: executionId,
            workspaceId: 'workspace-a',
            agentflowId: 'flow-written-concurrently',
            executionData: 'data written concurrently',
            state: 'STOPPED',
            isPublic: true
        }
        mockExecutionRepository.update.mockResolvedValue({ affected: 1 })
        mockExecutionRepository.findOneBy.mockResolvedValue(executionAfterConcurrentChange)

        const result = await executionsService.updateExecution(executionId, { isPublic: true }, ' workspace-a ')

        expect(mockExecutionRepository.update).toHaveBeenCalledWith({ id: executionId, workspaceId: 'workspace-a' }, { isPublic: true })
        expect(mockExecutionRepository.findOneBy).toHaveBeenCalledWith({ id: executionId, workspaceId: 'workspace-a' })
        expect(mockExecutionRepository.save).not.toHaveBeenCalled()
        expect(result).toBe(executionAfterConcurrentChange)
        expect(result?.isPublic).toBe(true)
    })

    it.each([
        { isPublic: true, id: 'attacker-id' },
        { isPublic: true, workspaceId: 'workspace-b' },
        { isPublic: true, agentflowId: 'foreign-flow' },
        { isPublic: true, executionData: 'attacker data' },
        { isPublic: true, state: 'FINISHED' },
        { isPublic: 'true' },
        {}
    ])('rejects mass-assignment input before reading or mutating an execution (%p)', async (payload) => {
        await expect(executionsService.updateExecution(executionId, payload as any, 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Invalid execution update request'
        })
        expect(mockExecutionRepository.update).not.toHaveBeenCalled()
        expect(mockExecutionRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockExecutionRepository.save).not.toHaveBeenCalled()
    })

    it.each([undefined, '', '   '])('fails closed without a workspace before repository access (%p)', async (workspaceId) => {
        await expect(executionsService.updateExecution(executionId, { isPublic: true }, workspaceId)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })
        expect(mockExecutionRepository.update).not.toHaveBeenCalled()
        expect(mockExecutionRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockExecutionRepository.save).not.toHaveBeenCalled()
    })

    it('does not save when the execution is outside the active workspace', async () => {
        mockExecutionRepository.update.mockResolvedValue({ affected: 0 })

        await expect(executionsService.updateExecution(executionId, { isPublic: true }, 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
        expect(mockExecutionRepository.update).toHaveBeenCalledWith({ id: executionId, workspaceId: 'workspace-a' }, { isPublic: true })
        expect(mockExecutionRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockExecutionRepository.save).not.toHaveBeenCalled()
    })

    it('returns CONFLICT when the updated execution disappears before the scoped reread', async () => {
        mockExecutionRepository.update.mockResolvedValue({ affected: 1 })
        mockExecutionRepository.findOneBy.mockResolvedValue(null)

        await expect(executionsService.updateExecution(executionId, { isPublic: false }, 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Execution update changed concurrently'
        })
        expect(mockExecutionRepository.save).not.toHaveBeenCalled()
    })
})

describe('executionsService.deleteExecutions tenant boundary', () => {
    const ownedExecutionId = '00000000-0000-4000-8000-000000000010'
    const foreignExecutionId = '00000000-0000-4000-8000-000000000020'

    beforeEach(() => {
        jest.clearAllMocks()
        mockExecutionRepository.find.mockResolvedValue([])
        mockExecutionRepository.delete.mockResolvedValue({ affected: 0 })
        mockChatMessageRepository.update.mockResolvedValue({ affected: 0 })
    })

    it.each([undefined, '', '   '])('fails closed without a workspace before opening a transaction (%p)', async (workspaceId) => {
        await expect(executionsService.deleteExecutions([ownedExecutionId], workspaceId)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Workspace ID is required'
        })
        expect(mockDataSource.transaction).not.toHaveBeenCalled()
        expect(mockExecutionRepository.delete).not.toHaveBeenCalled()
        expect(mockChatMessageRepository.update).not.toHaveBeenCalled()
    })

    it('does not delete or clear messages when every requested execution belongs to another workspace', async () => {
        mockExecutionRepository.find.mockResolvedValue([])

        const result = await executionsService.deleteExecutions([foreignExecutionId], 'workspace-a')

        expect(mockDataSource.transaction).toHaveBeenCalledTimes(1)
        expect(mockExecutionRepository.find).toHaveBeenCalledWith({
            where: {
                id: { type: 'in', value: [foreignExecutionId] },
                workspaceId: 'workspace-a'
            },
            select: ['id']
        })
        expect(mockExecutionRepository.delete).not.toHaveBeenCalled()
        expect(mockChatMessageRepository.update).not.toHaveBeenCalled()
        expect(result).toEqual({ success: true, deletedCount: 0 })
    })

    it('deletes and clears message pointers for only the resolved owned execution ids in one transaction', async () => {
        mockExecutionRepository.find.mockResolvedValue([{ id: ownedExecutionId }])
        mockExecutionRepository.delete.mockResolvedValue({ affected: 1 })
        mockChatMessageRepository.update.mockResolvedValue({ affected: 2 })

        const result = await executionsService.deleteExecutions([ownedExecutionId, foreignExecutionId, ownedExecutionId], ' workspace-a ')

        expect(mockExecutionRepository.find).toHaveBeenCalledWith({
            where: {
                id: { type: 'in', value: [ownedExecutionId, foreignExecutionId] },
                workspaceId: 'workspace-a'
            },
            select: ['id']
        })
        expect(mockExecutionRepository.delete).toHaveBeenCalledWith({
            id: { type: 'in', value: [ownedExecutionId] },
            workspaceId: 'workspace-a'
        })
        expect(mockChatMessageRepository.update).toHaveBeenCalledWith(
            { executionId: { type: 'in', value: [ownedExecutionId] } },
            { executionId: null }
        )
        expect(mockExecutionRepository.delete.mock.invocationCallOrder[0]).toBeLessThan(
            mockChatMessageRepository.update.mock.invocationCallOrder[0]
        )
        expect(result).toEqual({ success: true, deletedCount: 1 })
    })

    it('reuses a caller transaction manager instead of opening a nested transaction', async () => {
        mockExecutionRepository.find.mockResolvedValue([{ id: ownedExecutionId }])
        mockExecutionRepository.delete.mockResolvedValue({ affected: 1 })

        const result = await executionsService.deleteExecutions([ownedExecutionId], 'workspace-a', mockTransactionManager as any)

        expect(mockDataSource.transaction).not.toHaveBeenCalled()
        expect(mockTransactionManager.getRepository).toHaveBeenCalled()
        expect(mockExecutionRepository.delete).toHaveBeenCalledWith({
            id: { type: 'in', value: [ownedExecutionId] },
            workspaceId: 'workspace-a'
        })
        expect(mockChatMessageRepository.update).toHaveBeenCalledWith(
            { executionId: { type: 'in', value: [ownedExecutionId] } },
            { executionId: null }
        )
        expect(result).toEqual({ success: true, deletedCount: 1 })
    })

    it('rolls back before clearing child pointers when the scoped delete loses a race', async () => {
        mockExecutionRepository.find.mockResolvedValue([{ id: ownedExecutionId }])
        mockExecutionRepository.delete.mockResolvedValue({ affected: 0 })

        await expect(executionsService.deleteExecutions([ownedExecutionId], 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Execution deletion changed concurrently'
        })
        expect(mockChatMessageRepository.update).not.toHaveBeenCalled()
    })

    it.each(['not-a-uuid', ''])('rejects malformed execution ids before opening a transaction (%p)', async (id) => {
        await expect(executionsService.deleteExecutions([id], 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Invalid execution deletion request'
        })
        expect(mockDataSource.transaction).not.toHaveBeenCalled()
    })

    it('rejects oversized batches before constructing a database IN predicate', async () => {
        await expect(executionsService.deleteExecutions(Array(501).fill(ownedExecutionId), 'workspace-a')).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST,
            message: 'Invalid execution deletion request'
        })
        expect(mockDataSource.transaction).not.toHaveBeenCalled()
        expect(mockExecutionRepository.find).not.toHaveBeenCalled()
    })

    it('returns without a transaction for an empty request', async () => {
        await expect(executionsService.deleteExecutions([], 'workspace-a')).resolves.toEqual({ success: true, deletedCount: 0 })
        expect(mockDataSource.transaction).not.toHaveBeenCalled()
    })
})
