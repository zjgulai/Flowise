import fs from 'fs'
import path from 'path'

const readSource = (relativePath: string): string => fs.readFileSync(path.join(__dirname, relativePath), 'utf8')

describe('canonical execution URL and OAuth2 refresh capability contracts', () => {
    const buildChatflow = readSource('buildChatflow.ts')
    const buildAgentflow = readSource('buildAgentflow.ts')
    const buildAgentGraph = readSource('buildAgentGraph.ts')
    const utilIndex = readSource('index.ts')
    const upsertVector = readSource('upsertVector.ts')
    const documentStore = readSource('../services/documentstore/index.ts')
    const openAIRealtime = readSource('../services/openai-realtime/index.ts')

    it('derives chatflow, agentflow, and upsert base URLs only from canonical APP_URL', () => {
        expect(buildChatflow).toContain('resolveFlowiseRequestTarget().canonicalOrigin')
        expect(buildAgentflow).toContain('resolveFlowiseRequestTarget().canonicalOrigin')
        expect(upsertVector).toContain('resolveFlowiseRequestTarget().canonicalOrigin')

        for (const source of [buildChatflow, buildAgentflow, upsertVector]) {
            expect(source).not.toContain("req.get('x-forwarded-proto')")
            expect(source).not.toContain("req.get('host')")
        }
    })

    it('injects the workspace-bound capability into ordinary flow init, upsert, and ending-node run options', () => {
        const buildFlowStart = utilIndex.indexOf('export const buildFlow')
        const buildFlowSource = utilIndex.slice(buildFlowStart, utilIndex.indexOf('export const resolveVariables', buildFlowStart))
        expect(buildFlowSource).toMatch(/vectorStoreMethods![\s\S]*refreshOAuth2Credential/)
        expect(buildFlowSource).toMatch(/newNodeInstance\.init[\s\S]*refreshOAuth2Credential/)

        const endingRunStart = buildChatflow.indexOf('/*** Prepare run params ***/')
        const endingRunSource = buildChatflow.slice(endingRunStart, buildChatflow.indexOf('/*** Run the ending node ***/', endingRunStart))
        expect(endingRunSource).toContain('refreshOAuth2Credential')
    })

    it('injects the same capability into Agentflow v2, recursive execution, and legacy agent graphs', () => {
        const runParamsStart = buildAgentflow.indexOf('// Prepare run parameters')
        const runParamsSource = buildAgentflow.slice(runParamsStart, buildAgentflow.indexOf('// Execute node', runParamsStart))
        expect(runParamsSource).toContain('refreshOAuth2Credential')

        const recursiveStart = buildAgentflow.indexOf('// Execute sub-flow recursively')
        const recursiveSource = buildAgentflow.slice(recursiveStart, recursiveStart + 1500)
        expect(recursiveSource).toContain('refreshOAuth2Credential')

        const graphOptionsStart = buildAgentGraph.indexOf('const options = {')
        const graphOptionsSource = buildAgentGraph.slice(graphOptionsStart, graphOptionsStart + 700)
        expect(graphOptionsSource).toContain('refreshOAuth2Credential')
    })

    it('covers document loader/vector/query and realtime tool initialization without serializing the capability into queue payloads', () => {
        expect((documentStore.match(/createWorkspaceOAuth2RefreshCapability\(workspaceId\)/g) ?? []).length).toBeGreaterThanOrEqual(6)
        expect(openAIRealtime).toContain('refreshOAuth2Credential = createWorkspaceOAuth2RefreshCapability(workspaceId)')
        expect(openAIRealtime).toMatch(/buildFlow\([\s\S]*refreshOAuth2Credential/)
        expect(openAIRealtime).toMatch(/nodeInstance\.init[\s\S]*refreshOAuth2Credential/)

        const executeDataStart = buildChatflow.indexOf('const executeData: IExecuteFlowParams')
        const executeDataSource = buildChatflow.slice(executeDataStart, buildChatflow.indexOf('throwIfPredictionAborted', executeDataStart))
        expect(executeDataSource).not.toContain('refreshOAuth2Credential')
    })
})
