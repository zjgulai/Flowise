import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const permissionMiddleware = (permission: string) => (req: Request, res: Response, next: NextFunction) => {
    const permissions = String(req.headers['x-test-permissions'] ?? '').split(',')
    if (permissions.includes(permission)) return next()
    return res.status(403).json({ message: 'forbidden' })
}

const mockUpload = jest.fn((_req: Request, res: Response) => res.json({ handler: 'upload' }))
const mockCreate = jest.fn((_req: Request, res: Response) => res.json({ handler: 'create' }))
const mockDelete = jest.fn((_req: Request, res: Response) => res.json({ handler: 'delete' }))
const mockDeleteFiles = jest.fn((_req: Request, res: Response) => res.json({ handler: 'delete-files' }))
const mockMulterMiddleware = jest.fn((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers['x-test-over-limit']) {
        return next(Object.assign(new Error('raw multer path /tmp/private-vector-upload'), { code: req.headers['x-test-over-limit'] }))
    }
    return next()
})
const mockArray = jest.fn(() => mockMulterMiddleware)
const mockMulter = {
    limits: undefined as Record<string, number> | undefined,
    array: mockArray
}

jest.mock('../../enterprise/rbac/PermissionCheck', () => ({
    checkPermission: jest.fn((permission: string) => permissionMiddleware(permission))
}))

jest.mock('../../utils', () => ({
    getMulterStorage: jest.fn(() => mockMulter)
}))

jest.mock('../../controllers/openai-assistants-vector-store', () => ({
    __esModule: true,
    default: {
        createAssistantVectorStore: (req: Request, res: Response) => mockCreate(req, res),
        getAssistantVectorStore: (_req: Request, res: Response) => res.json({ handler: 'get' }),
        listAssistantVectorStore: (_req: Request, res: Response) => res.json({ handler: 'list' }),
        updateAssistantVectorStore: (_req: Request, res: Response) => res.json({ handler: 'update' }),
        deleteAssistantVectorStore: (req: Request, res: Response) => mockDelete(req, res),
        uploadFilesToAssistantVectorStore: (req: Request, res: Response) => mockUpload(req, res),
        deleteFilesFromAssistantVectorStore: (req: Request, res: Response) => mockDeleteFiles(req, res)
    }
}))

import openaiAssistantsVectorStoreRouter from '.'
import { ASSISTANT_FILE_COUNT_LIMIT, ASSISTANT_MULTIPART_PART_LIMIT, parseFileSizeLimit } from '../openai-assistants-files/uploadLimits'

