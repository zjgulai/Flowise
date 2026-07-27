import express from 'express'
import request from 'supertest'
import { enforceAuthResolvePostOnly, resolveSecureCookie } from './authSecurityPolicy'

describe('resolveSecureCookie', () => {
    it('always enables secure cookies in production even when the override is false', () => {
        expect(
            resolveSecureCookie({
                NODE_ENV: 'production',
                SECURE_COOKIES: 'false',
                APP_URL: 'http://flowise.example.com'
            })
        ).toBe(true)
    })

    it.each([
        [{ NODE_ENV: 'development', SECURE_COOKIES: 'true' }, true],
        [{ NODE_ENV: 'development', SECURE_COOKIES: 'false' }, false],
        [{ NODE_ENV: 'development', APP_URL: 'https://flowise.example.com' }, true],
        [{ NODE_ENV: 'development', APP_URL: 'http://127.0.0.1:3000' }, false],
        [{ NODE_ENV: 'test' }, false]
    ] as const)('preserves non-production cookie policy %#', (env, expected) => {
        expect(resolveSecureCookie(env)).toBe(expected)
    })
})

describe('enforceAuthResolvePostOnly', () => {
    function createFixture() {
        const app = express()
        app.all('/api/v1/auth/resolve', enforceAuthResolvePostOnly)
        app.post('/api/v1/auth/resolve', (_req, res) => res.status(200).json({ redirectUrl: '/signin' }))
        return app
    }

    it.each(['get', 'head'] as const)('returns a bounded 405 for %s', async (method) => {
        const response = await request(createFixture())[method]('/api/v1/auth/resolve')

        expect(response.status).toBe(405)
        expect(response.headers.allow).toBe('POST')
        expect(JSON.stringify(response.body ?? response.text)).not.toMatch(/isOrganizationAdmin|TypeError|stack/i)
    })

    it('allows POST to reach the existing resolve handler', async () => {
        const response = await request(createFixture()).post('/api/v1/auth/resolve')

        expect(response.status).toBe(200)
        expect(response.body).toEqual({ redirectUrl: '/signin' })
    })
})
