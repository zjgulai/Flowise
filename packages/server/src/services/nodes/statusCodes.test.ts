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

describe('nodesService localized display DTO contract', () => {
    const rawNode = {
        name: 'agentAgentflow',
        label: 'Agent',
        type: 'Agent',
        category: 'Agent Flows',
        description: 'Dynamically choose and utilize tools during runtime, enabling multi-step reasoning',
        version: 1,
        icon: '',
        baseClasses: ['Agent'],
        inputs: [
            { name: 'agentEnableMemory', type: 'boolean', label: 'Enable Memory', description: 'Enable memory for the conversation thread' }
        ]
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({ nodesPool: { componentNodes: { agentAgentflow: rawNode } } })
    })

    it('decorates list, category and single-node responses without mutating the pool', async () => {
        const original = structuredClone(rawNode)
        const [allNodes, categoryNodes, node] = await Promise.all([
            nodesService.getAllNodes(),
            nodesService.getAllNodesForCategory('Agent Flows'),
            nodesService.getNodeByName('agentAgentflow')
        ])

        for (const response of [allNodes[0], categoryNodes[0], node]) {
            expect(response).toMatchObject({
                name: 'agentAgentflow',
                label: 'Agent',
                displayLabel: '智能体',
                category: 'Agent Flows',
                displayCategory: '智能体流程'
            })
            expect(response.inputs?.[0]).toMatchObject({ name: 'agentEnableMemory', label: 'Enable Memory', displayLabel: '启用记忆' })
        }
        expect(rawNode).toEqual(original)
    })

    it('keeps client filtering before display decoration', async () => {
        const scopedNode = {
            ...rawNode,
            inputs: [
                ...rawNode.inputs,
                { name: 'sdkOnly', type: 'string', label: 'SDK Only', client: ['agentflowsdk'] },
                { name: 'canvasOnly', type: 'string', label: 'Canvas Only', client: ['agentflowv2'] }
            ]
        }
        mockGetRunningExpressApp.mockReturnValue({ nodesPool: { componentNodes: { agentAgentflow: scopedNode } } })

        const response = await nodesService.getNodeByName('agentAgentflow', 'agentflowv2')
        expect(response.inputs?.map((input: any) => input.name)).toEqual(['agentEnableMemory', 'canvasOnly'])
    })
})
