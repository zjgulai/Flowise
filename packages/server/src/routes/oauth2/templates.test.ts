import { generateErrorPage, generateSuccessPage } from './templates'

describe('OAuth2 callback response templates', () => {
    const previousAppUrl = process.env.APP_URL

    beforeAll(() => {
        process.env.APP_URL = 'https://flowise.example.invalid/app'
    })

    afterAll(() => {
        if (previousAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = previousAppUrl
    })

    it('escapes provider-controlled values in both HTML and inline-script contexts', () => {
        const attack = '</script><script>window.injected=true</script>&\u2028'
        const html = generateErrorPage(attack, attack, attack)

        expect(html).not.toContain(attack)
        expect(html).not.toContain('</script><script>')
        expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003e')
        expect(html).toContain('&lt;/script&gt;&lt;script&gt;window.injected=true&lt;/script&gt;&amp;')
    })

    it('posts only to the canonical application origin', () => {
        const html = generateSuccessPage('credential-1')

        expect(html).toContain(`postMessage(`)
        expect(html).toContain(`"https://flowise.example.invalid"`)
        expect(html).not.toContain(`, '*')`)
    })
})
