import { StatusCodes } from 'http-status-codes'
import {
    assertAssistantCreationAllowed,
    assertOpenAIAssistantResourceCreationAllowed,
    assertOpenAIAssistantResourceDestructionAllowed,
    AZURE_ASSISTANTS_CREATION_DISABLED_MESSAGE,
    OPENAI_ASSISTANTS_CREATION_DISABLED_MESSAGE,
    OPENAI_ASSISTANT_RESOURCE_CREATION_DISABLED_MESSAGE,
    OPENAI_ASSISTANT_RESOURCE_DESTRUCTION_DISABLED_MESSAGE
} from './legacyPolicy'

describe('assistant legacy creation policy', () => {
    it('allows only custom assistant creation', () => {
        expect(() => assertAssistantCreationAllowed('CUSTOM')).not.toThrow()
    })

    it('rejects OpenAI assistant creation with the fixed 410 migration message', () => {
        expect(() => assertAssistantCreationAllowed('OPENAI')).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.GONE, message: OPENAI_ASSISTANTS_CREATION_DISABLED_MESSAGE })
        )
    })

    it('rejects Azure assistant creation with a fixed 410 migration message', () => {
        expect(() => assertAssistantCreationAllowed('AZURE')).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.GONE, message: AZURE_ASSISTANTS_CREATION_DISABLED_MESSAGE })
        )
    })

    it.each(['UNKNOWN', '', undefined, null, {}, []])('rejects unknown type %p with 400', (type) => {
        expect(() => assertAssistantCreationAllowed(type)).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
    })

    it('rejects creation of legacy OpenAI Assistant Provider resources with a fixed 410', () => {
        expect(() => assertOpenAIAssistantResourceCreationAllowed()).toThrow(
            expect.objectContaining({
                statusCode: StatusCodes.GONE,
                message: OPENAI_ASSISTANT_RESOURCE_CREATION_DISABLED_MESSAGE
            })
        )
    })

    it('rejects destructive legacy resource cleanup until reference-safe governance exists', () => {
        expect(() => assertOpenAIAssistantResourceDestructionAllowed()).toThrow(
            expect.objectContaining({
                statusCode: StatusCodes.GONE,
                message: OPENAI_ASSISTANT_RESOURCE_DESTRUCTION_DISABLED_MESSAGE
            })
        )
    })
})
