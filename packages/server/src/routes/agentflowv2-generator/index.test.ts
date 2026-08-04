import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

jest.mock('../../enterprise/rbac/PermissionCheck', () => ({
    checkPermission: jest.fn((permission: string) => (req: Request, res: Response, next: NextFunction) => {
        const granted = String(req.headers['x-test-permissions'] ?? '').split(',')
        if (granted.includes(permission)) return next()
        return res.status(403).json({ message: 'forbidden' })
    }),
    checkAnyPermission: jest.fn((permissions: string) => (req: Request, res: Response, next: NextFunction) => {
        const granted = String(req.headers['x-test-permissions'] ?? '').split(',')
        if (permissions.split(',').some((permission) => granted.includes(permission))) return next()
        return res.status(403).json({ message: 'forbidden' })
    })
}))

jest.mock('../../controllers/agentflowv2-generator', () => ({
    __esModule: true,
    default: {
        generateAgentflowv2: (_req: Request, res: Response) => res.json({ handler: 'generate' })
    }
}))

import agentflowv2GeneratorRouter from '.'

const app = express().use(express.json()).use('/agentflowv2-generator', agentflowv2GeneratorRouter)

describe('Agentflow V2 generator route', () => {
    it('requires an Agentflow create or update permission before Provider execution', async () => {
        await request(app).post('/agentflowv2-generator/generate').set('x-test-permissions', 'agentflows:view').send({}).expect(403)

        await request(app).post('/agentflowv2-generator/generate').set('x-test-permissions', 'agentflows:update').send({}).expect(403)

        const response = await request(app)
            .post('/agentflowv2-generator/generate')
            .set('x-test-permissions', 'agentflows:update,credentials:view')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'generate' })
    })
})
