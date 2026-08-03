import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockAssertCredentialInWorkspace = jest.fn()
let mockCredentialShareActive = true
const mockLoadOptions = jest.fn(async (_nodeData: unknown, options: Record<string, unknown>) => {
    if (options.workspaceId !== 'workspace-1' || !mockCredentialShareActive) {
        throw new Error('Credential is not available in this workspace')
    }
    return [{ label: 'Model One', name: 'model-one' }]
})

jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockAssertCredentialInWorkspace(...args) }
}))

jest.mock('../component-metadata-localization', () => ({
    decorateDynamicOptions: (_nodeName: string, _methodName: string, options: unknown) => options,
    decorateNodeMetadata: (node: unknown) => node
}))

jest.mock('../../utils', () => ({ databaseEntities: { Credential: 'credential-entity' } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: {} }))

import nodesService from '.'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

describe('node async options runtime credential scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCredentialShareActive = true
        mockAssertCredentialInWorkspace.mockResolvedValue(undefined)
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {},
            cachePool: {},
            nodesPool: {
                componentNodes: {
                    chatOpenAI: {
                        name: 'chatOpenAI',
                        category: 'Chat Models',
                        credential: { name: 'credential' },
                        inputs: [{ name: 'modelName', loadMethod: 'listModels' }],
                        loadMethods: { listModels: mockLoadOptions }
                    }
                }
            }
        })
    })

    const requestBody = {
        credential: 'credential-1',
        loadMethod: 'listModels',
        previousNodes: [],
        currentNode: 'chatModel'
    }

    it('passes the same active workspace to authorization and runtime credential resolution', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('chatOpenAI', requestBody, 'workspace-1', {
                permissions: ['chatflows:update', 'credentials:view']
            })
        ).resolves.toEqual([{ label: 'Model One', name: 'model-one' }])

        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledWith('credential-1', 'workspace-1')
        expect(mockLoadOptions).toHaveBeenCalledWith(
            requestBody,
            expect.objectContaining({ workspaceId: 'workspace-1', databaseEntities: { Credential: 'credential-entity' } })
        )
    })

    it('fails before runtime use when the credential is not available to the workspace', async () => {
        mockAssertCredentialInWorkspace.mockRejectedValue(new InternalFlowiseError(404, 'Credential not found'))

        await expect(
            nodesService.getSingleNodeAsyncOptions('chatOpenAI', requestBody, 'workspace-other', {
                permissions: ['chatflows:update', 'credentials:view']
            })
        ).rejects.toMatchObject({ statusCode: 404 })
        expect(mockLoadOptions).not.toHaveBeenCalled()
    })

    it('fails closed at runtime when a credential share is revoked after the authorization pre-check', async () => {
        await expect(
            nodesService.getSingleNodeAsyncOptions('chatOpenAI', requestBody, 'workspace-1', {
                permissions: ['chatflows:update', 'credentials:view']
            })
        ).resolves.toHaveLength(1)

        mockCredentialShareActive = false

        await expect(
            nodesService.getSingleNodeAsyncOptions('chatOpenAI', requestBody, 'workspace-1', {
                permissions: ['chatflows:update', 'credentials:view']
            })
        ).resolves.toEqual([])
        expect(mockAssertCredentialInWorkspace).toHaveBeenCalledTimes(2)
        expect(mockLoadOptions).toHaveBeenCalledTimes(2)
    })
})
