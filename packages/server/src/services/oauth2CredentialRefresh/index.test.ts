const mockSecureAxiosRequest = jest.fn()
const mockCreateFixedOriginPolicy = jest.fn((origin: string) => ({
    enforceDefaultDenyList: true,
    validateUrl: (url: URL) => {
        if (url.origin !== origin) throw new Error('Request target is denied by policy.')
    }
}))
const mockDecryptCredentialData = jest.fn()
const mockEncryptCredentialData = jest.fn()
const mockFindOneBy = jest.fn()
const mockUpdate = jest.fn()

jest.mock('flowise-components', () => ({
    secureAxiosRequest: mockSecureAxiosRequest,
    createFixedOriginPolicy: mockCreateFixedOriginPolicy,
    StorageProviderFactory: {
        getProvider: () => ({ getLoggerTransports: () => [] })
    }
}))

jest.mock('../../utils', () => ({
    decryptCredentialData: mockDecryptCredentialData,
    encryptCredentialData: mockEncryptCredentialData
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => ({
                findOneBy: mockFindOneBy,
                update: mockUpdate
            })
        }
    })
}))

import { createWorkspaceOAuth2RefreshCapability, refreshOAuth2CredentialForWorkspace } from '.'

const baseCredentialData = {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refresh_token: 'refresh-token-fixture',
    accessTokenUrl: 'https://login.microsoftonline.com/token',
    expires_at: '2000-01-01T00:00:00.000Z'
}

describe('workspace-bound OAuth2 credential refresh capability', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        process.env.NODE_ENV = 'test'
        delete process.env.OAUTH2_SECURITY_CHECK
        delete process.env.OAUTH2_ALLOWED_TOKEN_DOMAINS
        delete process.env.HTTP_SECURITY_CHECK
        mockFindOneBy.mockImplementation(async ({ id, workspaceId }: { id: string; workspaceId: string }) => {
            if (id !== 'credential-a' || workspaceId !== 'workspace-a') return null
            return { id, workspaceId, encryptedData: 'encrypted-old' }
        })
        mockDecryptCredentialData.mockResolvedValue({ ...baseCredentialData })
        mockEncryptCredentialData.mockResolvedValue('encrypted-new')
        mockUpdate.mockResolvedValue({ affected: 1 })
        mockSecureAxiosRequest.mockResolvedValue({
            status: 200,
            data: {
                access_token: 'new-access-token',
                token_type: 'Bearer',
                expires_in: 3600,
                provider_debug: 'must-not-be-persisted'
            }
        })
    })

    it('scopes the lookup and optimistic update to the closed-over workspace', async () => {
        const refresh = createWorkspaceOAuth2RefreshCapability('workspace-a')

        const result = await refresh('credential-a')

        expect(mockFindOneBy).toHaveBeenCalledWith({ id: 'credential-a', workspaceId: 'workspace-a' })
        expect(mockSecureAxiosRequest).toHaveBeenCalledWith(
            expect.objectContaining({ method: 'POST', url: 'https://login.microsoftonline.com/token' }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: true, validateUrl: expect.any(Function) })
        )
        expect(mockCreateFixedOriginPolicy).toHaveBeenCalledWith('https://login.microsoftonline.com')
        expect(mockUpdate).toHaveBeenCalledWith(
            { id: 'credential-a', workspaceId: 'workspace-a', encryptedData: 'encrypted-old' },
            expect.objectContaining({ encryptedData: 'encrypted-new', updatedDate: expect.any(Date) })
        )
        expect(result).toEqual(
            expect.objectContaining({
                access_token: 'new-access-token',
                refresh_token: 'refresh-token-fixture',
                expires_at: expect.any(String)
            })
        )
        expect(result).not.toHaveProperty('provider_debug')
        expect(mockEncryptCredentialData.mock.calls[0][0]).not.toHaveProperty('provider_debug')
    })

    it('rejects cross-workspace credential IDs before any provider call', async () => {
        const refresh = createWorkspaceOAuth2RefreshCapability('workspace-b')

        await expect(refresh('credential-a')).rejects.toThrow('OAuth2 credential not found')

        expect(mockFindOneBy).toHaveBeenCalledWith({ id: 'credential-a', workspaceId: 'workspace-b' })
        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('keeps the endpoint allowlist and private-address policy fail closed when global checks are disabled', async () => {
        process.env.OAUTH2_SECURITY_CHECK = 'false'
        process.env.HTTP_SECURITY_CHECK = 'false'
        mockDecryptCredentialData.mockResolvedValueOnce({ ...baseCredentialData, accessTokenUrl: 'https://127.0.0.1/token' })

        await expect(refreshOAuth2CredentialForWorkspace('credential-a', 'workspace-a')).rejects.toThrow(
            'OAuth2 credential configuration is invalid'
        )

        expect(mockSecureAxiosRequest).not.toHaveBeenCalled()
        expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('binds redirects to the validated token endpoint origin so refresh secrets cannot cross origins', async () => {
        await refreshOAuth2CredentialForWorkspace('credential-a', 'workspace-a')

        const policy = mockSecureAxiosRequest.mock.calls[0][3]
        expect(() => policy.validateUrl(new URL('https://attacker.example/token'))).toThrow('Request target is denied by policy.')
        expect(() => policy.validateUrl(new URL('https://login.microsoftonline.com/redirected-token'))).not.toThrow()
    })

    it('coalesces concurrent refreshes for the same workspace and credential', async () => {
        let releaseProvider: ((value: unknown) => void) | undefined
        mockSecureAxiosRequest.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseProvider = resolve
                })
        )

        const first = refreshOAuth2CredentialForWorkspace('credential-a', 'workspace-a')
        const second = refreshOAuth2CredentialForWorkspace('credential-a', 'workspace-a')
        await Promise.resolve()
        await Promise.resolve()

        expect(mockSecureAxiosRequest).toHaveBeenCalledTimes(1)
        releaseProvider?.({ status: 200, data: { access_token: 'coalesced-token', expires_in: 120 } })

        const [firstResult, secondResult] = await Promise.all([first, second])
        expect(firstResult).toEqual(secondResult)
        expect(mockUpdate).toHaveBeenCalledTimes(1)
    })

    it('returns only a fixed error when the token endpoint leaks provider details', async () => {
        mockSecureAxiosRequest.mockRejectedValueOnce(new Error('refresh-token-fixture provider-secret'))

        const message = await refreshOAuth2CredentialForWorkspace('credential-a', 'workspace-a').then(
            () => '',
            (error) => String(error)
        )

        expect(message).toContain('OAuth2 credential refresh failed')
        expect(message).not.toContain('refresh-token-fixture')
        expect(message).not.toContain('provider-secret')
    })
})
