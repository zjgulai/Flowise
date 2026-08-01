import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockRepository = {
    findOne: jest.fn()
}

jest.mock('../../database/entities/Execution', () => ({ Execution: class Execution {} }))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => mockRepository
        }
    })
}))
jest.mock('../../utils', () => ({
    _removeCredentialId: (value: unknown) => value
}))

import executionsService from './index'

describe('executionsService.getPublicExecutionById', () => {
    const executionId = '00000000-0000-4000-8000-000000000001'

    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('preserves NOT_FOUND for a missing or private execution', async () => {
        mockRepository.findOne.mockResolvedValue(null)

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
        expect(mockRepository.findOne).not.toHaveBeenCalled()
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockRepository.findOne.mockRejectedValue(new Error('database unavailable'))

        const error = await executionsService.getPublicExecutionById(executionId).catch((error) => error)

        expect(error).toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: '读取公开执行记录失败'
        })
        expect(error.message).not.toContain('database unavailable')
    })

    it('redacts nested error details from a public execution while preserving non-error data', async () => {
        mockRepository.findOne.mockResolvedValue({
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
