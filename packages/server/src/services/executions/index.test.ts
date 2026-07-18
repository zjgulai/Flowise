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
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('preserves NOT_FOUND for a missing or private execution', async () => {
        mockRepository.findOne.mockResolvedValue(null)

        await expect(executionsService.getPublicExecutionById('missing')).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockRepository.findOne.mockRejectedValue(new Error('database unavailable'))

        await expect(executionsService.getPublicExecutionById('execution-1')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR
        })
    })

    it('does not accidentally treat a generic error as an InternalFlowiseError', () => {
        expect(new Error('ordinary')).not.toBeInstanceOf(InternalFlowiseError)
    })
})
