import { createHash } from 'crypto'
import { StatusCodes } from 'http-status-codes'
import { DocumentStoreDTO, DocumentStoreStatus } from '../../Interface'
import { DocumentStore } from '../../database/entities/DocumentStore'
import {
    createDocumentStoreOperationIdentity,
    createDocumentStoreVersionToken,
    createDocumentStoreVersionTokenFromClaim,
    initializeDocumentStoreVersionTokenKey,
    matchesDocumentStoreVersionClaim,
    parseDocumentStoreIfMatch
} from './documentStoreVersion'

const testTokenHashSecret = 'flowise-jest-document-store-version-token-secret-v1'
const generationId = '11111111-1111-4111-8111-111111111111'
const identity = (overrides: Partial<{ id: string; workspaceId: string; generationId: string; revision: number }> = {}) => ({
    id: 'store-1',
    workspaceId: 'workspace-1',
    generationId,
    revision: 42,
    ...overrides
})

describe('document store opaque version token', () => {
    it('fails closed before initialization and rejects weak or in-process replacement secrets', () => {
        jest.isolateModules(() => {
            const isolatedVersion = jest.requireActual<typeof import('./documentStoreVersion')>('./documentStoreVersion')
            expect(() => isolatedVersion.createDocumentStoreVersionToken(identity())).toThrow(
                'Document store version token secret is not initialized or invalid'
            )
        })

        expect(() => initializeDocumentStoreVersionTokenKey('too-short')).toThrow(
            'Document store version token secret is not initialized or invalid'
        )
        expect(() => initializeDocumentStoreVersionTokenKey(testTokenHashSecret)).not.toThrow()
        expect(() => initializeDocumentStoreVersionTokenKey('a-different-document-store-token-secret-that-is-long-enough')).toThrow(
            'Document store version token secret cannot be changed after initialization'
        )
    })

    it('round trips one canonical strong ETag without reversibly exposing generation identity', () => {
        const token = createDocumentStoreVersionToken(identity())
        const claim = parseDocumentStoreIfMatch(token)

        expect(token).toMatch(/^"ds-v1\.42\.[A-Za-z0-9_-]{43}"$/)
        expect(claim).toEqual({ revision: 42, generationFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) })
        expect(matchesDocumentStoreVersionClaim(identity(), claim)).toBe(true)
        expect(token).not.toContain(generationId)
        expect(JSON.stringify(claim)).not.toContain(generationId)
        expect(Buffer.from(claim.generationFingerprint, 'base64url').toString('utf8')).not.toContain(generationId)
        expect(createDocumentStoreVersionTokenFromClaim(claim)).toBe(token)
    })

    it('keeps upgraded legacy rows with a bounded non-UUID generation identity operable', () => {
        const legacyIdentity = identity({ id: 'store-1', generationId: 'store-1', revision: 1 })
        const token = createDocumentStoreVersionToken(legacyIdentity)
        const claim = parseDocumentStoreIfMatch(token)

        expect(matchesDocumentStoreVersionClaim(legacyIdentity, claim)).toBe(true)
        expect(token).not.toContain('store-1')
    })

    it.each(['', 'x'.repeat(257), 'legacy\0generation'])('rejects an unsafe generation identity (%p)', (unsafeGenerationId) => {
        expect(() => createDocumentStoreVersionToken(identity({ generationId: unsafeGenerationId }))).toThrow(
            expect.objectContaining({
                statusCode: StatusCodes.CONFLICT,
                message: 'Document store version token is required or invalid'
            })
        )
    })

    it('keys otherwise identical fingerprints with the independently derived server secret', () => {
        const tokenForSecret = (secret: string): string => {
            let token = ''
            jest.isolateModules(() => {
                const isolatedVersion = jest.requireActual<typeof import('./documentStoreVersion')>('./documentStoreVersion')
                isolatedVersion.initializeDocumentStoreVersionTokenKey(secret)
                token = isolatedVersion.createDocumentStoreVersionToken(identity())
            })
            return token
        }

        expect(tokenForSecret('first-independent-document-store-token-secret-v1')).not.toBe(
            tokenForSecret('second-independent-document-store-token-secret-v1')
        )
    })

    it('binds the digest to route, workspace, generation and revision and rotates after every accepted write', () => {
        const token = createDocumentStoreVersionToken(identity())

        expect(createDocumentStoreVersionToken(identity({ revision: 43 }))).not.toBe(token)
        expect(createDocumentStoreVersionToken(identity({ generationId: '22222222-2222-4222-8222-222222222222' }))).not.toBe(token)
        expect(createDocumentStoreVersionToken(identity({ id: 'store-2' }))).not.toBe(token)
        expect(createDocumentStoreVersionToken(identity({ workspaceId: 'workspace-2' }))).not.toBe(token)
    })

    it('does not allow an old claim to forge a future revision by editing the visible revision', () => {
        const token = createDocumentStoreVersionToken(identity())
        const tampered = token.replace('ds-v1.42.', 'ds-v1.43.')
        const claim = parseDocumentStoreIfMatch(tampered)

        expect(claim.revision).toBe(43)
        expect(matchesDocumentStoreVersionClaim(identity({ revision: 43 }), claim)).toBe(false)
        expect(
            matchesDocumentStoreVersionClaim(identity({ generationId: '22222222-2222-4222-8222-222222222222', revision: 43 }), claim)
        ).toBe(false)
    })

    it('accepts only the server-derived digest as an ownership claim, not a syntactically valid fabricated token', () => {
        const fabricated = parseDocumentStoreIfMatch('"ds-v1.42.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"')

        expect(matchesDocumentStoreVersionClaim(identity(), fabricated)).toBe(false)
    })

    it('rejects an offline SHA forgery when a legacy migration makes generationId equal the public id', () => {
        const publicIdentity = identity({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            generationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            revision: 1
        })
        const hash = createHash('sha256')
        for (const value of [
            'flowise/document-store/version-token/fingerprint/v1',
            publicIdentity.workspaceId,
            publicIdentity.id,
            publicIdentity.generationId,
            String(publicIdentity.revision)
        ]) {
            hash.update(String(Buffer.byteLength(value, 'utf8')))
            hash.update(':')
            hash.update(value, 'utf8')
        }

        const offlineForgery = parseDocumentStoreIfMatch(`"ds-v1.1.${hash.digest('base64url')}"`)
        expect(matchesDocumentStoreVersionClaim(publicIdentity, offlineForgery)).toBe(false)
    })

    it.each([
        undefined,
        ['"ds-v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"'],
        '*',
        'W/"ds-v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        '"ds-v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "ds-v1.1.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"',
        'ds-v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        '"ds-v2.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        '"ds-v1.0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        '"ds-v1.1.!AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        '"ds-v1.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
        `"ds-v1.${Number.MAX_SAFE_INTEGER}0.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"`,
        `"ds-v1.${Buffer.from(`${generationId}:1`).toString('base64url')}"`
    ])('rejects missing, weak, multiple, legacy-reversible or malformed validators (%p)', (token) => {
        expect(() => parseDocumentStoreIfMatch(token)).toThrow(
            expect.objectContaining({
                statusCode: StatusCodes.CONFLICT,
                message: 'Document store version token is required or invalid'
            })
        )
    })

    it('builds the queue operation identity only from route scope and a one-way claim', () => {
        const operationIdentity = createDocumentStoreOperationIdentity(
            'store-1',
            'workspace-1',
            parseDocumentStoreIfMatch(createDocumentStoreVersionToken(identity({ revision: 3 })))
        )

        expect(operationIdentity).toEqual({
            id: 'store-1',
            workspaceId: 'workspace-1',
            generationFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            revision: 3
        })
        expect(operationIdentity).not.toHaveProperty('generationId')
        expect(JSON.stringify(operationIdentity)).not.toContain(generationId)
    })

    it('returns a DTO token without exposing the generation identity', () => {
        const entity = Object.assign(new DocumentStore(), {
            ...identity({ revision: 7 }),
            name: 'Store',
            description: null,
            loaders: '[]',
            whereUsed: '[]',
            status: DocumentStoreStatus.SYNC,
            vectorStoreConfig: null,
            embeddingConfig: null,
            recordManagerConfig: null,
            createdDate: new Date('2026-08-03T00:00:00.000Z'),
            updatedDate: new Date('2026-08-03T00:00:00.000Z')
        })

        const response = DocumentStoreDTO.fromEntity(entity) as unknown as Record<string, unknown>
        expect(response.versionToken).toBe(createDocumentStoreVersionToken(identity({ revision: 7 })))
        expect(response).not.toHaveProperty('generationId')
        expect(JSON.stringify(response)).not.toContain(generationId)
    })
})
