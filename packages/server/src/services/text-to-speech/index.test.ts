import { getVoices } from 'flowise-components'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

jest.mock('flowise-components', () => ({ getVoices: jest.fn() }))
jest.mock('../../utils', () => ({ databaseEntities: { Credential: 'credential-entity' } }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))

import textToSpeechService from '.'

const mockGetVoices = getVoices as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

describe('text-to-speech service credential scoping', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({ AppDataSource: { name: 'test-data-source' } })
        mockGetVoices.mockResolvedValue([{ id: 'alloy' }])
    })

    it('passes the active workspace through to component credential resolution', async () => {
        await expect(textToSpeechService.getVoices('openai', 'credential-1', 'workspace-1')).resolves.toEqual([{ id: 'alloy' }])

        expect(mockGetVoices).toHaveBeenCalledWith(
            'openai',
            'credential-1',
            expect.objectContaining({
                workspaceId: 'workspace-1',
                appDataSource: { name: 'test-data-source' },
                databaseEntities: { Credential: 'credential-entity' }
            })
        )
    })

    it('rejects unsupported providers before any component call', async () => {
        await expect(textToSpeechService.getVoices('untrusted-provider', 'credential-1', 'workspace-1')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Unsupported TTS provider'
        })
        expect(mockGetVoices).not.toHaveBeenCalled()
    })

    it('fails closed when the workspace is absent', async () => {
        await expect(textToSpeechService.getVoices('openai', 'credential-1', '')).rejects.toMatchObject({
            statusCode: 403
        })
        expect(mockGetVoices).not.toHaveBeenCalled()
    })

    it('does not expose provider or credential errors to the caller', async () => {
        mockGetVoices.mockRejectedValue(new Error('provider leaked secret sk-test-value'))

        await expect(textToSpeechService.getVoices('openai', 'credential-1', 'workspace-1')).rejects.toEqual(
            expect.objectContaining({ message: 'Failed to load TTS voices', statusCode: 500 })
        )
        expect(mockGetVoices).toHaveBeenCalledTimes(1)
    })
})
