import { StatusCodes } from 'http-status-codes'

const mockGetRunningExpressApp = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

import nodesService from '.'

describe('nodesService missing-object status contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({ nodesPool: { componentNodes: {} } })
    })

    it.each([
        ['node metadata', () => nodesService.getNodeByName('missing-node')],
        ['node icon', () => nodesService.getSingleNodeIcon('missing-node')]
    ])('preserves NOT_FOUND for missing %s', async (_label, request) => {
        await expect(request()).rejects.toMatchObject({ statusCode: StatusCodes.NOT_FOUND })
    })

    it('wraps an unexpected runtime failure as INTERNAL_SERVER_ERROR', async () => {
        mockGetRunningExpressApp.mockImplementation(() => {
            throw new Error('component pool unavailable')
        })

        await expect(nodesService.getNodeByName('node')).rejects.toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR })
    })
})
