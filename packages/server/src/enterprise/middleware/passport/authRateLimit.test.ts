import express, { Request, Response } from 'express'
import request from 'supertest'
import { createAdminAuthenticationRateLimiter } from './authRateLimit'

describe('admin authentication rate limiting', () => {
    it('keeps password recovery abuse from consuming the login budget', async () => {
        const app = express()
        app.use(express.json())
        const loginLimiter = createAdminAuthenticationRateLimiter({ max: 2, windowMs: 60_000 })
        const recoveryLimiter = createAdminAuthenticationRateLimiter({ max: 2, windowMs: 60_000 })
        app.post('/login', loginLimiter, (_req: Request, res: Response) => res.status(401).json({ message: 'denied' }))
        app.post('/forgot-password', recoveryLimiter, (_req: Request, res: Response) => res.status(201).json({ message: 'success' }))

        await request(app)
            .post('/forgot-password')
            .send({ user: { email: ' Admin@Example.com ' } })
            .expect(201)
        await request(app).post('/forgot-password').send({ email: 'admin@example.com' }).expect(201)

        await request(app).post('/login').send({ email: 'ADMIN@example.com' }).expect(401)
        await request(app).post('/login').send({ email: 'admin@example.com' }).expect(401)

        await request(app).post('/forgot-password').send({ email: 'admin@example.com' }).expect(429)
        await request(app).post('/login').send({ email: 'admin@example.com' }).expect(429)
    })

    it('caps one source IP even when the attacker rotates email addresses', async () => {
        const app = express()
        app.use(express.json())
        const limiter = createAdminAuthenticationRateLimiter({ max: 1, windowMs: 60_000 })
        app.post('/login', limiter, (_req: Request, res: Response) => res.sendStatus(204))

        await request(app).post('/login').send({ email: 'first@example.com' }).expect(204)
        await request(app).post('/login').send({ email: 'second@example.com' }).expect(429)
    })

    it('keeps invitation verification abuse on a budget independent from password recovery', async () => {
        const app = express()
        app.use(express.json())
        const recoveryLimiter = createAdminAuthenticationRateLimiter({ max: 1, windowMs: 60_000 })
        const verificationLimiter = createAdminAuthenticationRateLimiter({ max: 1, windowMs: 60_000 })
        app.post('/forgot-password', recoveryLimiter, (_req: Request, res: Response) => res.sendStatus(204))
        app.post('/verify', verificationLimiter, (_req: Request, res: Response) => res.sendStatus(204))

        await request(app)
            .post('/verify')
            .send({ user: { tempToken: 'one' } })
            .expect(204)
        await request(app)
            .post('/verify')
            .send({ user: { tempToken: 'two' } })
            .expect(429)
        await request(app).post('/forgot-password').send({ email: 'admin@example.com' }).expect(204)
    })

    it('shares an account budget across source IPs', async () => {
        const app = express()
        app.set('trust proxy', 1)
        app.use(express.json())
        const limiter = createAdminAuthenticationRateLimiter({ accountMax: 1, ipMax: 10, windowMs: 60_000 })
        app.post('/login', limiter, (_req: Request, res: Response) => res.sendStatus(204))

        await request(app).post('/login').set('x-forwarded-for', '192.0.2.10').send({ email: 'admin@example.com' }).expect(204)
        await request(app).post('/login').set('x-forwarded-for', '192.0.2.11').send({ email: 'ADMIN@example.com' }).expect(429)
    })
})
