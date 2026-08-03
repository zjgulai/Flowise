jest.mock('typeorm', () => jest.requireActual('typeorm/index.js'))

import { DataSource } from 'typeorm'
import { v4 as uuidv4 } from 'uuid'

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn() } }))

import { Evaluation } from '../../database/entities/Evaluation'
import { EvaluationRun } from '../../database/entities/EvaluationRun'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import evaluationsService from '.'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

const OWNED_ID = '11111111-1111-4111-8111-111111111111'
const OWNED_VERSION_ID = '22222222-2222-4222-8222-222222222222'
const FOREIGN_ID = '33333333-3333-4333-8333-333333333333'
const WORKSPACE_ID = 'workspace-a'
const FOREIGN_WORKSPACE_ID = 'workspace-b'

const createEvaluation = async (dataSource: DataSource, id: string, workspaceId: string, name = 'Shared evaluation') => {
    const repository = dataSource.getRepository(Evaluation)
    await repository.save(
        repository.create({
            id,
            average_metrics: '{}',
            additionalConfig: '{}',
            name,
            evaluationType: 'benchmarking',
            chatflowId: '[]',
            chatflowName: '[]',
            datasetId: 'dataset-1',
            datasetName: 'Dataset',
            status: 'completed',
            workspaceId
        })
    )
}

const markEvaluationPending = async (dataSource: DataSource, id: string) => {
    await dataSource.getRepository(Evaluation).update({ id }, { status: 'pending' })
}

const createRun = async (dataSource: DataSource, id: string, evaluationId: string) => {
    const repository = dataSource.getRepository(EvaluationRun)
    await repository.save(
        repository.create({
            id,
            evaluationId,
            input: 'input',
            expectedOutput: 'expected',
            actualOutput: 'actual',
            metrics: '{}',
            llmEvaluators: '[]',
            evaluators: '[]',
            errors: ''
        })
    )
}

