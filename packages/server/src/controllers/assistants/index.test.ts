import { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockGenerateAssistantInstruction = jest.fn()
const mockCreateAssistant = jest.fn()
const mockDeleteAssistant = jest.fn()
const mockDeleteCustomAssistant = jest.fn()
const mockGetAssistantsCountByOrganization = jest.fn()
const mockCheckUsageLimit = jest.fn()
const mockGetRunningExpressApp = jest.fn()

jest.mock('../../services/assistants', () => ({
    __esModule: true,
    default: {
        createAssistant: (...args: unknown[]) => mockCreateAssistant(...args),
        deleteAssistant: (...args: unknown[]) => mockDeleteAssistant(...args),
        deleteCustomAssistant: (...args: unknown[]) => mockDeleteCustomAssistant(...args),
        getAssistantsCountByOrganization: (...args: unknown[]) => mockGetAssistantsCountByOrganization(...args),
        generateAssistantInstruction: (...args: unknown[]) => mockGenerateAssistantInstruction(...args)
    }
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

jest.mock('../../utils/quotaUsage', () => ({
    checkUsageLimit: (...args: unknown[]) => mockCheckUsageLimit(...args)
}))

import assistantsController from '.'

const createResponse = () => ({ json: jest.fn() } as unknown as Response)

describe('assistant instruction generation workspace scope', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGenerateAssistantInstruction.mockResolvedValue({ content: 'generated' })
    })

    it('passes the active workspace to the Provider-backed service', async () => {
        const req = {
            body: { task: 'Summarize tickets', selectedChatModel: { name: 'chatModel' } },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.generateAssistantInstruction(req, res, next)

        expect(mockGenerateAssistantInstruction).toHaveBeenCalledWith('Summarize tickets', { name: 'chatModel' }, 'workspace-1')
        expect(res.json).toHaveBeenCalledWith({ content: 'generated' })
        expect(next).not.toHaveBeenCalled()
    })

    it('fails closed before the Provider path when no active workspace exists', async () => {
        const req = {
            body: { task: 'Summarize tickets', selectedChatModel: { name: 'chatModel' } }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.generateAssistantInstruction(req, res, next)

        expect(mockGenerateAssistantInstruction).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
    })
})

describe('assistant legacy creation and deletion guards', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({ usageCacheManager: {} })
        mockGetAssistantsCountByOrganization.mockResolvedValue(0)
        mockCheckUsageLimit.mockResolvedValue(undefined)
        mockCreateAssistant.mockResolvedValue({ id: 'assistant-1' })
        mockDeleteAssistant.mockResolvedValue({ affected: 1 })
        mockDeleteCustomAssistant.mockResolvedValue({ assistantId: 'assistant-1', chatflowId: 'flow-1', deleted: true })
    })

    it.each([
        ['OPENAI', 410],
        ['AZURE', 410],
        [undefined, 400]
    ])('rejects %s creation before quota and service side effects', async (type, statusCode) => {
        const req = {
            body: { type, details: '{"name":"blocked"}' },
            user: {
                activeOrganizationId: 'organization-1',
                activeWorkspaceId: 'workspace-1',
                activeOrganizationSubscriptionId: 'subscription-1'
            }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.createAssistant(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode })
        expect(mockGetAssistantsCountByOrganization).not.toHaveBeenCalled()
        expect(mockCheckUsageLimit).not.toHaveBeenCalled()
        expect(mockCreateAssistant).not.toHaveBeenCalled()
    })

    it.each([
        [undefined, false],
        ['false', false],
        [false, false],
        ['true', true],
        [true, true]
    ])('strictly parses isDeleteBoth=%p as %p', async (isDeleteBoth, expected) => {
        const req = {
            params: { id: 'assistant-1' },
            query: isDeleteBoth === undefined ? {} : { isDeleteBoth },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.deleteAssistant(req, res, next)

        expect(mockDeleteAssistant).toHaveBeenCalledWith('assistant-1', expected, 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it.each(['1', 'yes', '', ['true']])('rejects ambiguous isDeleteBoth=%p before the service', async (isDeleteBoth) => {
        const req = {
            params: { id: 'assistant-1' },
            query: { isDeleteBoth },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.deleteAssistant(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 })
        expect(mockDeleteAssistant).not.toHaveBeenCalled()
    })

    it('passes snapshot-bound custom deletion through the active organization and workspace', async () => {
        const body = { expectedAssistant: { type: 'CUSTOM' }, expectedChatflow: { type: 'ASSISTANT' } }
        const req = {
            params: { id: 'assistant-1' },
            body,
            user: { activeOrganizationId: 'organization-1', activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.deleteCustomAssistant(req, res, next)

        expect(mockDeleteCustomAssistant).toHaveBeenCalledWith('assistant-1', body, 'organization-1', 'workspace-1')
        expect(res.json).toHaveBeenCalledWith({ assistantId: 'assistant-1', chatflowId: 'flow-1', deleted: true })
        expect(next).not.toHaveBeenCalled()
    })

    it('fails custom deletion before the service when the active organization is missing', async () => {
        const req = {
            params: { id: 'assistant-1' },
            body: {},
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await assistantsController.deleteCustomAssistant(req, res, next)

        expect(mockDeleteCustomAssistant).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: StatusCodes.NOT_FOUND })
    })
})
