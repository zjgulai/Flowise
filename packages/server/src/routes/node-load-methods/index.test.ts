import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockGetSingleNodeAsyncOptions = jest.fn((_req: Request, res: Response) => res.json({ handler: 'options' }))

jest.mock('../../controllers/nodes', () => ({
    __esModule: true,
    default: {
        getSingleNodeAsyncOptions: (req: Request, res: Response) => mockGetSingleNodeAsyncOptions(req, res)
    }
}))

import nodeLoadMethodRouter, { NODE_LOAD_COARSE_PERMISSIONS } from '.'

const app = express()
    .use(express.json())
    .use((req: Request, _res: Response, next: NextFunction) => {
        const permissions = String(req.headers['x-test-permissions'] ?? '')
            .split(',')
            .filter(Boolean)
        req.user = {
            isOrganizationAdmin: req.headers['x-test-admin'] === 'true',
            permissions
        } as Request['user']
        next()
    })
    .use('/node-load-method', nodeLoadMethodRouter)

describe('node load method routes', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('requires both flow edit and assistants:view before the assistant service authorization', async () => {
        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-permissions', 'chatflows:view')
            .send({ loadMethod: 'listAssistants' })
            .expect(403)
        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-permissions', 'chatflows:view,assistants:view')
            .send({ loadMethod: 'listAssistants' })
            .expect(403)

        expect(mockGetSingleNodeAsyncOptions).not.toHaveBeenCalled()

        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-permissions', 'assistants:view')
            .send({ loadMethod: 'listAssistants' })
            .expect(403)
        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-permissions', 'chatflows:update')
            .send({ loadMethod: 'listAssistants' })
            .expect(403)

        expect(mockGetSingleNodeAsyncOptions).not.toHaveBeenCalled()

        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-permissions', 'chatflows:update,assistants:view')
            .send({ loadMethod: 'listAssistants' })
            .expect(200, { handler: 'options' })
        expect(mockGetSingleNodeAsyncOptions).toHaveBeenCalledTimes(1)
    })

    it('keeps every explicit capability permission atom reachable through the coarse OR gate', () => {
        expect(NODE_LOAD_COARSE_PERMISSIONS).toEqual(
            expect.arrayContaining([
                'chatflows:create',
                'chatflows:update',
                'agentflows:create',
                'agentflows:update',
                'documentStores:view',
                'documentStores:create',
                'documentStores:update',
                'documentStores:add-loader',
                'documentStores:upsert-config',
                'tools:view',
                'tools:create',
                'tools:update',
                'credentials:view'
            ])
        )
        expect(NODE_LOAD_COARSE_PERMISSIONS).not.toEqual(
            expect.arrayContaining(['assistants:view', 'assistants:create', 'assistants:update'])
        )
    })

    it('allows an organization admin and keeps unrelated node permissions unchanged', async () => {
        await request(app)
            .post('/node-load-method/openAIAssistant')
            .set('x-test-admin', 'true')
            .send({ loadMethod: 'listAssistants' })
            .expect(200, { handler: 'options' })

        await request(app)
            .post('/node-load-method/chatModel')
            .set('x-test-permissions', 'agentflows:create')
            .send({ loadMethod: 'listModels' })
            .expect(200, { handler: 'options' })

        expect(mockGetSingleNodeAsyncOptions).toHaveBeenCalledTimes(2)
    })

    it('fails closed without an authenticated user', async () => {
        const anonymousApp = express().use(express.json()).use('/node-load-method', nodeLoadMethodRouter)

        await request(anonymousApp).post('/node-load-method/openAIAssistant').send({ loadMethod: 'listAssistants' }).expect(403)
        expect(mockGetSingleNodeAsyncOptions).not.toHaveBeenCalled()
    })
})
