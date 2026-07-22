import express, { Request } from 'express'
import request from 'supertest'
import { LoggedInUser } from '../../Interface.Enterprise'
import { AcceptanceLoginRejectedError } from '../../services/acceptanceLogin.service'
import { ACCEPTANCE_LOGIN_MESSAGE, ACCEPTANCE_LOGIN_PATH } from '../../utils/acceptanceLoginPolicy'
import { establishAcceptanceSession, registerAcceptanceLoginRoute } from './acceptanceLogin'

const VALID_CODE = 'A'.repeat(43)
const APP_URL = 'https://flowise.example.com'
const user = { id: '00000000-0000-4000-8000-000000000002' } as LoggedInUser

function createApp(rateLimitMax = 5) {
    const consume = jest.fn().mockResolvedValue(user)
    const sendAuthenticatedResponse = jest.fn((res) => res.status(200).json({ ok: true }))
    const app = express()
    app.use(express.json({ limit: '1kb' }))
    app.use((req, _res, next) => {
        ;(req as any).session = {
            regenerate: (done: (error?: Error) => void) => done(),
            save: (done: (error?: Error) => void) => done(),
            destroy: (done: (error?: Error) => void) => done()
        }
        ;(req as any).login = (_user: LoggedInUser, _options: unknown, done: (error?: Error) => void) => done()
        next()
    })
    registerAcceptanceLoginRoute(app, {
        appUrl: APP_URL,
        consume,
        sendAuthenticatedResponse,
        rateLimitMax
    })
    return { app, consume, sendAuthenticatedResponse }
}

function validPost(app: express.Application) {
    return request(app)
        .post(ACCEPTANCE_LOGIN_PATH)
        .set('Origin', APP_URL)
        .set('x-request-from', 'internal')
        .set('Content-Type', 'application/json')
}

