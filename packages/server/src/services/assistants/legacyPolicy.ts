import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

export const OPENAI_ASSISTANTS_CREATION_DISABLED_MESSAGE =
    'OpenAI Assistants API is deprecated and new OpenAI assistants are disabled; migrate to Custom Assistant or Responses API'
export const AZURE_ASSISTANTS_CREATION_DISABLED_MESSAGE =
    'Azure OpenAI assistants are disabled; migrate to Custom Assistant or a supported Responses API integration'
export const OPENAI_ASSISTANT_RESOURCE_CREATION_DISABLED_MESSAGE =
    'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
export const OPENAI_ASSISTANT_RESOURCE_DESTRUCTION_DISABLED_MESSAGE =
    'OpenAI Assistants API is deprecated and destructive OpenAI Assistant resource cleanup is disabled'

export const assertAssistantCreationAllowed = (assistantType: unknown): void => {
    if (assistantType === 'OPENAI') {
        throw new InternalFlowiseError(StatusCodes.GONE, OPENAI_ASSISTANTS_CREATION_DISABLED_MESSAGE)
    }
    if (assistantType === 'AZURE') {
        throw new InternalFlowiseError(StatusCodes.GONE, AZURE_ASSISTANTS_CREATION_DISABLED_MESSAGE)
    }
    if (assistantType !== 'CUSTOM') {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid assistant type')
    }
}

export const assertOpenAIAssistantResourceCreationAllowed = (): never => {
    throw new InternalFlowiseError(StatusCodes.GONE, OPENAI_ASSISTANT_RESOURCE_CREATION_DISABLED_MESSAGE)
}

export const assertOpenAIAssistantResourceDestructionAllowed = (): never => {
    throw new InternalFlowiseError(StatusCodes.GONE, OPENAI_ASSISTANT_RESOURCE_DESTRUCTION_DISABLED_MESSAGE)
}
