import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

describe('Agentflow canvas write guard', () => {
    it('blocks save until the requested resource has parsed successfully', () => {
        const canvas = read('../views/agentflowsv2/Canvas.jsx')
        const header = read('../views/canvas/CanvasHeader.jsx')

        expect(canvas).toContain('const [isFlowDataWriteBlocked, setIsFlowDataWriteBlocked] = useState(true)')
        expect(canvas).toContain('isExpectedAgentflowResource(chatflowId, chatflow)')
        expect(canvas).toContain('if (isFlowDataWriteBlocked ||')
        expect(canvas).toContain('(chatflowId && !chatflow.flowData)')
        expect(canvas).toContain('isSaveDisabled={isFlowDataWriteBlocked}')
        expect(canvas.match(/setIsFlowDataWriteBlocked\(!applied\)/g)).toHaveLength(2)
        expect(canvas).toContain('setIsFlowDataWriteBlocked(true)\n            errorFailed(getErrorMessage(getSpecificChatflowApi.error')
        expect(header).toContain('if (isSaveDisabled) return')
        expect(header).toContain('disabled={isSaveDisabled}')
        expect(header).toContain('onClick={onSaveChatflowClick}')
        expect(header).toContain('getCanvasSavePermission({ isAgentCanvas, persistedFlowId: chatflow?.id })')
        expect(header).not.toContain('setSavePermission')
    })

    it('uses route identity for create versus update and rejects stale store resources on a new route', () => {
        const canvas = read('../views/agentflowsv2/Canvas.jsx')
        const flowData = read('../views/agentflowsv2/canvasFlowData.js')

        expect(canvas).toContain('if (!chatflowId) {')
        expect(canvas).toContain('updateChatflowApi.request(chatflowId, updateBody)')
        expect(canvas).not.toContain('updateChatflowApi.request(chatflow.id, updateBody)')
        expect(canvas).toContain("type: 'AGENTFLOW'")
        expect(canvas).toContain("const { id: chatflowId = '' } = useParams()")
        expect(canvas).toContain('useLayoutEffect(() => {')
        expect(canvas).toContain('getSpecificChatflowApi.reset()')
        expect(canvas).toContain('createNewChatflowApi.reset()')
        expect(canvas).toContain('updateChatflowApi.reset()')
        expect(canvas).toContain('routeGenerationRef.current += 1')
        expect(canvas).toContain('saveRequestContextRef.current = null')
        expect(canvas).toContain('isExpectedAgentflowSaveResponse({')
        expect(canvas).toContain('dispatch({ type: SET_CHATFLOW, chatflow: null })')
        expect(canvas).toContain('}, [chatflowId])')
        expect(canvas).toContain('activeChatflowIdRef.current === targetFlowId')
        expect(canvas).toContain('isCurrentFlowResourceReady && (')
        expect(flowData).toContain("return candidateChatflow?.id === undefined && candidateChatflow?.type === 'AGENTFLOW'")
    })

    it('does not import a flow from an implicit window paste handler', () => {
        const canvas = read('../views/agentflowsv2/Canvas.jsx')

        expect(canvas).not.toContain("window.addEventListener('paste'")
        expect(canvas).not.toContain('clipboardData.getData')
        expect(canvas).not.toContain('handlePaste')
        expect(canvas).toContain('handleLoadFlow={handleLoadFlow}')
    })

    it('routes every Canvas flow import through the strict helper and preserves state on failed imports', () => {
        const canvas = read('../views/agentflowsv2/Canvas.jsx')
        const flowData = read('../views/agentflowsv2/canvasFlowData.js')

        expect(canvas).not.toContain('parseFlowDataForCanvas')
        expect(canvas).toContain('applyImportedAgentflowCanvasData({')
        expect(canvas).toContain("handleLoadFlow(localStorage.getItem('duplicatedFlowData'))")
        expect(flowData).toContain('flowData = parseAgentflowCanvasData(serializedFlowData)')
        expect(flowData).toContain("onError(getErrorMessage(error, '导入流程失败，请检查文件格式'))")
        expect(flowData.indexOf('setNodes(flowData.nodes)')).toBeGreaterThan(
            flowData.indexOf('parseAgentflowCanvasData(serializedFlowData)')
        )
        expect(flowData.indexOf('onDirty()')).toBeGreaterThan(flowData.indexOf('setEdges(flowData.edges)'))
    })
})