describe('registerAcceptanceLoginRoute', () => {
    it.each(['get', 'put'] as const)('rejects %s without consuming a code', async (method) => {
        const { app, consume } = createApp()

        const response = await request(app)[method](ACCEPTANCE_LOGIN_PATH)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ message: ACCEPTANCE_LOGIN_MESSAGE })
        expect(consume).not.toHaveBeenCalled()
    })

    it.each([
        ['missing Origin', undefined, 'internal', 'application/json', { code: VALID_CODE }],
        ['null Origin', 'null', 'internal', 'application/json', { code: VALID_CODE }],
        ['cross Origin', 'https://evil.example.com', 'internal', 'application/json', { code: VALID_CODE }],
        ['missing internal header', APP_URL, undefined, 'application/json', { code: VALID_CODE }],
        ['non-JSON', APP_URL, 'internal', 'text/plain', VALID_CODE],
        ['missing code', APP_URL, 'internal', 'application/json', {}],
        ['extra body key', APP_URL, 'internal', 'application/json', { code: VALID_CODE, extra: true }]
    ])('rejects %s at the uniform pre-consume boundary', async (_label, origin, internal, contentType, body) => {
        const { app, consume } = createApp()
        let pending = request(app)
            .post(ACCEPTANCE_LOGIN_PATH)
            .set('Content-Type', contentType as string)
        if (origin) pending = pending.set('Origin', origin)
        if (internal) pending = pending.set('x-request-from', internal)

        const response = contentType === 'application/json' ? await pending.send(body) : await pending.send(body as string)

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ message: ACCEPTANCE_LOGIN_MESSAGE })
        expect(consume).not.toHaveBeenCalled()
    })

    it('leaves malformed JSON at the parser 400 boundary', async () => {
        const { app, consume } = createApp()

        const response = await request(app)
            .post(ACCEPTANCE_LOGIN_PATH)
            .set('Origin', APP_URL)
            .set('x-request-from', 'internal')
            .set('Content-Type', 'application/json')
            .send('{"code":')

        expect(response.status).toBe(400)
        expect(consume).not.toHaveBeenCalled()
    })

    it('consumes a valid same-origin JSON code and returns no-store headers', async () => {
        const { app, consume, sendAuthenticatedResponse } = createApp()

        const response = await validPost(app).send({ code: VALID_CODE })

        expect(response.status).toBe(200)
        expect(consume).toHaveBeenCalledWith(VALID_CODE)
        expect(sendAuthenticatedResponse).toHaveBeenCalledTimes(1)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.headers.pragma).toBe('no-cache')
        expect(response.headers['referrer-policy']).toBe('no-referrer')
    })

    it('returns a fixed 429 response on the sixth request', async () => {
        const { app, consume } = createApp()

        for (let attempt = 0; attempt < 5; attempt += 1) {
            expect((await validPost(app).send({ code: VALID_CODE })).status).toBe(200)
        }
        const response = await validPost(app).send({ code: VALID_CODE })

        expect(response.status).toBe(429)
        expect(response.body).toEqual({ message: '请求过于频繁，请稍后再试。' })
        expect(consume).toHaveBeenCalledTimes(5)
        expect(response.headers['cache-control']).toBe('no-store')
    })

    it('returns the uniform rejection when consumption rejects', async () => {
        const { app, consume, sendAuthenticatedResponse } = createApp()
        consume.mockRejectedValueOnce(new AcceptanceLoginRejectedError())

        const response = await validPost(app).send({ code: VALID_CODE })

        expect(response.status).toBe(404)
        expect(response.body).toEqual({ message: ACCEPTANCE_LOGIN_MESSAGE })
        expect(sendAuthenticatedResponse).not.toHaveBeenCalled()
    })

    it('returns a fixed 500 response for unexpected consumption failures', async () => {
        const { app, consume, sendAuthenticatedResponse } = createApp()
        consume.mockRejectedValueOnce(new Error('dynamic-cause-must-not-escape'))

        const response = await validPost(app).send({ code: VALID_CODE })

        expect(response.status).toBe(500)
        expect(response.body).toEqual({ message: '认证会话建立失败，请重新生成一次性认证码。' })
        expect(response.text).not.toContain('dynamic-cause')
        expect(sendAuthenticatedResponse).not.toHaveBeenCalled()
    })
})

type FailurePoint = 'regenerate' | 'login' | 'save'

function createSessionRequest(failurePoint?: FailurePoint) {
    const events: string[] = []
    const originalError = new Error(`${failurePoint}-failure`)
    const req = {
        session: {
            regenerate: (done: (error?: Error) => void) => {
                events.push('regenerate')
                done(failurePoint === 'regenerate' ? originalError : undefined)
            },
            save: (done: (error?: Error) => void) => {
                events.push('save')
                done(failurePoint === 'save' ? originalError : undefined)
            },
            destroy: (done: (error?: Error) => void) => {
                events.push('destroy')
                done()
            }
        },
        login: (_user: LoggedInUser, _options: unknown, done: (error?: Error) => void) => {
            events.push('login')
            done(failurePoint === 'login' ? originalError : undefined)
        }
    } as unknown as Request
    return { req, events, originalError }
}

describe('establishAcceptanceSession', () => {
    it('orders regenerate, login, save, then send', async () => {
        const { req, events } = createSessionRequest()
        const send = jest.fn(() => events.push('send'))

        await expect(establishAcceptanceSession(req, {} as any, user, send)).resolves.toBeUndefined()

        expect(events).toEqual(['regenerate', 'login', 'save', 'send'])
    })

    it.each(['regenerate', 'login', 'save'] as FailurePoint[])(
        'destroys the partial session and preserves the original %s error',
        async (failurePoint) => {
            const { req, events, originalError } = createSessionRequest(failurePoint)
            const send = jest.fn()

            await expect(establishAcceptanceSession(req, {} as any, user, send)).rejects.toBe(originalError)

            expect(events.filter((event) => event === 'destroy')).toHaveLength(1)
            expect(send).not.toHaveBeenCalled()
        }
    )
})
