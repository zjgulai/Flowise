import { Request, Response } from 'express'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const mockGenerateAgentflowv2 = jest.fn()

jest.mock('../../services/agentflowv2-generator', () => ({
    __esModule: true,
    default: { generateAgentflowv2: (...args: unknown[]) => mockGenerateAgentflowv2(...args) }
}))

import agentflowv2GeneratorController from '.'

describe('Agentflow V2 generator controller workspace scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGenerateAgentflowv2.mockResolvedValue({ nodes: [], edges: [] })
    })

    it('passes the active workspace to the generator service', async () => {
        const req = {
            body: { question: '  Create a support flow  ', selectedChatModel: { name: 'chatModel' } },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await agentflowv2GeneratorController.generateAgentflowv2(req, res, next)

        expect(mockGenerateAgentflowv2).toHaveBeenCalledWith('Create a support flow', { name: 'chatModel' }, 'workspace-1')
        expect(next).not.toHaveBeenCalled()
    })

    it('fails closed before service execution when the active workspace is absent', async () => {
        const req = {
            body: { question: 'Create a support flow', selectedChatModel: { name: 'chatModel' } },
            user: {}
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await agentflowv2GeneratorController.generateAgentflowv2(req, res, next)

        expect(mockGenerateAgentflowv2).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 })
    })

    it.each([
        ['', { name: 'chatModel' }],
        ['   ', { name: 'chatModel' }],
        [123, { name: 'chatModel' }],
        ['x'.repeat(10_001), { name: 'chatModel' }],
        ['Create a support flow', null],
        ['Create a support flow', []],
        ['Create a support flow', 'chatModel']
    ])('returns a fixed 400 before service execution for an invalid request %#', async (question, selectedChatModel) => {
        const req = {
            body: { question, selectedChatModel },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = { json: jest.fn() } as unknown as Response
        const next = jest.fn()

        await agentflowv2GeneratorController.generateAgentflowv2(req, res, next)

        expect(mockGenerateAgentflowv2).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
        expect(next.mock.calls[0][0]).toBeInstanceOf(InternalFlowiseError)
        expect(next.mock.calls[0][0]).toMatchObject({
            statusCode: 400,
            message: 'Invalid Agentflow generation request'
        })
    })
})
