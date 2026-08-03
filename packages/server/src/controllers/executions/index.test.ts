import { StatusCodes } from 'http-status-codes'

const mockExecutionsService = {
    getExecutionById: jest.fn(),
    getPublicExecutionById: jest.fn(),
    updateExecution: jest.fn(),
    getAllExecutions: jest.fn(),
    deleteExecutions: jest.fn()
}

jest.mock('../../services/executions', () => ({
    __esModule: true,
    default: mockExecutionsService
}))

import executionsController from './index'

const createResponse = () => {
    const response = {
        status: jest.fn(),
        json: jest.fn()
    }
    response.status.mockReturnValue(response)
    response.json.mockReturnValue(response)
    return response
}

describe('executionsController active workspace boundary', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([
        ['getExecutionById', { params: { id: 'execution-a' }, user: {} }, 'getExecutionById'],
        ['getAllExecutions', { params: {}, query: {}, user: {} }, 'getAllExecutions']
    ])('rejects %s before invoking the protected service when activeWorkspaceId is missing', async (method, request, serviceMethod) => {
        const response = createResponse()
        const next = jest.fn()

        await (executionsController[method as keyof typeof executionsController] as any)(request, response, next)

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Workspace ID is required' })
        )
        expect(mockExecutionsService[serviceMethod as keyof typeof mockExecutionsService]).not.toHaveBeenCalled()
        expect(response.json).not.toHaveBeenCalled()
    })

    it('passes the trimmed active workspace to the private execution detail service', async () => {
        const execution = { id: 'execution-a', workspaceId: 'workspace-a' }
        mockExecutionsService.getExecutionById.mockResolvedValue(execution)
        const response = createResponse()
        const next = jest.fn()

        await executionsController.getExecutionById(
            { params: { id: 'execution-a' }, user: { activeWorkspaceId: ' workspace-a ' } } as any,
            response as any,
            next
        )

        expect(mockExecutionsService.getExecutionById).toHaveBeenCalledWith('execution-a', 'workspace-a')
        expect(response.json).toHaveBeenCalledWith(execution)
        expect(next).not.toHaveBeenCalled()
    })

    it('passes the trimmed active workspace to the private execution list service', async () => {
        const result = { data: [], total: 0 }
        mockExecutionsService.getAllExecutions.mockResolvedValue(result)
        const response = createResponse()
        const next = jest.fn()

        await executionsController.getAllExecutions(
            { params: {}, query: {}, user: { activeWorkspaceId: ' workspace-a ' } } as any,
            response as any,
            next
        )

        expect(mockExecutionsService.getAllExecutions).toHaveBeenCalledWith({ workspaceId: 'workspace-a' })
        expect(response.json).toHaveBeenCalledWith(result)
        expect(next).not.toHaveBeenCalled()
    })

    it('keeps the public execution endpoint independent of workspace context', async () => {
        const execution = { id: 'public-execution', isPublic: true }
        mockExecutionsService.getPublicExecutionById.mockResolvedValue(execution)
        const response = createResponse()
        const next = jest.fn()

        await executionsController.getPublicExecutionById({ params: { id: 'public-execution' }, user: {} } as any, response as any, next)

        expect(mockExecutionsService.getPublicExecutionById).toHaveBeenCalledWith('public-execution')
        expect(response.json).toHaveBeenCalledWith(execution)
        expect(next).not.toHaveBeenCalled()
    })
})
