import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const permissionMiddleware = (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    const permissions = String(req.headers['x-test-permissions'] ?? '').split(',')
    if (permissions.includes(permission)) return next()
    return res.status(403).json({ message: 'forbidden' })
}

jest.mock('../../enterprise/rbac/PermissionCheck', () => ({
    checkPermission: jest.fn((permission: string) => permissionMiddleware(permission))
}))

jest.mock('../../controllers/openai-assistants', () => ({
    __esModule: true,
    default: {
        getAllOpenaiAssistants: (_req: Request, res: Response) => res.json({ handler: 'list' }),
        getSingleOpenaiAssistant: (_req: Request, res: Response) => res.json({ handler: 'get' })
    }
}))

import openaiAssistantsRouter from '.'

const app = express().use('/openai-assistants', openaiAssistantsRouter)

describe('OpenAI Assistant routes', () => {
    it('requires assistants:view and credentials:view for listing assistants', async () => {
        await request(app).get('/openai-assistants').set('x-test-permissions', 'assistants:create').expect(403)
        await request(app).get('/openai-assistants').set('x-test-permissions', 'assistants:view').expect(403)
        await request(app).get('/openai-assistants').set('x-test-permissions', 'credentials:view').expect(403)

        const response = await request(app)
            .get('/openai-assistants')
            .set('x-test-permissions', 'assistants:view,credentials:view')
            .expect(200)
        expect(response.body).toEqual({ handler: 'list' })
    })

    it('requires assistants:view and credentials:view for retrieving an assistant', async () => {
        await request(app).get('/openai-assistants/asst-1').set('x-test-permissions', 'assistants:update').expect(403)
        await request(app).get('/openai-assistants/asst-1').set('x-test-permissions', 'assistants:view').expect(403)
        await request(app).get('/openai-assistants/asst-1').set('x-test-permissions', 'credentials:view').expect(403)

        const response = await request(app)
            .get('/openai-assistants/asst-1')
            .set('x-test-permissions', 'assistants:view,credentials:view')
            .expect(200)
        expect(response.body).toEqual({ handler: 'get' })
    })
})
