import { mariadbMigrations } from '../../database/migrations/mariadb'
import { AddDocumentStoreRevision1785697000003 } from '../../database/migrations/mariadb/1785697000003-AddDocumentStoreRevision'
import { mysqlMigrations } from '../../database/migrations/mysql'
import { AddDocumentStoreRevision1785697000002 } from '../../database/migrations/mysql/1785697000002-AddDocumentStoreRevision'
import { postgresMigrations } from '../../database/migrations/postgres'
import { AddDocumentStoreRevision1785697000001 } from '../../database/migrations/postgres/1785697000001-AddDocumentStoreRevision'
import { sqliteMigrations } from '../../database/migrations/sqlite'
import { AddDocumentStoreRevision1785697000000 } from '../../database/migrations/sqlite/1785697000000-AddDocumentStoreRevision'

const DIRECT_ID_ASSIGNMENT_PATTERN = /\bSET\s+["`]?generationId["`]?\s*=\s*["`]?id["`]?(?:\s|,|$)/i

describe('document store revision migrations', () => {
    const cases = [
        ['sqlite', AddDocumentStoreRevision1785697000000, sqliteMigrations],
        ['postgres', AddDocumentStoreRevision1785697000001, postgresMigrations],
        ['mysql', AddDocumentStoreRevision1785697000002, mysqlMigrations],
        ['mariadb', AddDocumentStoreRevision1785697000003, mariadbMigrations]
    ] as const

    it('distinguishes a forbidden identity copy from a parameterized update scoped by id', () => {
        expect('UPDATE "document_store" SET "generationId" = "id" WHERE "id" = $1').toMatch(DIRECT_ID_ASSIGNMENT_PATTERN)
        expect('UPDATE `document_store` SET `generationId` = id WHERE `id` = ?').toMatch(DIRECT_ID_ASSIGNMENT_PATTERN)
        expect('UPDATE "document_store" SET "generationId" = $1 WHERE "id" = $2').not.toMatch(DIRECT_ID_ASSIGNMENT_PATTERN)
        expect('UPDATE `document_store` SET `generationId` = ? WHERE `id` = ?').not.toMatch(DIRECT_ID_ASSIGNMENT_PATTERN)
    })

    it.each(cases)('registers generation ownership and a non-null integer revision for %s', async (_dialect, Migration, registry) => {
        const query = jest.fn(async (sql: string, _parameters?: unknown[]) =>
            /^SELECT /i.test(sql) ? [{ id: 'legacy-store' }] : undefined
        )
        const migration = new Migration()

        await migration.up({ query } as never)
        expect(registry).toContain(Migration)
        const upSql = query.mock.calls.map(([sql]) => sql).join('\n')
        expect(upSql).toMatch(/ALTER TABLE .*document_store.* ADD COLUMN .*generationId/i)
        const generationUpdate = query.mock.calls.find(([sql]) => /^UPDATE /i.test(sql))
        expect(generationUpdate?.[0]).not.toMatch(DIRECT_ID_ASSIGNMENT_PATTERN)
        expect(generationUpdate?.[1]).toEqual([
            expect.stringMatching(/^[0-9a-f-]{36}$/),
            'legacy-store',
            ...(_dialect === 'sqlite' ? [''] : [])
        ])
        expect(upSql).toMatch(/generationId.*NOT NULL/i)
        expect(upSql).toMatch(/ALTER TABLE .*document_store.* ADD COLUMN .*revision.* (?:INTEGER|INT) NOT NULL DEFAULT 1;/i)
        expect(upSql.indexOf('generationId')).toBeLessThan(upSql.search(/revision/i))

        query.mockClear()
        await migration.down({ query } as never)
        const downSql = query.mock.calls.map(([sql]) => sql).join('\n')
        expect(downSql).toMatch(/ALTER TABLE .*document_store.* DROP COLUMN .*revision/i)
        expect(downSql).toMatch(/ALTER TABLE .*document_store.* DROP COLUMN .*generationId/i)
    })
})
