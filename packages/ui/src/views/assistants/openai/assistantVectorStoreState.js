import { z } from 'zod/v3'

const idSchema = z.string().min(1)
const fileSchema = z
    .object({
        id: idSchema,
        filename: z.string().nullable().optional()
    })
    .passthrough()

const vectorStoreSchema = z
    .object({
        id: idSchema,
        object: z.literal('vector_store'),
        name: z.string(),
        status: z.enum(['expired', 'in_progress', 'completed']),
        expires_after: z
            .object({
                anchor: z.literal('last_active_at'),
                days: z.number().int().positive()
            })
            .nullable()
            .optional()
            .transform((value) => value ?? null),
        file_counts: z
            .object({
                in_progress: z.number().int().nonnegative(),
                completed: z.number().int().nonnegative(),
                failed: z.number().int().nonnegative(),
                cancelled: z.number().int().nonnegative(),
                total: z.number().int().nonnegative()
            })
            .passthrough()
            .refine((counts) => counts.in_progress + counts.completed + counts.failed + counts.cancelled === counts.total),
        usage_bytes: z.number().int().nonnegative(),
        files: z.array(fileSchema).optional()
    })
    .passthrough()

const vectorStoreListSchema = z
    .array(vectorStoreSchema)
    .max(10_000)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length)

const vectorStoreDeletionSchema = z
    .object({
        id: idSchema,
        deleted: z.literal(true)
    })
    .passthrough()

const safeResult = (result) => (result.success ? { success: true, data: result.data } : { success: false })

export const parseAssistantVectorStore = (value, expectedId) => {
    const parsed = safeResult(vectorStoreSchema.safeParse(value))
    if (!parsed.success || (expectedId && parsed.data.id !== expectedId)) return { success: false }
    return parsed
}

export const parseAssistantVectorStoreList = (value) => safeResult(vectorStoreListSchema.safeParse(value))

export const validateAssistantVectorStoreMutation = (value, { expectedId, expectedBody, requireFiles = false }) => {
    const parsed = parseAssistantVectorStore(value, expectedId)
    if (!parsed.success) return { success: false }
    if (requireFiles && !Array.isArray(parsed.data.files)) return { success: false }
    if (parsed.data.name !== (expectedBody.name ?? '')) return { success: false }
    if (JSON.stringify(parsed.data.expires_after) !== JSON.stringify(expectedBody.expires_after ?? null)) return { success: false }
    return parsed
}

export const validateAssistantVectorStoreDeletion = (value, expectedId) => {
    const parsed = vectorStoreDeletionSchema.safeParse(value)
    return parsed.success && parsed.data.id === expectedId
}

export const parseAssistantVectorStoreExpirationDays = (value) => {
    if (value === '' || value === null || value === undefined) return null
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export const buildAssistantVectorStoreMutationBody = ({ type, name, isExpirationOn, expirationDays }) => {
    if (!['ADD', 'EDIT'].includes(type) || typeof name !== 'string') return { success: false }
    const parsedExpirationDays = isExpirationOn ? parseAssistantVectorStoreExpirationDays(expirationDays) : null
    if (isExpirationOn && parsedExpirationDays === null) return { success: false }
    return {
        success: true,
        data: {
            ...(name !== '' ? { name } : type === 'EDIT' ? { name: null } : {}),
            ...(isExpirationOn
                ? { expires_after: { anchor: 'last_active_at', days: parsedExpirationDays } }
                : type === 'EDIT'
                ? { expires_after: null }
                : {})
        }
    }
}

export const isAssistantVectorStoreOperationCurrent = (operation, current) =>
    operation.scopeKey === current.scopeKey &&
    operation.generation === current.generation &&
    operation.credential === current.credential &&
    operation.show &&
    current.show