const app = express().use(express.json()).use('/openai-assistants-vector-store', openaiAssistantsVectorStoreRouter)
app.use((error: { statusCode?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
})

describe('OpenAI Assistant vector store routes', () => {
    beforeEach(() => {
        mockMulterMiddleware.mockClear()
        mockUpload.mockClear()
        mockCreate.mockClear()
        mockDelete.mockClear()
        mockDeleteFiles.mockClear()
    })

    it('uses the same bounded multipart contract as Assistant uploads', () => {
        expect(mockArray).toHaveBeenCalledWith('files', ASSISTANT_FILE_COUNT_LIMIT)
        expect(mockMulter.limits).toEqual({
            fileSize: parseFileSizeLimit(process.env.FLOWISE_FILE_SIZE_LIMIT),
            files: ASSISTANT_FILE_COUNT_LIMIT,
            parts: ASSISTANT_MULTIPART_PART_LIMIT
        })
    })

    it('does not let create-only users update an existing vector store', async () => {
        await request(app).put('/openai-assistants-vector-store/vs-1').set('x-test-permissions', 'assistants:create').send({}).expect(403)
        await request(app).put('/openai-assistants-vector-store/vs-1').set('x-test-permissions', 'assistants:update').send({}).expect(403)

        const response = await request(app)
            .put('/openai-assistants-vector-store/vs-1')
            .set('x-test-permissions', 'assistants:update,credentials:view')
            .send({})
            .expect(200)
        expect(response.body).toEqual({ handler: 'update' })
    })

    it('requires credentials:view for Provider-backed legacy reads', async () => {
        await request(app).get('/openai-assistants-vector-store/vs-1').set('x-test-permissions', 'assistants:view').expect(403)
        await request(app).get('/openai-assistants-vector-store').set('x-test-permissions', 'assistants:view').expect(403)
        await request(app).get('/openai-assistants-vector-store/vs-1').set('x-test-permissions', 'credentials:view').expect(403)
    })

    it('preserves authorized legacy read and non-destructive maintenance routes', async () => {
        const readResponse = await request(app)
            .get('/openai-assistants-vector-store/vs-1')
            .set('x-test-permissions', 'assistants:view,credentials:view')
            .expect(200)
        const listResponse = await request(app)
            .get('/openai-assistants-vector-store')
            .set('x-test-permissions', 'assistants:view,credentials:view')
            .expect(200)
        const updateResponse = await request(app)
            .put('/openai-assistants-vector-store/vs-1')
            .set('x-test-permissions', 'assistants:update,credentials:view')
            .send({ name: 'Existing store' })
            .expect(200)

        expect(readResponse.body).toEqual({ handler: 'get' })
        expect(listResponse.body).toEqual({ handler: 'list' })
        expect(updateResponse.body).toEqual({ handler: 'update' })
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
    })

    it.each([
        { method: 'delete' as const, permission: 'assistants:delete' },
        { method: 'patch' as const, permission: 'assistants:update' }
    ])('returns a fixed 410 before destructive vector cleanup via $method', async ({ method, permission }) => {
        const agent = request(app)
        const pendingRequest =
            method === 'delete' ? agent.delete('/openai-assistants-vector-store/vs-1') : agent.patch('/openai-assistants-vector-store/vs-1')
        const response = await pendingRequest
            .set('x-test-permissions', permission)
            .send({ file_ids: ['file-1'] })
            .expect(410)

        expect(response.body).toEqual({
            message: 'OpenAI Assistants API is deprecated and destructive OpenAI Assistant resource cleanup is disabled'
        })
        expect(mockDelete).not.toHaveBeenCalled()
        expect(mockDeleteFiles).not.toHaveBeenCalled()
    })

    it('returns the fixed legacy 410 before creating a vector store', async () => {
        const response = await request(app)
            .post('/openai-assistants-vector-store')
            .set('x-test-permissions', 'assistants:create')
            .send({ name: 'blocked' })
            .expect(410)

        expect(response.body).toEqual({
            message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
        })
        expect(mockCreate).not.toHaveBeenCalled()
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
    })

    it('rejects create-only vector uploads before parsing files', async () => {
        await request(app).post('/openai-assistants-vector-store/vs-1').set('x-test-permissions', 'assistants:create').expect(403)

        expect(mockMulterMiddleware).not.toHaveBeenCalled()
        expect(mockUpload).not.toHaveBeenCalled()
    })

    it('returns the fixed legacy 410 for update users before upload parsing or the controller', async () => {
        const response = await request(app)
            .post('/openai-assistants-vector-store/vs-1')
            .set('x-test-permissions', 'assistants:update')
            .expect(410)

        expect(response.body).toEqual({
            message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
        })
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
        expect(mockUpload).not.toHaveBeenCalled()
    })

    it('rejects legacy vector uploads before parsing multipart limit failures', async () => {
        const response = await request(app)
            .post('/openai-assistants-vector-store/vs-1')
            .set('x-test-permissions', 'assistants:update')
            .set('x-test-over-limit', 'LIMIT_FILE_SIZE')
            .expect(410)

        expect(response.body).toEqual({
            message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
        })
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
        expect(mockUpload).not.toHaveBeenCalled()
    })
})
