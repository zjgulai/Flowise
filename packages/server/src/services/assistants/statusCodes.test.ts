import { StatusCodes } from 'http-status-codes'

const mockFindOneBy = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => ({ findOneBy: mockFindOneBy })
        }
    })
}))

import assistantsService from '.'

describe('assistantsService missing-object status contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('preserves NOT_FOUND for a missing assistant', async () => {
        mockFindOneBy.mockResolvedValue(null)

        await expect(assistantsService.getAssistantById('missing-assistant', 'workspace-1')).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
    })

    it('wraps an unexpected repository failure as INTERNAL_SERVER_ERROR', async () => {
        mockFindOneBy.mockRejectedValue(new Error('database unavailable'))

        await expect(assistantsService.getAssistantById('assistant-1', 'workspace-1')).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR
        })
    })
})