describe('evaluation bulk deletion safety', () => {
    let dataSource: DataSource

    beforeEach(async () => {
        dataSource = new DataSource({
            type: 'sqlite',
            database: ':memory:',
            entities: [Evaluation, EvaluationRun],
            synchronize: true,
            logging: false
        })
        await dataSource.initialize()
        mockGetRunningExpressApp.mockReturnValue({ AppDataSource: dataSource })
    })

    afterEach(async () => {
        jest.clearAllMocks()
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it('rejects a non-array ids value', async () => {
        await expect(evaluationsService.patchDeleteEvaluations(OWNED_ID, WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects an empty ids array', async () => {
        await expect(evaluationsService.patchDeleteEvaluations([], WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects more than 500 ids', async () => {
        const ids = Array.from({ length: 501 }, () => uuidv4())

        await expect(evaluationsService.patchDeleteEvaluations(ids, WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects an all-version expansion beyond 500 before deleting anything', async () => {
        const repository = dataSource.getRepository(Evaluation)
        const rows = Array.from({ length: 501 }, (_, index) =>
            repository.create({
                id: index === 0 ? OWNED_ID : uuidv4(),
                average_metrics: '{}',
                additionalConfig: '{}',
                name: 'Oversized version set',
                evaluationType: 'benchmarking',
                chatflowId: '[]',
                chatflowName: '[]',
                datasetId: 'dataset-1',
                datasetName: 'Dataset',
                status: 'completed',
                workspaceId: WORKSPACE_ID
            })
        )
        await repository.save(rows)

        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, true)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
        expect(await repository.count()).toBe(501)
    })

    it('rejects a non-UUID id', async () => {
        await expect(evaluationsService.patchDeleteEvaluations(['not-an-evaluation-id'], WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects duplicate ids', async () => {
        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID, OWNED_ID], WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects a string false all-version flag', async () => {
        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, 'false')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid evaluation deletion request'
        })
    })

    it('rejects the complete batch before deletion when one id belongs to another workspace', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await createEvaluation(dataSource, FOREIGN_ID, FOREIGN_WORKSPACE_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)

        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID, FOREIGN_ID], WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluation deletion targets were not found'
        })

        expect(await dataSource.getRepository(Evaluation).count()).toBe(2)
        expect(await dataSource.getRepository(EvaluationRun).count()).toBe(1)
    })

    it('rolls back child deletion when the parent affected count changes concurrently', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)
        await dataSource.query('CREATE TRIGGER ignore_evaluation_delete BEFORE DELETE ON "evaluation" BEGIN SELECT RAISE(IGNORE); END')

        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, false)).rejects.toMatchObject({
            statusCode: 409,
            message: 'Evaluation deletion changed concurrently'
        })

        expect(await dataSource.getRepository(Evaluation).count()).toBe(1)
        expect(await dataSource.getRepository(EvaluationRun).count()).toBe(1)
    })

    it('rejects single deletion while the background evaluation writer is still pending', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await markEvaluationPending(dataSource, OWNED_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)

        await expect(evaluationsService.deleteEvaluation(OWNED_ID, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: 409,
            message: 'Running evaluations cannot be deleted'
        })

        expect(await dataSource.getRepository(Evaluation).findOneBy({ id: OWNED_ID })).toEqual(
            expect.objectContaining({ id: OWNED_ID, status: 'pending' })
        )
        expect(await dataSource.getRepository(EvaluationRun).find()).toEqual([expect.objectContaining({ evaluationId: OWNED_ID })])
    })

    it('rejects an all-version deletion when an expanded sibling still has a background writer', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await createEvaluation(dataSource, OWNED_VERSION_ID, WORKSPACE_ID)
        await markEvaluationPending(dataSource, OWNED_VERSION_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)

        await expect(evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, true)).rejects.toMatchObject({
            statusCode: 409,
            message: 'Running evaluations cannot be deleted'
        })

        expect(await dataSource.getRepository(Evaluation).count()).toBe(2)
        expect(await dataSource.getRepository(EvaluationRun).find()).toEqual([expect.objectContaining({ evaluationId: OWNED_ID })])
    })

    it('deletes only the requested evaluation version and its runs', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await createEvaluation(dataSource, OWNED_VERSION_ID, WORKSPACE_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)
        await createRun(dataSource, '55555555-5555-4555-8555-555555555555', OWNED_VERSION_ID)

        await evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, false)

        expect(await dataSource.getRepository(Evaluation).findBy({ workspaceId: WORKSPACE_ID })).toEqual([
            expect.objectContaining({ id: OWNED_VERSION_ID })
        ])
        expect(await dataSource.getRepository(EvaluationRun).find()).toEqual([expect.objectContaining({ evaluationId: OWNED_VERSION_ID })])
    })

    it('deletes every same-name version only in the active workspace', async () => {
        await createEvaluation(dataSource, OWNED_ID, WORKSPACE_ID)
        await createEvaluation(dataSource, OWNED_VERSION_ID, WORKSPACE_ID)
        await createEvaluation(dataSource, FOREIGN_ID, FOREIGN_WORKSPACE_ID)
        await createRun(dataSource, '44444444-4444-4444-8444-444444444444', OWNED_ID)
        await createRun(dataSource, '55555555-5555-4555-8555-555555555555', OWNED_VERSION_ID)
        await createRun(dataSource, '66666666-6666-4666-8666-666666666666', FOREIGN_ID)

        await evaluationsService.patchDeleteEvaluations([OWNED_ID], WORKSPACE_ID, true)

        expect(await dataSource.getRepository(Evaluation).find()).toEqual([
            expect.objectContaining({ id: FOREIGN_ID, workspaceId: FOREIGN_WORKSPACE_ID })
        ])
        expect(await dataSource.getRepository(EvaluationRun).find()).toEqual([expect.objectContaining({ evaluationId: FOREIGN_ID })])
    })
})
