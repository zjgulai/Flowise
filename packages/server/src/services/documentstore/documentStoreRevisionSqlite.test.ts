jest.mock('typeorm', () => jest.requireActual('typeorm/index.js'))

import { DataSource, EntitySchema } from 'typeorm'
import { StatusCodes } from 'http-status-codes'
import { AddDocumentStoreRevision1785697000000 } from '../../database/migrations/sqlite/1785697000000-AddDocumentStoreRevision'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { DocumentStoreFileChunk } from '../../database/entities/DocumentStoreFileChunk'
import { DocumentStoreStatus } from '../../Interface'
import { createDocumentStoreRevisionPredicate, updateExistingDocumentStore } from './documentStoreRevision'
import { createDocumentStoreOperationIdentity, createDocumentStoreVersionToken, parseDocumentStoreIfMatch } from './documentStoreVersion'

let mockServiceDataSource: any
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ AppDataSource: mockServiceDataSource })
}))

import documentStoreService from '.'

const operationIdentityFor = (revision: number) =>
    createDocumentStoreOperationIdentity(
        'store-1',
        'workspace-1',
        parseDocumentStoreIfMatch(
            createDocumentStoreVersionToken({
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: '22222222-2222-4222-8222-222222222222',
                revision
            })
        )
    )

interface DocumentStoreRevisionFixture {
    id: string
    workspaceId: string
    description: string | null
    generationId: string
    revision: number
}

const fixtureSchema = new EntitySchema<DocumentStoreRevisionFixture>({
    name: 'DocumentStoreRevisionFixture',
    tableName: 'document_store',
    columns: {
        id: { type: String, primary: true },
        workspaceId: { type: 'text' },
        description: { type: 'text', nullable: true },
        generationId: { type: String },
        revision: { type: Number, version: true, default: 1 }
    }
})

describe('document store integer revision CAS on SQLite', () => {
    let dataSource: DataSource

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [fixtureSchema],
            synchronize: false,
            logging: false
        })
        await dataSource.initialize()
        await dataSource.query(
            'CREATE TABLE "document_store" ("id" varchar PRIMARY KEY NOT NULL, "workspaceId" text NOT NULL, "description" text)'
        )
        await dataSource.query('INSERT INTO "document_store" ("id", "workspaceId", "description") VALUES (?, ?, ?)', [
            '11111111-1111-4111-8111-111111111111',
            'workspace-1',
            'Original'
        ])

        const queryRunner = dataSource.createQueryRunner()
        try {
            await new AddDocumentStoreRevision1785697000000().up(queryRunner)
        } finally {
            await queryRunner.release()
        }
    })

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('backfills legacy rows and advances the revision for save and update writers', async () => {
        const repository = dataSource.getRepository(fixtureSchema)
        const legacy = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })
        expect(legacy.generationId).toMatch(/^[0-9a-f-]{36}$/)
        expect(legacy.generationId).not.toBe(legacy.id)
        expect(legacy.revision).toBe(1)

        legacy.description = 'Saved'
        await repository.save(legacy)
        expect(legacy.revision).toBe(2)

        await repository.update({ id: legacy.id }, { description: 'Updated' })
        await expect(repository.findOneByOrFail({ id: legacy.id })).resolves.toMatchObject({
            description: 'Updated',
            revision: 3
        })
    })

    it('rejects a stale revision regardless of text collation and accepts the current revision', async () => {
        const repository = dataSource.getRepository(fixtureSchema)
        const stale = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })

        await repository.update({ id: stale.id }, { description: 'original' })
        const staleDelete = await repository.delete(createDocumentStoreRevisionPredicate(stale))
        expect(staleDelete.affected).toBe(0)

        const current = await repository.findOneByOrFail({ id: stale.id })
        const currentDelete = await repository.delete(createDocumentStoreRevisionPredicate(current))
        expect(currentDelete.affected).toBe(1)
        await expect(repository.findOneBy({ id: stale.id })).resolves.toBeNull()
    })

    it('rejects a stale update writer and keeps every accepted revision monotonic', async () => {
        const repository = dataSource.getRepository(fixtureSchema)
        const firstWriter = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })
        const staleWriter = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })

        await expect(
            updateExistingDocumentStore(repository as any, firstWriter as any, { description: 'First writer' }, 'stale writer')
        ).resolves.toMatchObject({ description: 'First writer', revision: 2 })
        await expect(
            updateExistingDocumentStore(repository as any, staleWriter as any, { description: 'Stale overwrite' }, 'stale writer')
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'stale writer' })

        const secondWriter = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })
        await expect(
            updateExistingDocumentStore(repository as any, secondWriter as any, { description: 'Second writer' })
        ).resolves.toMatchObject({ description: 'Second writer', revision: 3 })
        await expect(repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })).resolves.toMatchObject({
            description: 'Second writer',
            revision: 3
        })
    })

    it('rejects stale update and delete after delete then same-ID reinsert resets the revision', async () => {
        const repository = dataSource.getRepository(fixtureSchema)
        const staleLifetime = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })

        await expect(repository.delete(createDocumentStoreRevisionPredicate(staleLifetime))).resolves.toMatchObject({ affected: 1 })
        await repository.insert({
            id: staleLifetime.id,
            workspaceId: staleLifetime.workspaceId,
            description: 'Replacement lifetime',
            generationId: '22222222-2222-4222-8222-222222222222',
            revision: 1
        })

        await expect(
            updateExistingDocumentStore(
                repository as any,
                staleLifetime as any,
                { description: 'Stale lifetime overwrite' },
                'stale ABA writer'
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'stale ABA writer' })
        await expect(repository.delete(createDocumentStoreRevisionPredicate(staleLifetime))).resolves.toMatchObject({ affected: 0 })
        await expect(repository.findOneByOrFail({ id: staleLifetime.id })).resolves.toMatchObject({
            description: 'Replacement lifetime',
            generationId: '22222222-2222-4222-8222-222222222222',
            revision: 1
        })
    })

    it('rolls back an exact revision delete when a later transaction step fails', async () => {
        const repository = dataSource.getRepository(fixtureSchema)
        const current = await repository.findOneByOrFail({ id: '11111111-1111-4111-8111-111111111111' })

        await expect(
            dataSource.transaction(async (manager) => {
                const result = await manager.getRepository(fixtureSchema).delete(createDocumentStoreRevisionPredicate(current))
                expect(result.affected).toBe(1)
                throw new Error('synthetic rollback')
            })
        ).rejects.toThrow('synthetic rollback')

        await expect(repository.findOneBy({ id: current.id })).resolves.toMatchObject({ revision: 1 })
    })
})

