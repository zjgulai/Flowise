import { MigrationInterface, QueryRunner } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'

export class AddDocumentStoreRevision1785697000001 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "document_store" ADD COLUMN IF NOT EXISTS "generationId" VARCHAR(36);')
        const legacyRows: Array<{ id: string }> =
            (await queryRunner.query('SELECT "id" FROM "document_store" WHERE "generationId" IS NULL;')) ?? []
        for (const row of legacyRows) {
            await queryRunner.query('UPDATE "document_store" SET "generationId" = $1 WHERE "id" = $2 AND "generationId" IS NULL;', [
                uuidv4(),
                row.id
            ])
        }
        await queryRunner.query('ALTER TABLE "document_store" ALTER COLUMN "generationId" SET NOT NULL;')
        await queryRunner.query('ALTER TABLE "document_store" ADD COLUMN IF NOT EXISTS "revision" INTEGER NOT NULL DEFAULT 1;')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('ALTER TABLE "document_store" DROP COLUMN "revision";')
        await queryRunner.query('ALTER TABLE "document_store" DROP COLUMN "generationId";')
    }
}
