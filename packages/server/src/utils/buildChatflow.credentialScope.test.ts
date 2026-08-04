import fs from 'fs'
import path from 'path'

describe('buildChatflow credential-backed runtime option contracts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'buildChatflow.ts'), 'utf8')

    it('passes workspaceId to every follow-up prompt Provider call', () => {
        const callOffsets = [...source.matchAll(/generateFollowUpPrompts\(/g)].map((match) => match.index)

        expect(callOffsets).toHaveLength(2)
        for (const offset of callOffsets) {
            const callSite = source.slice(offset, offset + 500)
            expect(callSite).toMatch(/workspaceId[\s\S]*appDataSource[\s\S]*databaseEntities/)
        }
    })

    it('passes workspaceId to speech-to-text Provider execution', () => {
        const speechToTextBlock = source.slice(source.indexOf('convertSpeechToText(') - 500, source.indexOf('convertSpeechToText(') + 300)

        expect(speechToTextBlock).toMatch(/workspaceId[\s\S]*appDataSource[\s\S]*databaseEntities/)
    })

    it('passes workspaceId to automatic TTS Provider execution', () => {
        const autoTTSBlock = source.slice(source.indexOf('if (shouldAutoPlayTTS'), source.indexOf('if (shouldAutoPlayTTS') + 700)

        expect(autoTTSBlock).toMatch(/workspaceId[\s\S]*appDataSource[\s\S]*databaseEntities/)
        expect(autoTTSBlock).toContain('generateTTSForResponseStream')
    })

    it('passes workspaceId to every credential-backed memory history initialization', () => {
        const callOffsets = [...source.matchAll(/getSessionChatHistory\(/g)].map((match) => match.index)

        expect(callOffsets).toHaveLength(2)
        for (const offset of callOffsets) {
            const callSite = source.slice(offset, offset + 500)
            expect(callSite).toMatch(/prependMessages,\s*workspaceId,\s*orgId/)
        }
    })
})
