export const getCanvasSavePermission = ({ isAgentCanvas, persistedFlowId }) => {
    const resource = isAgentCanvas ? 'agentflows' : 'chatflows'
    return `${resource}:${persistedFlowId ? 'update' : 'create'}`
}