const documentStoreSchema = new EntitySchema<DocumentStore>({
    name: 'DocumentStore',
    target: DocumentStore,
    tableName: 'document_store',
    columns: {
        id: { type: String, primary: true },
        name: { type: 'text' },
        description: { type: 'text', nullable: true },
        loaders: { type: 'text', nullable: true },
        whereUsed: { type: 'text', nullable: true },
        createdDate: { type: 'datetime', createDate: true },
        updatedDate: { type: 'datetime', updateDate: true },
        status: { type: 'text' },
        vectorStoreConfig: { type: 'text', nullable: true },
        embeddingConfig: { type: 'text', nullable: true },
        recordManagerConfig: { type: 'text', nullable: true },
        workspaceId: { type: 'text' },
        generationId: { type: String },
        revision: { type: Number, version: true, default: 1 }
    }
})

const chunkSchema = new EntitySchema<DocumentStoreFileChunk>({
    name: 'DocumentStoreFileChunk',
    target: DocumentStoreFileChunk,
    tableName: 'document_store_file_chunk',
    columns: {
        id: { type: String, primary: true },
        docId: { type: String },
        storeId: { type: String },
        chunkNo: { type: Number },
        pageContent: { type: 'text' },
        metadata: { type: 'text', nullable: true }
    }
})

