import * as fs from 'fs'
import * as path from 'path'

describe('Deepseek and Kimi model catalog', () => {
    let deepseek: any
    let kimi: any

    beforeAll(() => {
        const modelsPath = path.join(__dirname, '..', '..', 'models.json')
        const raw = JSON.parse(fs.readFileSync(modelsPath, 'utf8'))
        deepseek = raw.chat.find((provider: any) => provider.name === 'deepseek')
        kimi = raw.chat.find((provider: any) => provider.name === 'kimi')
    })

    it('contains current Deepseek V4 models', () => {
        expect(deepseek.models.map((model: any) => model.name)).toEqual(expect.arrayContaining(['deepseek-v4-flash', 'deepseek-v4-pro']))
    })

    it('hides unsupported Deepseek reasoning models and leaves V4 pricing unset', () => {
        const names = deepseek.models.map((model: any) => model.name)

        expect(names).not.toContain('deepseek-reasoner')
        for (const name of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
            const model = deepseek.models.find((entry: any) => entry.name === name)
            expect(model).not.toHaveProperty('input_cost')
            expect(model).not.toHaveProperty('output_cost')
        }
    })

    it('contains only non-thinking Kimi K2 models and supported Moonshot V1 models', () => {
        expect(kimi.models.map((model: any) => model.name)).toEqual(
            expect.arrayContaining(['kimi-k2.6', 'kimi-k2.5', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'])
        )
        expect(kimi.models.map((model: any) => model.name)).not.toEqual(
            expect.arrayContaining(['kimi-k2.7-code', 'kimi-k2.7-code-highspeed'])
        )
    })

    it.each(['deepseek', 'kimi'])('has unique model IDs for %s', (providerName) => {
        const provider = providerName === 'deepseek' ? deepseek : kimi
        const names = provider.models.map((model: any) => model.name)
        expect(new Set(names).size).toBe(names.length)
    })
})
