import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockUploadAssistantFiles = jest.fn((_req: Request, res: Response) => res.json({ handler: 'upload' }))
const mockMulterMiddleware = jest.fn((req: Request, _res: Response, next: NextFunction) => {
    if (req.headers['x-test-over-limit']) {
        return next(Object.assign(new Error('raw multer path /tmp/private-upload'), { code: String(req.headers['x-test-over-limit']) }))
    }
    return next()
})
const mockArray = jest.fn(() => mockMulterMiddleware)
const mockMulter = {
    limits: undefined as Record<string, number> | undefined,
    array: mockArray
}

jest.mock('../../enterprise/rbac/PermissionCheck', () => ({
    checkAnyPermission: jest.fn((permissions: string) => (req: Request, res: Response, next: NextFunction) => {
        const granted = String(req.headers['x-test-permissions'] ?? '').split(',')
        if (permissions.split(',').some((permission) => granted.includes(permission))) return next()
        return res.status(403).json({ message: 'forbidden' })
    })
}))

jest.mock('../../utils', () => ({
    getMulterStorage: jest.fn(() => mockMulter)
}))

jest.mock('../../controllers/openai-assistants', () => ({
    __esModule: true,
    default: {
        getFileFromAssistant: (_req: Request, res: Response) => res.json({ handler: 'download' }),
        uploadAssistantFiles: (req: Request, res: Response) => mockUploadAssistantFiles(req, res)
    }
}))

import openaiAssistantsFilesRouter, { ASSISTANT_FILE_COUNT_LIMIT, ASSISTANT_MULTIPART_PART_LIMIT, parseFileSizeLimit } from '.'

const app = express().use('/openai-assistants-file', openaiAssistantsFilesRouter)
app.use((error: { statusCode?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
})

describe('OpenAI Assistant file routes', () => {
    beforeEach(() => {
        mockMulterMiddleware.mockClear()
        mockUploadAssistantFiles.mockClear()
    })

    it('configures bounded multipart parsing from the repository file-size setting', () => {
        expect(mockArray).toHaveBeenCalledWith('files', ASSISTANT_FILE_COUNT_LIMIT)
        expect(mockMulter.limits).toEqual({
            fileSize: parseFileSizeLimit(process.env.FLOWISE_FILE_SIZE_LIMIT),
            files: ASSISTANT_FILE_COUNT_LIMIT,
            parts: ASSISTANT_MULTIPART_PART_LIMIT
        })
        expect(parseFileSizeLimit('2.5mb')).toBe(2.5 * 1024 * 1024)
        expect(parseFileSizeLimit('invalid')).toBe(50 * 1024 * 1024)
    })

    it('rejects unauthorized uploads before multer processes files', async () => {
        await request(app).post('/openai-assistants-file/upload').set('x-test-permissions', 'assistants:view').expect(403)
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
    })

    it.each(['assistants:create', 'assistants:update'])(
        'returns the fixed legacy 410 for %s before multer or the controller',
        async (permission) => {
            const response = await request(app).post('/openai-assistants-file/upload').set('x-test-permissions', permission).expect(410)

            expect(response.body).toEqual({
                message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
            })
            expect(mockMulterMiddleware).not.toHaveBeenCalled()
            expect(mockUploadAssistantFiles).not.toHaveBeenCalled()
        }
    )

    it.each(['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_PART_COUNT', 'LIMIT_UNEXPECTED_FILE'])(
        'rejects legacy uploads before parsing multipart error %s',
        async (limitCode) => {
            const response = await request(app)
                .post('/openai-assistants-file/upload')
                .set('x-test-permissions', 'assistants:update')
                .set('x-test-over-limit', limitCode)
                .expect(410)

            expect(response.body).toEqual({
                message: 'OpenAI Assistants API is deprecated and creating new OpenAI Assistant resources is disabled'
            })
            expect(mockMulterMiddleware).not.toHaveBeenCalled()
            expect(mockUploadAssistantFiles).not.toHaveBeenCalled()
        }
    )

    it('still rejects unauthorized over-limit requests before the legacy guard and multer', async () => {
        await request(app)
            .post('/openai-assistants-file/upload')
            .set('x-test-permissions', 'assistants:view')
            .set('x-test-over-limit', 'LIMIT_FILE_SIZE')
            .expect(403)

        expect(mockMulterMiddleware).not.toHaveBeenCalled()
        expect(mockUploadAssistantFiles).not.toHaveBeenCalled()
    })

    it('preserves the public download route used by published chatflows', async () => {
        const response = await request(app).post('/openai-assistants-file/download').expect(200)
        expect(response.body).toEqual({ handler: 'download' })
        expect(mockMulterMiddleware).not.toHaveBeenCalled()
    })
})
