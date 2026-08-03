import { getOrCreateStoredSecret } from '../../utils'
import { createHash, timingSafeEqual } from 'crypto'
import logger from '../../utils/logger'

/**
 * Weak default values that were previously hardcoded when env vars were not set.
 * If the user has set a var to one of these, we treat it as "not set" and use file/AWS storage instead.
 */
const WEAK_DEFAULTS: Record<string, string> = {
    JWT_AUTH_TOKEN_SECRET: 'AABBCCDDAABBCCDDAABBCCDDAABBCCDDAABBCCDD',
    JWT_REFRESH_TOKEN_SECRET: 'AABBCCDDAABBCCDDAABBCCDDAABBCCDDAABBCCDD',
    EXPRESS_SESSION_SECRET: 'flowise',
    TOKEN_HASH_SECRET: 'popcorn'
}

let tokenHashSecret: string | undefined
let expressSessionSecret: string | undefined
let jwtAuthTokenSecret: string | undefined
let jwtRefreshTokenSecret: string | undefined
let jwtIssuer: string | undefined
let jwtAudience: string | undefined

const NOT_INITIALIZED = 'Auth secrets not initialized. Call initAuthSecrets() first.'
const TOKEN_HASH_FINGERPRINT_DOMAIN = 'flowise/auth/token-hash-secret/fingerprint/v1\0'
const MIN_AUTH_SECRET_BYTES = 32

const normalizeRequiredAuthSecret = (envKey: keyof typeof WEAK_DEFAULTS, value: string): string => {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (Buffer.byteLength(normalized, 'utf8') < MIN_AUTH_SECRET_BYTES || normalized === WEAK_DEFAULTS[envKey]) {
        throw new Error(`${envKey} must be at least ${MIN_AUTH_SECRET_BYTES} bytes and must not use a legacy default`)
    }
    return normalized
}

export const createTokenHashSecretFingerprint = (secret: string): string =>
    createHash('sha256').update(TOKEN_HASH_FINGERPRINT_DOMAIN, 'utf8').update(secret, 'utf8').digest('hex')

const verifyTokenHashSecretFingerprint = (fingerprint: string): void => {
    const expected = process.env.TOKEN_HASH_SECRET_FINGERPRINT
    if (!expected) return
    const normalizedExpected = expected.trim().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(normalizedExpected)) throw new Error('TOKEN_HASH_SECRET_FINGERPRINT must be a SHA-256 hex value')
    const expectedBytes = Buffer.from(normalizedExpected, 'hex')
    const actualBytes = Buffer.from(fingerprint, 'hex')
    if (!timingSafeEqual(expectedBytes, actualBytes)) throw new Error('TOKEN_HASH_SECRET fingerprint mismatch')
}

/**
 * Initialize auth secrets from env (backwards compat) → AWS Secrets Manager → filesystem.
 * Each secret is generated with crypto.randomBytes(32) when created (or 'flowise' for JWT_ISSUER/JWT_AUDIENCE).
 * Call once after getEncryptionKey() in initDatabase().
 */
export async function initAuthSecrets(): Promise<void> {
    const resolvedTokenHashSecret = normalizeRequiredAuthSecret(
        'TOKEN_HASH_SECRET',
        await getOrCreateStoredSecret({
            envKey: 'TOKEN_HASH_SECRET',
            fileName: 'token_hash_secret.key',
            awsSecretIdSuffix: 'TokenHashSecret',
            weakDefault: WEAK_DEFAULTS.TOKEN_HASH_SECRET
        })
    )
    const tokenHashFingerprint = createTokenHashSecretFingerprint(resolvedTokenHashSecret)
    verifyTokenHashSecretFingerprint(tokenHashFingerprint)

    const resolvedExpressSessionSecret = normalizeRequiredAuthSecret(
        'EXPRESS_SESSION_SECRET',
        await getOrCreateStoredSecret({
            envKey: 'EXPRESS_SESSION_SECRET',
            fileName: 'express_session_secret.key',
            awsSecretIdSuffix: 'ExpressSessionSecret',
            weakDefault: WEAK_DEFAULTS.EXPRESS_SESSION_SECRET
        })
    )

    const resolvedJwtAuthTokenSecret = normalizeRequiredAuthSecret(
        'JWT_AUTH_TOKEN_SECRET',
        await getOrCreateStoredSecret({
            envKey: 'JWT_AUTH_TOKEN_SECRET',
            fileName: 'jwt_auth_token_secret.key',
            awsSecretIdSuffix: 'JWTAuthTokenSecret',
            weakDefault: WEAK_DEFAULTS.JWT_AUTH_TOKEN_SECRET
        })
    )

    const resolvedJwtRefreshTokenSecret = normalizeRequiredAuthSecret(
        'JWT_REFRESH_TOKEN_SECRET',
        await getOrCreateStoredSecret({
            envKey: 'JWT_REFRESH_TOKEN_SECRET',
            fileName: 'jwt_refresh_token_secret.key',
            awsSecretIdSuffix: 'JWTRefreshTokenSecret',
            weakDefault: WEAK_DEFAULTS.JWT_REFRESH_TOKEN_SECRET
        })
    )

    const resolvedJwtIssuer = await getOrCreateStoredSecret({
        envKey: 'JWT_ISSUER',
        fileName: 'jwt_issuer.key',
        awsSecretIdSuffix: 'JWTIssuer',
        defaultValueForNew: 'flowise'
    })

    const resolvedJwtAudience = await getOrCreateStoredSecret({
        envKey: 'JWT_AUDIENCE',
        fileName: 'jwt_audience.key',
        awsSecretIdSuffix: 'JWTAudience',
        defaultValueForNew: 'flowise'
    })

    // Commit the new set only after every required secret passes validation.
    tokenHashSecret = resolvedTokenHashSecret
    expressSessionSecret = resolvedExpressSessionSecret
    jwtAuthTokenSecret = resolvedJwtAuthTokenSecret
    jwtRefreshTokenSecret = resolvedJwtRefreshTokenSecret
    jwtIssuer = resolvedJwtIssuer
    jwtAudience = resolvedJwtAudience
    logger.info(`auth_secret_fingerprint tokenHash=${tokenHashFingerprint}`)
}

export function getTokenHashSecret(): string {
    if (tokenHashSecret === undefined) throw new Error(NOT_INITIALIZED)
    return tokenHashSecret
}

export function getExpressSessionSecret(): string {
    if (expressSessionSecret === undefined) throw new Error(NOT_INITIALIZED)
    return expressSessionSecret
}

export function getJWTAuthTokenSecret(): string {
    if (jwtAuthTokenSecret === undefined) throw new Error(NOT_INITIALIZED)
    return jwtAuthTokenSecret
}

export function getJWTRefreshTokenSecret(): string {
    if (jwtRefreshTokenSecret === undefined) throw new Error(NOT_INITIALIZED)
    return jwtRefreshTokenSecret
}

export function getJWTIssuer(): string {
    if (jwtIssuer === undefined) throw new Error(NOT_INITIALIZED)
    return jwtIssuer
}

export function getJWTAudience(): string {
    if (jwtAudience === undefined) throw new Error(NOT_INITIALIZED)
    return jwtAudience
}
