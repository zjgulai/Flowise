import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockIsOutdated = jest.fn((_req: Request, res: Response) => res.json({ handler: 'is-outdated' }))
const mockCreateEvaluation = jest.fn((_req: Request, res: Response) => res.json({ handler: 'create' }))
const mockRunAgain = jest.fn((_req: Request, res: Response) => res.json({ handler: 'run-again' }))

jest.mock('../../controllers/evaluations', () => ({
    __esModule: true,
    default: {
        getAllEvaluations: jest.fn(),
        getEvaluation: jest.fn(),
        deleteEvaluation: jest.fn(),
        createEvaluation: (req: Request, res: Response) => mockCreateEvaluation(req, res),
        isOutdated: (req: Request, res: Response) => mockIsOutdated(req, res),
        runAgain: (req: Request, res: Response) => mockRunAgain(req, res),
        getVersions: jest.fn(),
        patchDeleteEvaluations: jest.fn()
    }
}))

import evaluationsRouter from '.'

const app = express()
    .use(express.json())
    .use((req: Request, _res: Response, next: NextFunction) => {
        req.user = {
            isOrganizationAdmin: false,
            permissions: String(req.headers['x-test-permissions'] ?? '')
                .split(',')
                .filter(Boolean)
        } as Request['user']
        next()
    })
    .use('/evaluations', evaluationsRouter)

describe('evaluation route permissions', () => {
    beforeEach(() => jest.clearAllMocks())

    it('requires evaluations:view for the is-outdated workspace read', async () => {
        await request(app).get('/evaluations/is-outdated/evaluation-a').expect(403)
        await request(app).get('/evaluations/is-outdated/evaluation-a').set('x-test-permissions', 'evaluations:create').expect(403)
        expect(mockIsOutdated).not.toHaveBeenCalled()

        await request(app)
            .get('/evaluations/is-outdated/evaluation-a')
            .set('x-test-permissions', 'evaluations:view')
            .expect(200, { handler: 'is-outdated' })
        expect(mockIsOutdated).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['create', '/evaluations', 'evaluations:create', mockCreateEvaluation],
        ['run again', '/evaluations/run-again/evaluation-a', 'evaluations:run', mockRunAgain]
    ])('requires credentials:view conjunctively for Provider-backed %s', async (_name, path, operationPermission, handler) => {
        await request(app).post(path).set('x-test-permissions', operationPermission).send({}).expect(403)
        expect(handler).not.toHaveBeenCalled()

        await request(app).post(path).set('x-test-permissions', `${operationPermission},credentials:view`).send({}).expect(200)
        expect(handler).toHaveBeenCalledTimes(1)
    })
})
