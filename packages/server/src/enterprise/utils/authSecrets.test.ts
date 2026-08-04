import { getOrCreateStoredSecret } from '../../utils'
import logger from '../../utils/logger'
import {
    createTokenHashSecretFingerprint,
    getExpressSessionSecret,
    getJWTAuthTokenSecret,
    getJWTRefreshTokenSecret,
    getTokenHashSecret,
    initAuthSecrets
} from './authSecrets'

jest.mock('../../utils', () => ({ getOrCreateStoredSecret: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn() } }))

const mockGetOrCreateStoredSecret = getOrCreateStoredSecret as jest.Mock
const TOKEN_HASH_SECRET = '0123456789abcdef0123456789abcdef'
const VALID_SECRETS: Record<string, string> = {
    TOKEN_HASH_SECRET,
    EXPRESS_SESSION_SECRET: 'session-secret-0123456789abcdef0123456789',
    JWT_AUTH_TOKEN_SECRET: 'jwt-auth-secret-0123456789abcdef0123456789',
    JWT_REFRESH_TOKEN_SECRET: 'jwt-refresh-secret-0123456789abcdef0123456789',
    JWT_ISSUER: 'flowise',
    JWT_AUDIENCE: 'flowise'
}

describe('auth secret startup fingerprint', () => {
    const previousFingerprint = process.env.TOKEN_HASH_SECRET_FINGERPRINT

    beforeEach(() => {
        delete process.env.TOKEN_HASH_SECRET_FINGERPRINT
        jest.clearAllMocks()
        mockGetOrCreateStoredSecret.mockImplementation(async ({ envKey }: { envKey: string }) => VALID_SECRETS[envKey])
    })

    afterAll(() => {
        if (previousFingerprint === undefined) delete process.env.TOKEN_HASH_SECRET_FINGERPRINT
        else process.env.TOKEN_HASH_SECRET_FINGERPRINT = previousFingerprint
    })

    it('emits a stable, domain-separated fingerprint without logging the secret', async () => {
        const fingerprint = createTokenHashSecretFingerprint(TOKEN_HASH_SECRET)
        await initAuthSecrets()

        expect(fingerprint).toMatch(/^[0-9a-f]{64}$/)
        expect(fingerprint).not.toContain(TOKEN_HASH_SECRET)
        expect(logger.info).toHaveBeenCalledWith(`auth_secret_fingerprint tokenHash=${fingerprint}`)
        expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(TOKEN_HASH_SECRET)
    })

    it('accepts the configured fingerprint and fails startup on invalid or mismatched values', async () => {
        process.env.TOKEN_HASH_SECRET_FINGERPRINT = createTokenHashSecretFingerprint(TOKEN_HASH_SECRET)
        await expect(initAuthSecrets()).resolves.toBeUndefined()

        process.env.TOKEN_HASH_SECRET_FINGERPRINT = 'not-a-fingerprint'
        await expect(initAuthSecrets()).rejects.toThrow('TOKEN_HASH_SECRET_FINGERPRINT must be a SHA-256 hex value')

        process.env.TOKEN_HASH_SECRET_FINGERPRINT = '0'.repeat(64)
        await expect(initAuthSecrets()).rejects.toThrow('TOKEN_HASH_SECRET fingerprint mismatch')
    })

    it.each(['TOKEN_HASH_SECRET', 'EXPRESS_SESSION_SECRET', 'JWT_AUTH_TOKEN_SECRET', 'JWT_REFRESH_TOKEN_SECRET'])(
        'rejects an undersized %s returned by any configured secret source without partially replacing the active set',
        async (envKey) => {
            await initAuthSecrets()
            const activeSet = [getTokenHashSecret(), getExpressSessionSecret(), getJWTAuthTokenSecret(), getJWTRefreshTokenSecret()]
            mockGetOrCreateStoredSecret.mockImplementation(async ({ envKey: requestedKey }: { envKey: string }) =>
                requestedKey === envKey ? 'x' : VALID_SECRETS[requestedKey]
            )

            await expect(initAuthSecrets()).rejects.toThrow(`${envKey} must be at least 32 bytes`)
            expect([getTokenHashSecret(), getExpressSessionSecret(), getJWTAuthTokenSecret(), getJWTRefreshTokenSecret()]).toEqual(
                activeSet
            )
        }
    )

    it.each([
        ['TOKEN_HASH_SECRET', '  popcorn\n'],
        ['EXPRESS_SESSION_SECRET', ' flowise '],
        ['JWT_AUTH_TOKEN_SECRET', ' AABBCCDDAABBCCDDAABBCCDDAABBCCDDAABBCCDD\n'],
        ['JWT_REFRESH_TOKEN_SECRET', '\tAABBCCDDAABBCCDDAABBCCDDAABBCCDDAABBCCDD ']
    ])('rejects a normalized legacy default for %s regardless of its source', async (envKey, value) => {
        mockGetOrCreateStoredSecret.mockImplementation(async ({ envKey: requestedKey }: { envKey: string }) =>
            requestedKey === envKey ? value : VALID_SECRETS[requestedKey]
        )

        await expect(initAuthSecrets()).rejects.toThrow(`${envKey} must be at least 32 bytes and must not use a legacy default`)
    })
})
