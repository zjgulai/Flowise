import { StatusCodes } from 'http-status-codes'
import { normalizeWorkspaceExportInput } from './workspaceExportContract'

describe('restorable workspace export contract', () => {
    it('normalizes supported selections to explicit booleans', () => {
        expect(normalizeWorkspaceExportInput({ tool: true })).toMatchObject({
            chatflow: false,
            tool: true,
            document_store: false,
            variable: false,
            assistantCustom: false,
            assistantOpenAI: false,
            assistantAzure: false
        })
    })

    it.each([null, [], 'all', {}, { chatflow: false }, { chatflwo: true }, { chatflow: 'false' }, { assistantOpenAI: 'false' }])(
        'rejects malformed or empty input (%p)',
        (value) => {
            expect(() => normalizeWorkspaceExportInput(value)).toThrow(
                expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid workspace export request' })
            )
        }
    )

    it.each([{ assistantOpenAI: true }, { assistantAzure: true }])(
        'rejects legacy assistants from the restorable backup contract (%p)',
        (value) => {
            expect(() => normalizeWorkspaceExportInput(value)).toThrow(
                expect.objectContaining({
                    statusCode: StatusCodes.GONE,
                    message: '旧版 OpenAI 和 Azure 助手仅供归档，不能加入可恢复的工作区备份'
                })
            )
        }
    )

    it('accepts an explicit complete fresh-workspace parent closure for feedback backups', () => {
        expect(
            normalizeWorkspaceExportInput({
                chat_feedback: true,
                chat_message: true,
                execution: true,
                agentflow: true,
                agentflowv2: true,
                assistantCustom: true,
                chatflow: true,
                document_store: true,
                tool: true,
                variable: true
            })
        ).toMatchObject({
            chat_feedback: true,
            chat_message: true,
            execution: true,
            agentflow: true,
            agentflowv2: true,
            assistantCustom: true,
            chatflow: true,
            document_store: true,
            tool: true,
            variable: true
        })
    })

    it.each([{ chat_feedback: true }, { chat_message: true }, { execution: true }, { chatflow: true }, { custom_template: true }])(
        'accepts a narrow root selection whose record dependencies are resolved by the exporter (%p)',
        (value) => {
            expect(normalizeWorkspaceExportInput(value)).toMatchObject(value)
        }
    )
})
