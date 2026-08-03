import { Request, Response } from 'express'
import { DocumentStoreStatus } from '../../Interface'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { createDocumentStoreVersionToken } from '../../services/documentstore/documentStoreVersion'

const mockCreateDocumentStore = jest.fn()
const mockGetAllDocumentStores = jest.fn()
const mockGetDocumentStoreById = jest.fn()
const mockGetUsedChatflowNames = jest.fn()
const mockUpdateDocumentStore = jest.fn()

jest.mock('flowise-components', () => ({ removeSpecificFileFromUpload: jest.fn() }))
jest.mock('../../services/documentstore', () => ({
    __esModule: true,
    default: {
        createDocumentStore: (...args: unknown[]) => mockCreateDocumentStore(...args),
        getAllDocumentStores: (...args: unknown[]) => mockGetAllDocumentStores(...args),
        getDocumentStoreById: (...args: unknown[]) => mockGetDocumentStoreById(...args),
        getUsedChatflowNames: (...args: unknown[]) => mockGetUsedChatflowNames(...args),
        updateDocumentStore: (...args: unknown[]) => mockUpdateDocumentStore(...args)
    }
}))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import documentStoreController from '.'

const generationId = '11111111-1111-4111-8111-111111111111'
const versionIdentity = (revision: number) => ({
    id: 'store-1',
    workspaceId: 'workspace-1',
    generationId,
    revision
})

const entity = (revision = 1) =>
    Object.assign(new DocumentStore(), {
        id: 'store-1',
        name: 'Store',
        description: null,
        loaders: '[]',
        whereUsed: '[]',
        status: DocumentStoreStatus.SYNC,
        vectorStoreConfig: null,
        embeddingConfig: null,
        recordManagerConfig: null,
        workspaceId: 'workspace-1',
        generationId,
        revision,
        createdDate: new Date('2026-08-03T00:00:00.000Z'),
        updatedDate: new Date('2026-08-03T00:00:00.000Z')
    })

const response = () => ({ json: jest.fn() } as unknown as Response)
const expectSafeStoreResponse = (value: Record<string, unknown>, revision: number) => {
    expect(value.versionToken).toBe(createDocumentStoreVersionToken(versionIdentity(revision)))
    expect(value).not.toHaveProperty('generationId')
    expect(JSON.stringify(value)).not.toContain(generationId)
}

