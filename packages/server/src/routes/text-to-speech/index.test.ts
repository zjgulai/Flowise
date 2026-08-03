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

jest.mock('../../controllers/text-to-speech', () => ({
    __esModule: true,
    default: {
        getRateLimiterMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
        generateTextToSpeech: (_req: Request, res: Response) => res.json({ handler: 'generate' }),
        abortTextToSpeech: (_req: Request, res: Response) => res.json({ handler: 'abort' }),
        getVoices: (_req: Request, res: Response) => res.json({ handler: 'voices' })
    }
}))

import textToSpeechRouter from '.'

const app = express().use(express.json()).use('/text-to-speech', textToSpeechRouter)

describe('text-to-speech routes', () => {
    it('protects credential-backed voice discovery with flow edit permission', async () => {
        await request(app).get('/text-to-speech/voices').set('x-test-permissions', 'chatflows:view').expect(403)

        await request(app).get('/text-to-speech/voices').set('x-test-permissions', 'chatflows:update').expect(403)

        const response = await request(app)
            .get('/text-to-speech/voices')
            .set('x-test-permissions', 'chatflows:update,credentials:view')
            .expect(200)
        expect(response.body).toEqual({ handler: 'voices' })

        await request(app).get('/text-to-speech/voices').set('x-test-permissions', 'agentflows:update,credentials:view').expect(200)
    })

    it('keeps flow-bound generate and abort endpoints reachable for controller-level public flow authorization', async () => {
        await request(app).post('/text-to-speech/generate').send({}).expect(200)
        await request(app).post('/text-to-speech/abort').send({}).expect(200)
    })
})
