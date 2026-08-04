import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'
import {
    createDocumentStoreQueueFailedError,
    restoreDocumentStoreQueueError,
    waitForDocumentStoreQueueResult
} from './documentStoreQueueError'

describe('document store BullMQ error envelope', () => {
    it.each([
        [StatusCodes.BAD_REQUEST, StatusCodes.BAD_REQUEST, 'Document store queue request is invalid'],
        [StatusCodes.FORBIDDEN, StatusCodes.FORBIDDEN, 'Document store queue operation is not authorized'],
        [StatusCodes.NOT_FOUND, StatusCodes.NOT_FOUND, 'Document store not found'],
        [StatusCodes.CONFLICT, StatusCodes.CONFLICT, 'Document store changed concurrently'],
        [StatusCodes.UNPROCESSABLE_ENTITY, StatusCodes.INTERNAL_SERVER_ERROR, 'Document store queue operation failed']
    ])('restores only an allowlisted fixed error for worker status %s', (workerStatus, expectedStatus, expectedMessage) => {
        const failedReason = createDocumentStoreQueueFailedError(new InternalFlowiseError(workerStatus, 'private provider/database detail'))

        expect(restoreDocumentStoreQueueError(failedReason)).toMatchObject({
            statusCode: expectedStatus,
            message: expectedMessage
        })
        expect(failedReason.message).not.toContain('private provider/database detail')
    })

    it.each([
        new Error('FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:CONFLICT'),
        new Error('FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:NOT_FOUND'),
        new Error('provider secret'),
        { message: 'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:CONFLICT' }
    ])('prevents a non-Internal error from forging an allowlisted status (%p)', (error) => {
        const failedReason = createDocumentStoreQueueFailedError(error)
        expect(restoreDocumentStoreQueueError(failedReason)).toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Document store queue operation failed'
        })
    })

    it.each([
        'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:',
        'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:CONFLICT:extra',
        'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v2:CONFLICT',
        'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:418',
        'arbitrary provider detail'
    ])('maps malformed or unknown failedReason to a fixed 500 (%s)', (failedReason) => {
        expect(restoreDocumentStoreQueueError(new Error(failedReason))).toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Document store queue operation failed'
        })
    })

    it('turns BullMQ plain Error conflict back into InternalFlowiseError 409 at the wait boundary', async () => {
        const failedReason = createDocumentStoreQueueFailedError(new InternalFlowiseError(StatusCodes.CONFLICT, 'private conflict detail'))
        const job = { waitUntilFinished: jest.fn().mockRejectedValue(new Error(failedReason.message)) }

        await expect(waitForDocumentStoreQueueResult(job as never, {} as never)).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Document store changed concurrently'
        })
    })
})
