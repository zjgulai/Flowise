import fs from 'fs'
import path from 'path'

describe('buildAgentflow credential-backed runtime option contracts', () => {
    const source = fs.readFileSync(path.join(__dirname, 'buildAgentflow.ts'), 'utf8')

    it('passes workspaceId to automatic TTS Provider execution', () => {
        const autoTTSBlock = source.slice(source.indexOf('if (shouldAutoPlayTTS'), source.indexOf('if (shouldAutoPlayTTS') + 900)

        expect(autoTTSBlock).toMatch(/workspaceId[\s\S]*appDataSource[\s\S]*databaseEntities/)
        expect(autoTTSBlock).toContain('generateTTSForResponseStream')
    })

    it('passes workspaceId to follow-up prompt Provider execution', () => {
        const followUpOffset = source.indexOf('generateFollowUpPrompts(')
        const followUpBlock = source.slice(followUpOffset, followUpOffset + 500)

        expect(followUpOffset).toBeGreaterThan(-1)
        expect(followUpBlock).toMatch(/workspaceId[\s\S]*appDataSource[\s\S]*databaseEntities/)
    })
})
