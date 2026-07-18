import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (relativePath) => readFileSync(resolve(__dirname, relativePath), 'utf8')

describe('production UI safety contracts', () => {
    it('gates both public login routes and preserves the access-restricted route', () => {
        const source = read('./AuthRoutes.jsx')
        const loginRoute = source.match(/path: '\/login',[\s\S]*?\n\s*},/)?.[0] ?? ''
        const signInRoute = source.match(/path: '\/signin',[\s\S]*?\n\s*},/)?.[0] ?? ''

        expect(loginRoute).toContain('<PublicLoginRoute>')
        expect(signInRoute).toContain('<PublicLoginRoute>')
        expect(source).toContain("path: '/access-restricted'")
    })

    it('redirects unauthenticated protected routes to the configured public access boundary', () => {
        const source = read('./RequireAuth.jsx')
        expect(source).toContain("config.PUBLIC_LOGIN_ENABLED === false ? '/access-restricted' : '/login'")
    })

    it('does not render the login resolver at root when public login is disabled', () => {
        const source = read('./DefaultRedirect.jsx')
        expect(source).toContain('config.PUBLIC_LOGIN_ENABLED === false')
        expect(source).toContain("<Navigate to='/access-restricted' replace />")
    })

    it('fails closed when platform settings cannot be loaded', () => {
        expect(read('../store/context/ConfigContext.jsx')).toContain('useState({ PUBLIC_LOGIN_ENABLED: false })')
    })

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