describe('document store controller response and concurrency contract', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCreateDocumentStore.mockResolvedValue(entity())
        mockGetAllDocumentStores.mockResolvedValue([entity()])
        mockGetDocumentStoreById.mockResolvedValue(entity())
        mockGetUsedChatflowNames.mockResolvedValue([])
        mockUpdateDocumentStore.mockResolvedValue(entity(2))
    })

    it('keeps create exempt from If-Match, ignores client identity, and returns only the opaque token', async () => {
        const req = {
            body: {
                id: 'attacker-id',
                name: 'Store',
                generationId: '99999999-9999-4999-8999-999999999999',
                revision: 999,
                versionToken: 'attacker-token',
                loaders: '[{"id":"attacker-loader"}]',
                whereUsed: '["attacker-flow"]',
                status: DocumentStoreStatus.UPSERTED,
                vectorStoreConfig: '{"name":"attacker-vector"}',
                embeddingConfig: '{"name":"attacker-embedding"}',
                recordManagerConfig: '{"name":"attacker-record-manager"}'
            },
            headers: {},
            user: { activeOrganizationId: 'org-1', activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = response()
        const next = jest.fn()

        await documentStoreController.createDocumentStore(req, res, next)

        expect(next).not.toHaveBeenCalled()
        const createInput = mockCreateDocumentStore.mock.calls[0][0]
        expect(createInput).toMatchObject({ name: 'Store', workspaceId: 'workspace-1' })
        expect(createInput).not.toHaveProperty('id')
        expect(createInput).not.toHaveProperty('generationId')
        expect(createInput).not.toHaveProperty('revision')
        expect(createInput).not.toHaveProperty('versionToken')
        expect(createInput).toMatchObject({
            loaders: '[]',
            whereUsed: '[]',
            status: DocumentStoreStatus.EMPTY_SYNC,
            vectorStoreConfig: null,
            embeddingConfig: null,
            recordManagerConfig: null
        })
        expectSafeStoreResponse((res.json as jest.Mock).mock.calls[0][0], 1)
    })

    it('does not expose generation identity in list or detail responses', async () => {
        const listReq = { query: {}, user: { activeWorkspaceId: 'workspace-1' } } as unknown as Request
        const listRes = response()
        await documentStoreController.getAllDocumentStores(listReq, listRes, jest.fn())

        const list = (listRes.json as jest.Mock).mock.calls[0][0] as Record<string, unknown>[]
        expect(list).toHaveLength(1)
        expectSafeStoreResponse(list[0], 1)

        const detailReq = { params: { id: 'store-1' }, user: { activeWorkspaceId: 'workspace-1' } } as unknown as Request
        const detailRes = response()
        await documentStoreController.getDocumentStoreById(detailReq, detailRes, jest.fn())

        expectSafeStoreResponse((detailRes.json as jest.Mock).mock.calls[0][0], 1)
    })

    it('uses only route, workspace, and If-Match identity for mutation and returns the advanced token', async () => {
        const req = {
            params: { id: 'store-1' },
            headers: { 'if-match': createDocumentStoreVersionToken(versionIdentity(1)) },
            body: {
                name: 'Renamed',
                id: 'attacker-id',
                workspaceId: 'attacker-workspace',
                generationId: '99999999-9999-4999-8999-999999999999',
                revision: 999,
                versionToken: 'attacker-token',
                loaders: '[{"id":"attacker-loader"}]',
                whereUsed: '["attacker-flow"]',
                status: DocumentStoreStatus.UPSERTED,
                vectorStoreConfig: '{"name":"attacker-vector"}',
                embeddingConfig: '{"name":"attacker-embedding"}',
                recordManagerConfig: '{"name":"attacker-record-manager"}'
            },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const res = response()
        const next = jest.fn()

        await documentStoreController.updateDocumentStore(req, res, next)

        expect(next).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStore).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'store-1', workspaceId: 'workspace-1', generationId, revision: 1 }),
            expect.objectContaining({ name: 'Renamed' }),
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
                revision: 1
            }
        )
        const mutableInput = mockUpdateDocumentStore.mock.calls[0][1]
        expect(mutableInput).not.toHaveProperty('id')
        expect(mutableInput).not.toHaveProperty('workspaceId')
        expect(mutableInput).not.toHaveProperty('generationId')
        expect(mutableInput).not.toHaveProperty('revision')
        expect(mutableInput).not.toHaveProperty('versionToken')
        expect(mutableInput).not.toHaveProperty('loaders')
        expect(mutableInput).not.toHaveProperty('whereUsed')
        expect(mutableInput).not.toHaveProperty('status')
        expect(mutableInput).not.toHaveProperty('vectorStoreConfig')
        expect(mutableInput).not.toHaveProperty('embeddingConfig')
        expect(mutableInput).not.toHaveProperty('recordManagerConfig')
        expectSafeStoreResponse((res.json as jest.Mock).mock.calls[0][0], 2)
    })

    it('fails a mutation with no If-Match before any service read or write', async () => {
        const req = {
            params: { id: 'store-1' },
            headers: {},
            body: { name: 'Renamed' },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const next = jest.fn()

        await documentStoreController.updateDocumentStore(req, response(), next)

        expect(mockGetDocumentStoreById).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStore).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toMatchObject({
            statusCode: 409,
            message: 'Document store version token is required or invalid'
        })
    })

    it('rejects a protected-field-only update instead of advancing the revision', async () => {
        const req = {
            params: { id: 'store-1' },
            headers: { 'if-match': createDocumentStoreVersionToken(versionIdentity(1)) },
            body: {
                loaders: '[]',
                whereUsed: '[]',
                status: DocumentStoreStatus.UPSERTED,
                vectorStoreConfig: '{"name":"attacker-vector"}'
            },
            user: { activeWorkspaceId: 'workspace-1' }
        } as unknown as Request
        const next = jest.fn()

        await documentStoreController.updateDocumentStore(req, response(), next)

        expect(mockGetDocumentStoreById).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStore).not.toHaveBeenCalled()
        expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400, message: 'Document store metadata update is required' })
    })
})
