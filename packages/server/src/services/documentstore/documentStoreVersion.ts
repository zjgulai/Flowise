import { createHmac, timingSafeEqual } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { v4 as uuidv4 } from 'uuid'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

const DOCUMENT_STORE_VERSION_TOKEN_PREFIX = 'ds-v1.'
const DOCUMENT_STORE_VERSION_TOKEN_PATTERN = /^"ds-v1\.([1-9][0-9]*)\.([A-Za-z0-9_-]{43})"$/
const DOCUMENT_STORE_GENERATION_MAX_LENGTH = 256
const DOCUMENT_STORE_VERSION_TOKEN_ERROR = 'Document store version token is required or invalid'
const DOCUMENT_STORE_VERSION_KEY_DERIVATION_CONTEXT = 'flowise/document-store/version-token/key/v1'
const DOCUMENT_STORE_VERSION_FINGERPRINT_DOMAIN = 'flowise/document-store/version-token/fingerprint/v1'
const DOCUMENT_STORE_VERSION_SECRET_MIN_BYTES = 32
const DOCUMENT_STORE_VERSION_SECRET_ERROR = 'Document store version token secret is not initialized or invalid'

let documentStoreVersionKey: Buffer | undefined

export interface DocumentStoreVersionIdentity {
    id: string
    workspaceId: string
    generationId: string
    revision: number
}

export interface DocumentStoreVersionClaim {
    generationFingerprint: string
    revision: number
}

export interface DocumentStoreOperationIdentity extends DocumentStoreVersionClaim {
    id: string
    workspaceId: string
}

export const createDocumentStoreGenerationId = (): string => uuidv4()

/**
 * Derives a purpose-specific HMAC key from TOKEN_HASH_SECRET.
 *
 * Initialization is idempotent only for the same secret. A process cannot
 * silently switch keys because doing so would split HA nodes and invalidate
 * in-flight HTTP/queue claims. Planned secret rotation therefore requires a
 * coordinated restart and deliberately invalidates outstanding ETags.
 */
export const initializeDocumentStoreVersionTokenKey = (tokenHashSecret: string): void => {
    if (typeof tokenHashSecret !== 'string' || Buffer.byteLength(tokenHashSecret, 'utf8') < DOCUMENT_STORE_VERSION_SECRET_MIN_BYTES) {
        throw new Error(DOCUMENT_STORE_VERSION_SECRET_ERROR)
    }

    const derivedKey = createHmac('sha256', Buffer.from(tokenHashSecret, 'utf8'))
        .update(DOCUMENT_STORE_VERSION_KEY_DERIVATION_CONTEXT, 'utf8')
        .digest()

    if (documentStoreVersionKey) {
        const matchesInitializedKey = timingSafeEqual(documentStoreVersionKey, derivedKey)
        derivedKey.fill(0)
        if (!matchesInitializedKey) {
            throw new Error('Document store version token secret cannot be changed after initialization')
        }
        return
    }

    documentStoreVersionKey = derivedKey
}

const getDocumentStoreVersionKey = (): Buffer => {
    if (!documentStoreVersionKey) throw new Error(DOCUMENT_STORE_VERSION_SECRET_ERROR)
    return documentStoreVersionKey
}

const failInvalidDocumentStoreVersionToken = (): never => {
    throw new InternalFlowiseError(StatusCodes.CONFLICT, DOCUMENT_STORE_VERSION_TOKEN_ERROR)
}

const assertSafeRevision = (revision: number): void => {
    if (!Number.isSafeInteger(revision) || revision < 1) failInvalidDocumentStoreVersionToken()
}

const assertValidDocumentStoreVersionIdentity = (identity: DocumentStoreVersionIdentity): void => {
    if (
        typeof identity.id !== 'string' ||
        identity.id.length === 0 ||
        identity.id.includes('\0') ||
        typeof identity.workspaceId !== 'string' ||
        identity.workspaceId.length === 0 ||
        identity.workspaceId.includes('\0') ||
        typeof identity.generationId !== 'string' ||
        identity.generationId.length === 0 ||
        identity.generationId.length > DOCUMENT_STORE_GENERATION_MAX_LENGTH ||
        identity.generationId.includes('\0')
    ) {
        failInvalidDocumentStoreVersionToken()
    }
    assertSafeRevision(identity.revision)
}

