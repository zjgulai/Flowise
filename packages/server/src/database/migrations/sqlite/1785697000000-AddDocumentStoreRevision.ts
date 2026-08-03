import { MigrationInterface, QueryRunner } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'

export class AddDocumentStoreRevision1785697000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "document_store" ADD COLUMN "generationId" varchar NOT NULL DEFAULT \'\';')
        const legacyRows: Array<{ id: string }> =
            (await queryRunner.query('SELECT "id" FROM "document_store" WHERE "generationId" = \'\';')) ?? []
        for (const row of legacyRows) {
            await queryRunner.query('UPDATE "document_store" SET "generationId" = ? WHERE "id" = ? AND "generationId" = ?;', [
                uuidv4(),
                row.id,
                ''
            ])
        }
        await queryRunner.query('ALTER TABLE "document_store" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "document_store" DROP COLUMN "revision";')
        await queryRunner.query('ALTER TABLE "document_store" DROP COLUMN "generationId";')
    }
}
