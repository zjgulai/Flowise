import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const permissionMiddleware = (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    const permissions = String(req.headers['x-test-permissions'] ?? '').split(',')
    if (permissions.includes(permission)) return next()
    return res.status(403).json({ message: 'forbidden' })
}

jest.mock('../../enterprise/rbac/PermissionCheck', () => ({
    checkPermission: jest.fn((permission: string) => permissionMiddleware(permission)),
    checkAnyPermission: jest.fn((permissions: string) => (req: Request, res: Response, next: NextFunction) => {
        const granted = String(req.headers['x-test-permissions'] ?? '').split(',')
        if (permissions.split(',').some((permission) => granted.includes(permission))) return next()
        return res.status(403).json({ message: 'forbidden' })
    })
}))

jest.mock('../../controllers/assistants', () => ({
    __esModule: true,
    default: {
        createAssistant: (_req: Request, res: Response) => res.json({ handler: 'create' }),
        deleteAssistant: (_req: Request, res: Response) => res.json({ handler: 'delete' }),
        deleteCustomAssistant: (_req: Request, res: Response) => res.json({ handler: 'custom-delete' }),
        getAllAssistants: (_req: Request, res: Response) => res.json({ handler: 'list' }),
        getAssistantById: (_req: Request, res: Response) => res.json({ handler: 'get' }),
        updateAssistant: (_req: Request, res: Response) => res.json({ handler: 'update' }),
        getCustomAssistantFlow: (_req: Request, res: Response) => res.json({ handler: 'custom-flow' }),
        saveCustomAssistant: (_req: Request, res: Response) => res.json({ handler: 'custom-save' }),
        getChatModels: (_req: Request, res: Response) => res.json({ handler: 'models' }),
        getDocumentStores: (_req: Request, res: Response) => res.json({ handler: 'stores' }),
        getTools: (_req: Request, res: Response) => res.json({ handler: 'tools' }),
        generateAssistantInstruction: (_req: Request, res: Response) => res.json({ handler: 'generate' })
    }
}))

import assistantsRouter from '.'

const app = express().use(express.json()).use('/assistants', assistantsRouter)

describe('scoped custom-assistant routes', () => {
    it('requires assistants:view and does not accept generic flow permissions for linked-flow reads', async () => {
        await request(app).get('/assistants/assistant-1/custom-flow').set('x-test-permissions', 'chatflows:view').expect(403)
        const response = await request(app)
            .get('/assistants/assistant-1/custom-flow')
            .set('x-test-permissions', 'assistants:view')
            .expect(200)
        expect(response.body).toEqual({ handler: 'custom-flow' })
    })

    it('requires assistants:update and does not accept generic flow permissions for atomic saves', async () => {
        await request(app)
            .put('/assistants/assistant-1/custom-save')
            .set('x-test-permissions', 'chatflows:update,agentflows:update')
            .send({})
            .expect(403)
        await request(app).put('/assistants/assistant-1/custom-save').set('x-test-permissions', 'assistants:create').send({}).expect(403)
        const response = await request(app)
            .put('/assistants/assistant-1/custom-save')
            .set('x-test-permissions', 'assistants:update')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'custom-save' })
    })

    it('requires assistants:delete for the aggregate custom deletion seam', async () => {
        await request(app)
            .post('/assistants/assistant-1/custom-delete')
            .set('x-test-permissions', 'chatflows:delete,agentflows:delete')
            .send({})
            .expect(403)
        const response = await request(app)
            .post('/assistants/assistant-1/custom-delete')
            .set('x-test-permissions', 'assistants:delete')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'custom-delete' })
    })

    it('does not let create-only users update an existing assistant', async () => {
        await request(app).put('/assistants/assistant-1').set('x-test-permissions', 'assistants:create').send({}).expect(403)

        const response = await request(app)
            .put('/assistants/assistant-1')
            .set('x-test-permissions', 'assistants:update')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'update' })
    })

    it('never dispatches the snapshot-bound custom-save path to the generic update handler', async () => {
        const customResponse = await request(app)
            .put('/assistants/assistant-1/custom-save')
            .set('x-test-permissions', 'assistants:update')
            .send({ expectedAssistant: {}, expectedChatflow: {} })
            .expect(200)
        const genericResponse = await request(app)
            .put('/assistants/assistant-1')
            .set('x-test-permissions', 'assistants:update')
            .send({ details: '{"name":"generic"}' })
            .expect(200)

        expect(customResponse.body).toEqual({ handler: 'custom-save' })
        expect(genericResponse.body).toEqual({ handler: 'update' })
    })

    it.each([
        ['/assistants/components/chatmodels', 'models'],
        ['/assistants/components/docstores', 'stores'],
        ['/assistants/components/tools', 'tools']
    ])('protects component metadata at %s with an assistant permission', async (path, handler) => {
        await request(app).get(path).set('x-test-permissions', 'chatflows:view').expect(403)

        const response = await request(app).get(path).set('x-test-permissions', 'assistants:create').expect(200)
        expect(response.body).toEqual({ handler })
    })

    it('requires create or update permission before invoking the instruction Provider path', async () => {
        await request(app).post('/assistants/generate/instruction').set('x-test-permissions', 'assistants:view').send({}).expect(403)

        await request(app).post('/assistants/generate/instruction').set('x-test-permissions', 'assistants:update').send({}).expect(403)

        const response = await request(app)
            .post('/assistants/generate/instruction')
            .set('x-test-permissions', 'assistants:update,credentials:view')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'generate' })
    })
})
