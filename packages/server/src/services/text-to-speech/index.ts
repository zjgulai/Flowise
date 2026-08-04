import { StatusCodes } from 'http-status-codes'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getVoices } from 'flowise-components'
import { databaseEntities } from '../../utils'

export enum TextToSpeechProvider {
    OPENAI = 'openai',
    ELEVEN_LABS = 'elevenlabs'
}

export interface TTSRequest {
    text: string
    provider: TextToSpeechProvider
    credentialId: string
    voice?: string
    model?: string
}

export interface TTSResponse {
    audioBuffer: Buffer
    contentType: string
}

const getVoicesForProvider = async (provider: string, credentialId: string, workspaceId: string): Promise<any[]> => {
    try {
        if (!Object.values(TextToSpeechProvider).includes(provider as TextToSpeechProvider))
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Unsupported TTS provider')
        if (!credentialId) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Credential ID required for this provider')
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'TTS request is not authorized')

        const appServer = getRunningExpressApp()
        const options = {
            orgId: '',
            chatflowid: '',
            chatId: '',
            workspaceId,
            appDataSource: appServer.AppDataSource,
            databaseEntities: databaseEntities
        }

        return await getVoices(provider, credentialId, options)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to load TTS voices')
    }
}

export default {
    getVoices: getVoicesForProvider
}
