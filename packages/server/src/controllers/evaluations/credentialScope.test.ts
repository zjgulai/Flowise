import { Request, Response } from 'express'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockCreateEvaluation = jest.fn()
const mockRunAgain = jest.fn()

jest.mock('../../services/evaluations', () => ({
    __esModule: true,
    default: {
        createEvaluation: (...args: unknown[]) => mockCreateEvaluation(...args),
        runAgain: (...args: unknown[]) => mockRunAgain(...args)
    }
}))

import evaluationsController from '.'

describe('evaluation controller workspace scoping', () => {
    const previousAppUrl = process.env.APP_URL

    beforeEach(() => {
        jest.clearAllMocks()
        process.env.APP_URL = 'https://flowise.example.test/'
        mockCreateEvaluation.mockResolvedValue([])
        mockRunAgain.mockResolvedValue([])
    })

    afterAll(() => {
        if (previousAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = previousAppUrl
    })

    it('binds evaluation creation to the active workspace', async () => {
        const body = { evaluationType: 'llm', credentialId: 'credential-1' }
        const req = {
            body,
            user: {
                activeOrganizationId: 'organization-1',
                activeWorkspaceId: 'workspace-1'
            }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await evaluationsController.createEvaluation(req, res, next)

        expect(body).toEqual(expect.objectContaining({ workspaceId: 'workspace-1' }))
        expect(mockCreateEvaluation).toHaveBeenCalledWith(body, 'https://flowise.example.test', 'organization-1', 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('binds reruns to the normalized canonical APP_URL', async () => {
        const req = {
            params: { id: 'evaluation-1' },
            user: {
                activeOrganizationId: 'organization-1',
                activeWorkspaceId: 'workspace-1'
            }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await evaluationsController.runAgain(req, res, next)

        expect(mockRunAgain).toHaveBeenCalledWith('evaluation-1', 'https://flowise.example.test', 'organization-1', 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('fails closed before service execution when canonical APP_URL is unsafe', async () => {
        process.env.APP_URL = 'https://user:password@flowise.example.test'
        const req = {
            body: { evaluationType: 'llm', credentialId: 'credential-1' },
            user: {
                activeOrganizationId: 'organization-1',
                activeWorkspaceId: 'workspace-1'
            }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await evaluationsController.createEvaluation(req, res, next)

        expect(mockCreateEvaluation).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toEqual(new Error('Flowise base URL is not configured securely.'))
    })

    it('fails closed before service execution without an active workspace', async () => {
        const req = {
            body: { evaluationType: 'llm', credentialId: 'credential-1' },
            user: { activeOrganizationId: 'organization-1' }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await evaluationsController.createEvaluation(req, res, next)

        expect(mockCreateEvaluation).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
    })
})
