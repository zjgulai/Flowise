import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { requireInteractiveSession, requireOrganizationAdminSession } from '../middleware/passport/interactiveSession'

describe('account route authentication boundaries', () => {
    it('places invitation verification and resend behind their independent limiter', () => {
        const source = readFileSync(resolve(__dirname, 'account.route.ts'), 'utf8')

        expect(source).toMatch(/router\.post\('\/verify', adminVerificationRateLimiter, accountController\.verify\)/)
        expect(source).toMatch(
            /router\.post\('\/resend-verification', adminVerificationRateLimiter, accountController\.resendVerificationEmail\)/
        )
    })

    it('rejects API-key identities from interactive invite endpoints', () => {
        const req = {
            user: {
                activeOrganizationId: 'organization-id',
                activeWorkspaceId: 'workspace-id',
                permissions: ['workspace:add-user']
            }
        } as any
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        } as any
        const next = jest.fn()

        requireInteractiveSession(req, res, next)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })

    it('rejects API-key identities from interactive billing endpoints', () => {
        const req = {
            user: {
                activeOrganizationId: 'organization-id',
                activeWorkspaceId: 'workspace-id',
                permissions: ['chatflows:view']
            }
        } as any
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        } as any
        const next = jest.fn()

        requireOrganizationAdminSession(req, res, next)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })

    it('allows an interactive user session', () => {
        const req = {
            user: { id: 'user-id', isOrganizationAdmin: true },
            session: { passport: { user: { id: 'user-id' } } }
        } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any
        const next = jest.fn()

        requireOrganizationAdminSession(req, res, next)

        expect(next).toHaveBeenCalledTimes(1)
        expect(res.status).not.toHaveBeenCalled()
    })

    it('rejects a principal that is not backed by the same Passport session user', () => {
        const req = {
            user: { id: 'user-id' },
            session: { passport: { user: { id: 'different-user' } } }
        } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any
        const next = jest.fn()

        requireOrganizationAdminSession(req, res, next)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })

    it('rejects an interactive non-admin from organization billing', () => {
        const req = {
            user: { id: 'member-id', isOrganizationAdmin: false },
            session: { passport: { user: { id: 'member-id' } } }
        } as any
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as any
        const next = jest.fn()

        requireOrganizationAdminSession(req, res, next)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })
})