describe('document store service CAS transaction on real SQLite', () => {
    let dataSource: DataSource

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [documentStoreSchema, chunkSchema],
            synchronize: true,
            logging: false
        })
        await dataSource.initialize()
        await dataSource.getRepository(DocumentStore).insert({
            id: 'store-1',
            name: 'Store',
            description: null,
            loaders: JSON.stringify([{ id: 'doc-1', totalChunks: 1, totalChars: 5 }]),
            whereUsed: '[]',
            status: DocumentStoreStatus.SYNC,
            vectorStoreConfig: null,
            embeddingConfig: null,
            recordManagerConfig: null,
            workspaceId: 'workspace-1',
            generationId: '22222222-2222-4222-8222-222222222222'
        } as any)
        await dataSource.getRepository(DocumentStoreFileChunk).insert({
            id: 'chunk-1',
            docId: 'doc-1',
            storeId: 'store-1',
            chunkNo: 1,
            pageContent: 'hello',
            metadata: '{}'
        })
    })

    afterEach(async () => {
        mockServiceDataSource = undefined
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('rolls back a chunk deletion when the parent revision CAS loses a race', async () => {
        mockServiceDataSource = {
            getRepository: dataSource.getRepository.bind(dataSource),
            transaction: async (callback: Parameters<DataSource['transaction']>[0]) => {
                await dataSource
                    .getRepository(DocumentStore)
                    .update({ id: 'store-1', workspaceId: 'workspace-1' }, { description: 'Concurrent writer' })
                return dataSource.transaction(callback as any)
            }
        }

        await expect(
            documentStoreService.deleteDocumentStoreFileChunk('store-1', 'doc-1', 'chunk-1', 'workspace-1', operationIdentityFor(1))
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document chunk changed concurrently' })

        await expect(dataSource.getRepository(DocumentStoreFileChunk).findOneBy({ id: 'chunk-1' })).resolves.toMatchObject({
            pageContent: 'hello'
        })
        await expect(dataSource.getRepository(DocumentStore).findOneByOrFail({ id: 'store-1' })).resolves.toMatchObject({
            description: 'Concurrent writer',
            revision: 2,
            loaders: JSON.stringify([{ id: 'doc-1', totalChunks: 1, totalChars: 5 }])
        })
    })

    it('atomically marks the materialization stale when a chunk is deleted', async () => {
        mockServiceDataSource = dataSource

        await expect(
            documentStoreService.deleteDocumentStoreFileChunk('store-1', 'doc-1', 'chunk-1', 'workspace-1', operationIdentityFor(1))
        ).resolves.toMatchObject({ versionToken: expect.any(String) })

        await expect(dataSource.getRepository(DocumentStoreFileChunk).findOneBy({ id: 'chunk-1' })).resolves.toBeNull()
        await expect(dataSource.getRepository(DocumentStore).findOneByOrFail({ id: 'store-1' })).resolves.toMatchObject({
            status: DocumentStoreStatus.STALE,
            revision: 2,
            loaders: JSON.stringify([{ id: 'doc-1', totalChunks: 0, totalChars: 0 }])
        })
    })

    it('atomically marks the materialization stale when a chunk is edited', async () => {
        mockServiceDataSource = dataSource

        await expect(
            documentStoreService.editDocumentStoreFileChunk(
                'store-1',
                'doc-1',
                'chunk-1',
                'updated content',
                { source: 'fixture' },
                'workspace-1',
                operationIdentityFor(1)
            )
        ).resolves.toMatchObject({ versionToken: expect.any(String) })

        await expect(dataSource.getRepository(DocumentStoreFileChunk).findOneByOrFail({ id: 'chunk-1' })).resolves.toMatchObject({
            pageContent: 'updated content',
            metadata: JSON.stringify({ source: 'fixture' })
        })
        await expect(dataSource.getRepository(DocumentStore).findOneByOrFail({ id: 'store-1' })).resolves.toMatchObject({
            status: DocumentStoreStatus.STALE,
            revision: 2,
            loaders: JSON.stringify([{ id: 'doc-1', totalChunks: 1, totalChars: 15 }])
        })
    })

    it('rejects a stale loader operation instead of adopting a freshly read revision', async () => {
        mockServiceDataSource = dataSource
        await dataSource
            .getRepository(DocumentStore)
            .update({ id: 'store-1', workspaceId: 'workspace-1' }, { description: 'Concurrent loader writer' })

        await expect(
            (documentStoreService.saveProcessingLoader as any)(
                dataSource,
                { storeId: 'store-1', id: 'doc-1' },
                'workspace-1',
                operationIdentityFor(1)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store loader changed concurrently' })

        await expect(dataSource.getRepository(DocumentStore).findOneByOrFail({ id: 'store-1' })).resolves.toMatchObject({
            description: 'Concurrent loader writer',
            revision: 2,
            loaders: JSON.stringify([{ id: 'doc-1', totalChunks: 1, totalChars: 5 }])
        })
    })
})
