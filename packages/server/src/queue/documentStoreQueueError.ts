import type { Job, QueueEvents } from 'bullmq'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../errors/internalFlowiseError'

const ENVELOPE_PREFIX = 'FLOWISE_DOCUMENT_STORE_QUEUE_ERROR:v1:'

const QUEUE_ERROR_CODES = {
    BAD_REQUEST: { statusCode: StatusCodes.BAD_REQUEST, message: 'Document store queue request is invalid' },
    FORBIDDEN: { statusCode: StatusCodes.FORBIDDEN, message: 'Document store queue operation is not authorized' },
    NOT_FOUND: { statusCode: StatusCodes.NOT_FOUND, message: 'Document store not found' },
    CONFLICT: { statusCode: StatusCodes.CONFLICT, message: 'Document store changed concurrently' },
    INTERNAL: { statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Document store queue operation failed' }
} as const

type DocumentStoreQueueErrorCode = keyof typeof QUEUE_ERROR_CODES

const codeForStatus = (statusCode: number): DocumentStoreQueueErrorCode => {
    switch (statusCode) {
        case StatusCodes.BAD_REQUEST:
            return 'BAD_REQUEST'
        case StatusCodes.FORBIDDEN:
            return 'FORBIDDEN'
        case StatusCodes.NOT_FOUND:
            return 'NOT_FOUND'
        case StatusCodes.CONFLICT:
            return 'CONFLICT'
        default:
            return 'INTERNAL'
    }
}

/** Worker-side only: never copies an arbitrary message, stack, or property. */
export const createDocumentStoreQueueFailedError = (error: unknown): Error => {
    const code = error instanceof InternalFlowiseError ? codeForStatus(error.statusCode) : 'INTERNAL'
    return new Error(`${ENVELOPE_PREFIX}${code}`)
}

/** HTTP-side decoder for BullMQ's plain Error(failedReason). */
export const restoreDocumentStoreQueueError = (error: unknown): InternalFlowiseError => {
    const message = error instanceof Error ? error.message : ''
    const code = message.startsWith(ENVELOPE_PREFIX) ? message.slice(ENVELOPE_PREFIX.length) : ''
    if (!Object.prototype.hasOwnProperty.call(QUEUE_ERROR_CODES, code)) {
        const fallback = QUEUE_ERROR_CODES.INTERNAL
        return new InternalFlowiseError(fallback.statusCode, fallback.message)
    }
    const safe = QUEUE_ERROR_CODES[code as DocumentStoreQueueErrorCode]
    return new InternalFlowiseError(safe.statusCode, safe.message)
}

export const waitForDocumentStoreQueueResult = async <T>(job: Pick<Job, 'waitUntilFinished'>, queueEvents: QueueEvents): Promise<T> => {
    try {
        return (await job.waitUntilFinished(queueEvents)) as T
    } catch (error) {
        throw restoreDocumentStoreQueueError(error)
    }
}
