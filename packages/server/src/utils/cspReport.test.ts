import express from 'express'
import request from 'supertest'
import { createSecurityHeadersMiddleware } from './csp'
import { createCspReportRouter } from './cspReport'

describe('createCspReportRouter', () => {
    function createFixture(rateLimitMax = 120) {
        const log = { warn: jest.fn() }
        const app = express()
        app.use('/api/v1/security/csp-report', createCspReportRouter({ log, rateLimitMax }))
        return { app, log }
    }

    function getLoggedPayload(log: { warn: jest.Mock }) {
        expect(log.warn).toHaveBeenCalledTimes(1)
        expect(log.warn.mock.calls[0]).toHaveLength(1)
        const message = log.warn.mock.calls[0][0]
        expect(typeof message).toBe('string')
        expect(message).not.toMatch(/[\r\n]/)
        return JSON.parse(message)
    }

    it('applies direct-deployment security headers before an accepted report response ends', async () => {
        const log = { warn: jest.fn() }
        const app = express()
        const securityHeaders = {
            'Content-Security-Policy': "default-src 'self'; frame-ancestors 'self'",
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        }
        app.use(createSecurityHeadersMiddleware(securityHeaders))
        app.use('/api/v1/security/csp-report', createCspReportRouter({ log }))

        const response = await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/csp-report')
            .send(JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'eval' } }))

        expect(response.status).toBe(204)
        expect(response.headers['content-security-policy']).toBe(securityHeaders['Content-Security-Policy'])
        expect(response.headers['strict-transport-security']).toBe(securityHeaders['Strict-Transport-Security'])
        expect(response.headers['x-content-type-options']).toBe(securityHeaders['X-Content-Type-Options'])
        expect(response.headers['referrer-policy']).toBe(securityHeaders['Referrer-Policy'])
    })

    it('accepts and sanitizes a legacy CSP report without logging sensitive fields', async () => {
        const { app, log } = createFixture()
        const response = await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/csp-report')
            .send(
                JSON.stringify({
                    'csp-report': {
                        'document-uri': 'https://app.example.com/private/flow-id?token=do-not-log#fragment',
                        'effective-directive': 'script-src-elem',
                        'blocked-uri': 'https://cdn.example.com/app.js?key=do-not-log',
                        disposition: 'report',
                        'status-code': 200,
                        'script-sample': 'password=do-not-log',
                        'source-file': 'https://app.example.com/source.js?secret=do-not-log'
                    }
                })
            )

        expect(response.status).toBe(204)
        expect(getLoggedPayload(log)).toEqual({
            event: 'csp-report',
            reports: [
                {
                    directive: 'script-src-elem',
                    disposition: 'report',
                    statusCode: 200,
                    documentOrigin: 'https://app.example.com',
                    blockedOrigin: 'https://cdn.example.com'
                }
            ]
        })
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/do-not-log|private|flow-id|script-sample|source-file/i)
    })

    it('accepts Reporting API arrays and preserves only known safe blocked values', async () => {
        const { app, log } = createFixture()
        const response = await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/reports+json')
            .send([
                {
                    type: 'csp-violation',
                    url: 'https://app.example.com/flow/123?credential=hidden',
                    body: {
                        effectiveDirective: 'script-src',
                        blockedURL: 'inline',
                        disposition: 'report',
                        statusCode: 200,
                        sample: 'apiKey=hidden'
                    }
                }
            ])

        expect(response.status).toBe(204)
        expect(getLoggedPayload(log)).toEqual({
            event: 'csp-report',
            reports: [
                {
                    directive: 'script-src',
                    disposition: 'report',
                    statusCode: 200,
                    documentOrigin: 'https://app.example.com',
                    blockedOrigin: 'inline'
                }
            ]
        })
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/credential|apiKey|hidden|\/flow\//)
    })

    it('processes only the first ten Reporting API envelopes and emits one warning', async () => {
        const { app, log } = createFixture()
        const reports = Array.from({ length: 12 }, (_value, index) => ({
            type: 'csp-violation',
            url: `https://app.example.com/private/${index}?credential=hidden`,
            body: {
                effectiveDirective: 'script-src',
                blockedURL: `https://cdn-${index}.example.com/private.js?token=hidden`,
                disposition: 'report',
                statusCode: 200,
                sample: `secret-${index}`
            }
        }))

        await request(app).post('/api/v1/security/csp-report').set('Content-Type', 'application/reports+json').send(reports).expect(204)

        const payload = getLoggedPayload(log)
        expect(payload.event).toBe('csp-report')
        expect(payload.reports).toHaveLength(10)
        expect(payload.reports[0].blockedOrigin).toBe('https://cdn-0.example.com')
        expect(payload.reports[9].blockedOrigin).toBe('https://cdn-9.example.com')
        expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/cdn-10|cdn-11|credential|token|secret|\/private/)
    })

    it('returns 204 without logging for an unrelated JSON shape', async () => {
        const { app, log } = createFixture()
        const response = await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/json')
            .send({ password: 'must-not-log' })

        expect(response.status).toBe(204)
        expect(log.warn).not.toHaveBeenCalled()
    })

    it('rejects unsupported media types and methods', async () => {
        const { app } = createFixture()
        await request(app).post('/api/v1/security/csp-report').set('Content-Type', 'text/plain').send('{}').expect(415)
        await request(app).get('/api/v1/security/csp-report').expect(404)
    })

    it('returns bounded client errors for malformed and oversized JSON', async () => {
        const { app, log } = createFixture()
        await request(app).post('/api/v1/security/csp-report').set('Content-Type', 'application/csp-report').send('{').expect(400)
        await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/csp-report')
            .send(JSON.stringify({ padding: 'x'.repeat(17 * 1024) }))
            .expect(413)
        expect(log.warn).not.toHaveBeenCalled()
    })

    it('rate limits before parsing additional report bodies', async () => {
        const { app, log } = createFixture(1)
        const payload = JSON.stringify({ 'csp-report': { 'effective-directive': 'script-src', 'blocked-uri': 'eval' } })

        await request(app).post('/api/v1/security/csp-report').set('Content-Type', 'application/csp-report').send(payload).expect(204)
        const limited = await request(app)
            .post('/api/v1/security/csp-report')
            .set('Content-Type', 'application/csp-report')
            .send('{malformed but rate limited first')

        expect(limited.status).toBe(429)
        expect(log.warn).toHaveBeenCalledTimes(1)
    })
})
