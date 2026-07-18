import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

describe('production UI safety contracts', () => {
    it('protects the account route with RequireAuth', () => {
        const source = read('./MainRoutes.jsx')
        const accountRoute = source.match(/path: '\/account',[\s\S]*?\n\s*},/)?.[0] ?? ''
        expect(accountRoute).toContain('<RequireAuth')
    })

    it('does not fetch the GitHub star count at runtime', () => {
        expect(read('../layout/MainLayout/Header/index.jsx')).not.toContain('api.github.com')
    })

    it('fails closed until organization setup is explicitly allowed by auth resolve', () => {
        const source = read('../views/organization/index.jsx')
        expect(source).toContain('setupAllowed')
        expect(source).toContain('resolveLoginApi')
    })

    it.each([
        ['../views/auth/verify-email.jsx', '验证链接缺少令牌'],
        ['../views/auth/confirm-email-change.jsx', '邮箱变更链接缺少令牌']
    ])('renders a missing-token state in %s', (file, message) => {
        expect(read(file)).toContain(message)
    })
})
