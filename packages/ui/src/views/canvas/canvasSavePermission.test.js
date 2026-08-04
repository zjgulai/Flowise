import { getCanvasSavePermission } from './canvasSavePermission'

describe('canvas save permission', () => {
    it.each([
        [{ isAgentCanvas: true, persistedFlowId: undefined }, 'agentflows:create'],
        [{ isAgentCanvas: true, persistedFlowId: '' }, 'agentflows:create'],
        [{ isAgentCanvas: true, persistedFlowId: 'agentflow-1' }, 'agentflows:update'],
        [{ isAgentCanvas: false, persistedFlowId: undefined }, 'chatflows:create'],
        [{ isAgentCanvas: false, persistedFlowId: 'chatflow-1' }, 'chatflows:update']
    ])('derives the permission from current persisted identity', (input, expectedPermission) => {
        expect(getCanvasSavePermission(input)).toBe(expectedPermission)
    })
})
