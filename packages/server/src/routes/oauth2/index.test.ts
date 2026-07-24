import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockCredentialRepository = {
    findOneBy: jest.fn(),
    update: jest.fn()
}
const mockSecureAxiosRequest = jest.fn()
const mockDecryptCredentialData = jest.fn()
const mockEncryptCredentialData = jest.fn()
const mockReloadSessionAuthorization = jest.fn()

jest.mock('flowise-components', () => ({
    secureAxiosRequest: mockSecureAxiosRequest,
    StorageProviderFactory: {
        getProvider: () => ({ getLoggerTransports: () => [] })
    }
}))

jest.mock('../../utils', () => ({
    decryptCredentialData: mockDecryptCredentialData,
    encryptCredentialData: mockEncryptCredentialData
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => ({
        AppDataSource: {
            getRepository: jest.fn(() => mockCredentialRepository)
        }
    }))
}))

jest.mock('../../enterprise/utils/tenantRequestGuards', () => ({
    getActiveWorkspaceIdForRequest: (req: Request) => req.user?.activeWorkspaceId,
    getLoggedInUser: (req: Request) => req.user
}))

jest.mock('../../enterprise/middleware/passport/AuthStrategy', () => ({
    reloadSessionAuthorization: mockReloadSessionAuthorization
}))

jest.mock('./templates', () => ({
    generateErrorPage: (title: string, message: string) => `error:${title}:${message}`,
    generateSuccessPage: (credentialId: string) => `success:${credentialId}`
}))

import oauth2Router from './index'
import { WHITELIST_URLS } from '../../utils/constants'

type Principal = {
    id?: string
    activeOrganizationId: string
    activeWorkspaceId: string
    isOrganizationAdmin: boolean
    permissions: string[]
}

type TestSession = {
    save: (callback: (error?: unknown) => void) => void
    [key: string]: unknown
}

const credential = {
    id: 'credential-1',
    workspaceId: 'workspace-1',
    encryptedData: 'encrypted-config'
}

const credentialConfig = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    authorizationUrl: 'https://login.microsoftonline.com/authorize',
    accessTokenUrl: 'https://login.microsoftonline.com/token',
    redirect_uri: 'https://flowise.example.invalid/api/v1/oauth2-credential/callback',
    scope: 'User.Read'
}

const permittedUser: Principal = {
    id: 'user-1',
    activeOrganizationId: 'organization-1',
    activeWorkspaceId: 'workspace-1',
    isOrganizationAdmin: false,
    permissions: ['credentials:update']
}

function clonePrincipal(principal: Principal): Principal {
    return { ...principal, permissions: [...principal.permissions] }
}

function buildApp() {
    const sessions = new Map<string, TestSession>()
    const principals = new Map<string, Principal>()
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
        const sessionId = req.get('x-test-session') || 'session-a'
        let session = sessions.get(sessionId)
        if (!session) {
            session = { save: (callback) => callback() }
            sessions.set(sessionId, session)
        }
        Object.defineProperty(req, 'sessionID', { configurable: true, value: sessionId })
        if (principals.get(sessionId)?.id) session.passport = { user: principals.get(sessionId) }
        else delete session.passport
        Object.defineProperty(req, 'session', { configurable: true, value: session })
        req.user = principals.get(sessionId) as Request['user']
        next()
    })
    app.use('/oauth2-credential', oauth2Router)
    app.use((error: { statusCode?: number; status?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
        res.status(error.statusCode || error.status || 500).json({ message: error.message })
    })
    return { app, sessions, principals }
}

async function authorize(app: express.Application, sessionId = 'session-a') {
    const response = await request(app).post('/oauth2-credential/authorize/credential-1').set('x-test-session', sessionId)
    const state = new URL(response.body.authorizationUrl).searchParams.get('state')
    return { response, state }
}