const decodeFingerprint = (fingerprint: string): Buffer => {
    try {
        const bytes = Buffer.from(fingerprint, 'base64url')
        if (bytes.length !== 32 || bytes.toString('base64url') !== fingerprint) failInvalidDocumentStoreVersionToken()
        return bytes
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        return failInvalidDocumentStoreVersionToken()
    }
}

const assertValidDocumentStoreVersionClaim = (claim: DocumentStoreVersionClaim): void => {
    assertSafeRevision(claim.revision)
    if (typeof claim.generationFingerprint !== 'string') failInvalidDocumentStoreVersionToken()
    decodeFingerprint(claim.generationFingerprint)
}

const updateLengthPrefixed = (hmac: ReturnType<typeof createHmac>, value: string): void => {
    hmac.update(String(Buffer.byteLength(value, 'utf8')))
    hmac.update(':')
    hmac.update(value, 'utf8')
}

/**
 * Computes a one-way, revision- and route-bound claim. The server-only
 * generation UUID is never serialized into an HTTP or queue token.
 */
export const createDocumentStoreGenerationFingerprint = (identity: DocumentStoreVersionIdentity): string => {
    assertValidDocumentStoreVersionIdentity(identity)
    const hmac = createHmac('sha256', getDocumentStoreVersionKey())
    for (const value of [
        DOCUMENT_STORE_VERSION_FINGERPRINT_DOMAIN,
        identity.workspaceId,
        identity.id,
        identity.generationId,
        String(identity.revision)
    ]) {
        updateLengthPrefixed(hmac, value)
    }
    return hmac.digest('base64url')
}

const formatDocumentStoreVersionClaim = (claim: DocumentStoreVersionClaim): string => {
    assertValidDocumentStoreVersionClaim(claim)
    return `"${DOCUMENT_STORE_VERSION_TOKEN_PREFIX}${claim.revision}.${claim.generationFingerprint}"`
}

/** Returns a strong opaque ETag without exposing the generation UUID. */
export const createDocumentStoreVersionToken = (identity: DocumentStoreVersionIdentity): string =>
    formatDocumentStoreVersionClaim({
        revision: identity.revision,
        generationFingerprint: createDocumentStoreGenerationFingerprint(identity)
    })

/** Re-serializes an already validated claim, for accepted (not final) queue receipts. */
export const createDocumentStoreVersionTokenFromClaim = (claim: DocumentStoreVersionClaim): string => formatDocumentStoreVersionClaim(claim)

/**
 * Strictly accepts one strong ETag. Wildcards, weak validators, lists,
 * unquoted values, malformed fingerprints and unsafe revisions fail closed.
 */
export const parseDocumentStoreIfMatch = (header: string | string[] | undefined): DocumentStoreVersionClaim => {
    if (typeof header !== 'string') return failInvalidDocumentStoreVersionToken()
    const match = DOCUMENT_STORE_VERSION_TOKEN_PATTERN.exec(header)
    if (!match) return failInvalidDocumentStoreVersionToken()
    const claim = { revision: Number(match[1]), generationFingerprint: match[2] }
    assertValidDocumentStoreVersionClaim(claim)
    return claim
}

export const createDocumentStoreOperationIdentity = (
    id: string,
    workspaceId: string,
    claim: DocumentStoreVersionClaim
): DocumentStoreOperationIdentity => {
    if (typeof id !== 'string' || !id || typeof workspaceId !== 'string' || !workspaceId) failInvalidDocumentStoreVersionToken()
    assertValidDocumentStoreVersionClaim(claim)
    return { id, workspaceId, generationFingerprint: claim.generationFingerprint, revision: claim.revision }
}

/** Constant-time verification against the server-loaded immutable generation. */
export const matchesDocumentStoreVersionClaim = (identity: DocumentStoreVersionIdentity, claim: DocumentStoreVersionClaim): boolean => {
    try {
        if (identity.revision !== claim.revision) return false
        const expected = decodeFingerprint(createDocumentStoreGenerationFingerprint(identity))
        const actual = decodeFingerprint(claim.generationFingerprint)
        return expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch {
        return false
    }
}
