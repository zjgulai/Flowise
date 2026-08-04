import express from 'express'
import request from 'supertest'
import { rejectNonCanonicalApiPath } from './canonicalApiPath'

describe('canonical API path guard', () => {
    const app = express()
        .use(rejectNonCanonicalApiPath)
        .use((_req, res) => res.status(204).end())

    it.each(['/API/V1/mcp/id', '/api/V1/mcp/id', '/api/v1/McP/id'])('rejects non-canonical API path %s', async (path) => {
        const response = await request(app).get(path)
        expect(response.status).toBe(401)
        expect(response.body).toEqual({ error: 'Unauthorized Access' })
    })

    it.each(['/api/v1/mcp/id', '/assets/API/V2/icon.svg'])('allows canonical or non-v1 path %s', async (path) => {
        expect((await request(app).get(path)).status).toBe(204)
    })
})