describe('OAuth2 state and credential authorization boundaries', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCredentialRepository.findOneBy.mockImplementation(async (where: { id?: string; workspaceId?: string }) => {
            if (where.id !== credential.id) return null
            if (where.workspaceId && where.workspaceId !== credential.workspaceId) return null
            return credential
        })
        mockCredentialRepository.update.mockResolvedValue(undefined)
        mockDecryptCredentialData.mockResolvedValue(credentialConfig)
        mockEncryptCredentialData.mockResolvedValue('encrypted-updated-config')
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: { access_token: 'synthetic-access-token', refresh_token: 'synthetic-refresh-token', expires_in: 3600 }
        })
        mockReloadSessionAuthorization.mockImplementation(async (user) => user)
    })

    it('keeps the provider callback session-aware while refresh stays behind global JWT authorization', () => {
        expect(WHITELIST_URLS).toContain('/api/v1/oauth2-credential/callback')
        expect(WHITELIST_URLS).not.toContain('/api/v1/oauth2-credential/refresh')
    })

    it('rejects a callback when live authorization reload no longer accepts the session', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)
        mockReloadSessionAuthorization.mockResolvedValueOnce(undefined)

        const response = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(response.status).toBe(401)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('checks callback permission from the live authorization result, not the serialized snapshot', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)
        mockReloadSessionAuthorization.mockResolvedValueOnce({ ...clonePrincipal(permittedUser), permissions: [] })

        const response = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(response.status).toBe(403)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('requires an interactive user with credentials:update to authorize', async () => {
        const { app, principals } = buildApp()
        principals.set('low-scope', {
            ...clonePrincipal(permittedUser),
            id: undefined,
            permissions: ['chatflows:view']
        })

        const response = await request(app).post('/oauth2-credential/authorize/credential-1').set('x-test-session', 'low-scope')

        expect(response.status).toBe(403)
        expect(mockCredentialRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('returns a high-entropy opaque state instead of exposing the credential id', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))

        const { response, state } = await authorize(app)

        expect(response.status).toBe(200)
        expect(state).toBeTruthy()
        expect(state).not.toBe(credential.id)
        expect(state).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    })

    it('does not allow a shared workspace to initiate a token-writing OAuth flow', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', { ...clonePrincipal(permittedUser), activeWorkspaceId: 'workspace-2' })

        const response = await request(app).post('/oauth2-credential/authorize/credential-1')

        expect(response.status).toBe(404)
        expect(mockCredentialRepository.findOneBy).toHaveBeenCalledWith({ id: credential.id, workspaceId: 'workspace-2' })
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('rejects a callback from a different session without exchanging or writing tokens', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        principals.set('session-b', clonePrincipal(permittedUser))
        const { state } = await authorize(app, 'session-a')

        const response = await request(app)
            .get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)
            .set('x-test-session', 'session-b')

        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('rejects an uninitiated callback without token exchange or database writes', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))

        const response = await request(app).get('/oauth2-credential/callback?code=synthetic-code&state=uninitiated-state')

        expect(response.status).toBe(400)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('rejects a callback after the initiating session switches workspace', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)
        principals.set('session-a', { ...clonePrincipal(permittedUser), activeWorkspaceId: 'workspace-2' })

        const response = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('consumes state once and rejects replay without a second database write', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)

        const first = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)
        const replay = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(first.status).toBe(200)
        expect(replay.status).toBeGreaterThanOrEqual(400)
        expect(replay.status).toBeLessThan(500)
        expect(mockSecureAxiosRequest).toHaveBeenCalledTimes(1)
        expect(mockCredentialRepository.update).toHaveBeenCalledTimes(1)
    })

    it('rejects expired state before token exchange or database write', async () => {
        const now = jest.spyOn(Date, 'now')
        now.mockReturnValue(1_000)
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)
        now.mockReturnValue(1_000 + 11 * 60 * 1000)

        const response = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(response.status).toBeGreaterThanOrEqual(400)
        expect(response.status).toBeLessThan(500)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
        now.mockRestore()
    })

    it('consumes provider-error callbacks so their state cannot later be replayed', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        const { state } = await authorize(app)

        const denied = await request(app).get(`/oauth2-credential/callback?error=access_denied&state=${state}`)
        const replay = await request(app).get(`/oauth2-credential/callback?code=synthetic-code&state=${state}`)

        expect(denied.status).toBe(400)
        expect(replay.status).toBeGreaterThanOrEqual(400)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('requires credentials:update and active-workspace access to refresh tokens', async () => {
        const { app, principals } = buildApp()
        principals.set('low-scope', {
            ...clonePrincipal(permittedUser),
            id: undefined,
            permissions: ['chatflows:view']
        })

        const response = await request(app).post('/oauth2-credential/refresh/credential-1').set('x-test-session', 'low-scope')

        expect(response.status).toBe(403)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })

    it('refreshes only a credential accessible from the authenticated active workspace', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', clonePrincipal(permittedUser))
        mockDecryptCredentialData.mockResolvedValueOnce({ ...credentialConfig, refresh_token: 'synthetic-refresh-token' })

        const response = await request(app).post('/oauth2-credential/refresh/credential-1')

        expect(response.status).toBe(200)
        expect(mockCredentialRepository.findOneBy).toHaveBeenCalledWith({ id: credential.id, workspaceId: credential.workspaceId })
        expect(mockSecureAxiosRequest).toHaveBeenCalledTimes(1)
        expect(mockCredentialRepository.update).toHaveBeenCalledTimes(1)
    })

    it('rejects refresh when the credential is outside the active workspace and is not shared', async () => {
        const { app, principals } = buildApp()
        principals.set('session-a', { ...clonePrincipal(permittedUser), activeWorkspaceId: 'workspace-2' })

        const response = await request(app).post('/oauth2-credential/refresh/credential-1')

        expect(response.status).toBe(404)
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockCredentialRepository.update).not.toHaveBeenCalled()
    })
})
