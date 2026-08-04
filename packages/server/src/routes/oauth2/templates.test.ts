import { generateErrorPage, generateOAuth2ResponsePage, generateSuccessPage } from './templates'

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
        const html = generateOAuth2ResponsePage({
            title: attack,
            statusIcon: '!',
            statusText: attack,
            statusColor: '#f44336',
            message: attack,
            details: attack,
            postMessageType: 'OAUTH2_ERROR',
            postMessageData: { message: attack },
            autoCloseDelay: 1000
        })

        expect(html).not.toContain(attack)
        expect(html).not.toContain('</script><script>')
        expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003e')
        expect(html).toContain('&lt;/script&gt;&lt;script&gt;window.injected=true&lt;/script&gt;&amp;')
    })

    it('does not include provider error fields in the rendered error page or parent message', () => {
        const attack = '</script><script>window.injected=true</script>&\u2028'
        const html = generateErrorPage(attack, attack, attack)

        expect(html).not.toContain(attack)
        expect(html).not.toContain('window.injected')
        expect(html).not.toContain('console.log')
    })

    it('posts only to the canonical application origin', () => {
        const html = generateSuccessPage('credential-1')

        expect(html).toContain(`postMessage(`)
        expect(html).toContain(`"https://flowise.example.invalid"`)
        expect(html).not.toContain(`, '*')`)
    })

    it('renders Chinese status copy without exposing the provider error message as primary content', () => {
        const successHtml = generateSuccessPage('credential-1')
        const errorHtml = generateErrorPage('provider_error', 'Provider supplied English failure')

        expect(successHtml).toContain('<html lang="zh-CN">')
        expect(successHtml).toContain('<title>OAuth2 授权成功</title>')
        expect(successHtml).toContain('✓ 授权成功')
        expect(successHtml).toContain('授权已完成，您现在可以关闭此窗口。')
        expect(successHtml).not.toContain('Authorization Successful')

        expect(errorHtml).toContain('<title>OAuth2 授权失败</title>')
        expect(errorHtml).toContain('✗ 授权失败')
        expect(errorHtml).toContain('授权未完成，请返回应用后重试。')
        expect(errorHtml).not.toContain('Provider supplied English failure')
        expect(errorHtml).not.toContain('Authorization Failed')
    })
})
