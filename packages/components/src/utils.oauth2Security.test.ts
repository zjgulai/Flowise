import fs from 'fs'
import { refreshOAuth2Token } from './utils'

describe('refreshOAuth2Token in-process capability security', () => {
    const credentialId = '00000000-0000-4000-8000-000000000001'
    const expiredCredential = {
        expires_at: '2000-01-01T00:00:00.000Z',
        refresh_token: 'refresh-token-fixture'
    }

    it('uses only the server-injected workspace-bound capability and ignores request-derived baseURL', async () => {
        const updatedCredential = { access_token: 'updated-access-token', expires_at: '2999-01-01T00:00:00.000Z' }
        const refreshOAuth2Credential = jest.fn().mockResolvedValue(updatedCredential)
        const options = {
            baseURL: 'https://attacker.example',
            workspaceId: 'workspace-a',
            refreshOAuth2Credential
        }

        await expect(refreshOAuth2Token(credentialId, expiredCredential, options)).resolves.toBe(updatedCredential)
        expect(refreshOAuth2Credential).toHaveBeenCalledTimes(1)
        expect(refreshOAuth2Credential).toHaveBeenCalledWith(credentialId)
    })

    it('fails closed without a capability instead of calling an authenticated HTTP route', async () => {
        await expect(
            refreshOAuth2Token(credentialId, expiredCredential, {
                baseURL: 'https://attacker.example',
                workspaceId: 'workspace-a'
            })
        ).rejects.toThrow('Failed to refresh access token. Please re-authorize the credential.')
    })

    it('redacts capability errors and rejects malformed capability results', async () => {
        const leakingCapability = jest.fn().mockRejectedValue(new Error('refresh-token-fixture from workspace-b'))
        const malformedCapability = jest.fn().mockResolvedValue('Bearer leaked-key')

        const firstError = await refreshOAuth2Token(credentialId, expiredCredential, {
            refreshOAuth2Credential: leakingCapability
        }).then(
            () => '',
            (error) => String(error)
        )
        const secondError = await refreshOAuth2Token(credentialId, expiredCredential, {
            refreshOAuth2Credential: malformedCapability
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(firstError).toBe('Error: Failed to refresh access token. Please re-authorize the credential.')
        expect(secondError).toBe('Error: Failed to refresh access token. Please re-authorize the credential.')
        expect(firstError).not.toContain('refresh-token-fixture')
        expect(secondError).not.toContain('leaked-key')
    })

    it('does not call the capability while the token is still outside the refresh buffer', async () => {
        const credentialData = { ...expiredCredential, expires_at: '2999-01-01T00:00:00.000Z' }
        const refreshOAuth2Credential = jest.fn()

        await expect(refreshOAuth2Token(credentialId, credentialData, { refreshOAuth2Credential })).resolves.toBe(credentialData)
        expect(refreshOAuth2Credential).not.toHaveBeenCalled()
    })

    it.each(['not-a-date', '', Number.NaN])('fails closed for an invalid explicit expiry: %p', async (expires_at) => {
        const refreshOAuth2Credential = jest.fn()
        const credentialData = { ...expiredCredential, expires_at }

        const errorText = await refreshOAuth2Token(credentialId, credentialData, { refreshOAuth2Credential }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: OAuth credential expiry is invalid. Please re-authorize the credential.')
        if (String(expires_at)) expect(errorText).not.toContain(String(expires_at))
        expect(refreshOAuth2Credential).not.toHaveBeenCalled()
    })

    it('contains no HTTP refresh endpoint, localhost fallback, or options.baseURL dependency', () => {
        const source = fs.readFileSync(require.resolve('./utils'), 'utf8')
        const start = source.indexOf('export const refreshOAuth2Token')
        const end = source.indexOf('export const stripHTMLFromToolInput', start)
        const refreshSource = source.slice(start, end)

        expect(refreshSource).toContain('options.refreshOAuth2Credential')
        expect(refreshSource).not.toContain('/oauth2-credential/refresh')
        expect(refreshSource).not.toContain('options.baseURL')
        expect(refreshSource).not.toContain('localhost')
    })
})
