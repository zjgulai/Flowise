import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockGetAllChatMessages = jest.fn((_req: Request, res: Response) => res.json({ handler: 'public-list' }))
const mockGetAllInternalChatMessages = jest.fn((_req: Request, res: Response) => res.json({ handler: 'internal-list' }))
const mockRemoveAllChatMessages = jest.fn((_req: Request, res: Response) => res.json({ handler: 'delete' }))
const mockAbortChatMessage = jest.fn((_req: Request, res: Response) => res.json({ handler: 'abort' }))

jest.mock('../../controllers/chat-messages', () => ({
    __esModule: true,
    default: {
        getAllChatMessages: (req: Request, res: Response) => mockGetAllChatMessages(req, res),
        getAllInternalChatMessages: (req: Request, res: Response) => mockGetAllInternalChatMessages(req, res),
        removeAllChatMessages: (req: Request, res: Response) => mockRemoveAllChatMessages(req, res),
        abortChatMessage: (req: Request, res: Response) => mockAbortChatMessage(req, res)
    }
}))

import chatMessageRouter from '.'
import internalChatMessageRouter from '../internal-chat-messages'

const app = express()
    .use((req: Request, _res: Response, next: NextFunction) => {
        const permissions = String(req.headers['x-test-permissions'] ?? '')
            .split(',')
            .filter(Boolean)
        if (req.headers['x-test-authenticated'] !== 'false') {
            req.user = {
                isOrganizationAdmin: req.headers['x-test-admin'] === 'true',
                permissions
            } as Request['user']
        }
        next()
    })
    .use('/chatmessage', chatMessageRouter)
    .use('/internal-chatmessage', internalChatMessageRouter)

describe('chat message route permissions', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('requires a flow view permission for both message read routes', async () => {
        await request(app).get('/chatmessage/flow-1').expect(403)
        await request(app).get('/internal-chatmessage/flow-1').expect(403)
        expect(mockGetAllChatMessages).not.toHaveBeenCalled()
        expect(mockGetAllInternalChatMessages).not.toHaveBeenCalled()

        await request(app).get('/chatmessage/flow-1').set('x-test-permissions', 'agentflows:view').expect(200, {
            handler: 'public-list'
        })
        await request(app).get('/internal-chatmessage/flow-1').set('x-test-permissions', 'assistants:view').expect(200, {
            handler: 'internal-list'
        })
    })

    it('requires a flow delete permission before reaching destructive logic', async () => {
        await request(app).delete('/chatmessage/flow-1').set('x-test-permissions', 'chatflows:view').expect(403)
        expect(mockRemoveAllChatMessages).not.toHaveBeenCalled()

        await request(app).delete('/chatmessage/flow-1').set('x-test-permissions', 'chatflows:delete').expect(200, {
            handler: 'delete'
        })
        expect(mockRemoveAllChatMessages).toHaveBeenCalledTimes(1)
    })

    it('allows an organization admin but rejects an anonymous request', async () => {
        await request(app).get('/chatmessage/flow-1').set('x-test-admin', 'true').expect(200)
        await request(app).get('/chatmessage/flow-1').set('x-test-authenticated', 'false').expect(403)
    })

    it('keeps the prediction abort transport outside the history-read permission contract', async () => {
        await request(app).put('/chatmessage/abort/flow-1/chat-1').expect(200, { handler: 'abort' })
        expect(mockAbortChatMessage).toHaveBeenCalledTimes(1)
    })
})
