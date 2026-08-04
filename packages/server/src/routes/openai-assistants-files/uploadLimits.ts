import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getMulterStorage } from '../../utils'

const DEFAULT_FILE_SIZE_LIMIT = 50 * 1024 * 1024
export const ASSISTANT_FILE_COUNT_LIMIT = 20
export const ASSISTANT_MULTIPART_PART_LIMIT = ASSISTANT_FILE_COUNT_LIMIT + 1

export const parseFileSizeLimit = (value: string | undefined): number => {
    if (!value) return DEFAULT_FILE_SIZE_LIMIT
    const match = value
        .trim()
        .toLowerCase()
        .match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/)
    if (!match) return DEFAULT_FILE_SIZE_LIMIT

    const multipliers: Record<string, number> = {
        b: 1,
        kb: 1024,
        kib: 1024,
        mb: 1024 * 1024,
        mib: 1024 * 1024,
        gb: 1024 * 1024 * 1024,
        gib: 1024 * 1024 * 1024
    }
    const bytes = Number(match[1]) * multipliers[match[2] ?? 'b']
    return Number.isSafeInteger(Math.floor(bytes)) && bytes > 0 ? Math.floor(bytes) : DEFAULT_FILE_SIZE_LIMIT
}

type ConfigurableMulter = ReturnType<typeof getMulterStorage> & {
    limits?: Record<string, number>
}

export const createAssistantUploadWithinLimits = () => {
    const assistantFileUpload = getMulterStorage() as ConfigurableMulter
    assistantFileUpload.limits = {
        ...(assistantFileUpload.limits ?? {}),
        fileSize: parseFileSizeLimit(process.env.FLOWISE_FILE_SIZE_LIMIT),
        files: ASSISTANT_FILE_COUNT_LIMIT,
        parts: ASSISTANT_MULTIPART_PART_LIMIT
    }
    const assistantFileUploadMiddleware = assistantFileUpload.array('files', ASSISTANT_FILE_COUNT_LIMIT)

    return (req: Request, res: Response, next: NextFunction) => {
        assistantFileUploadMiddleware(req, res, (error: unknown) => {
            if (!error) return next()
            return next(new InternalFlowiseError(StatusCodes.REQUEST_TOO_LONG, 'Assistant file upload exceeds the allowed limits'))
        })
    }
}
