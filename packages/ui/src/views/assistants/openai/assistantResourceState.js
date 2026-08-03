import { z } from 'zod/v3'

export const INVALID_ASSISTANT_RESOURCE_MESSAGE = '助手数据无效，无法加载。'
export const INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE = '服务器返回的助手数据无效，请刷新后重试。'

export const createAssistantScopeKey = (scopeParts) => JSON.stringify(scopeParts)

export const hasProviderBoundAssistantState = ({ openAIAssistantId, toolResources }) =>
    Boolean(
        openAIAssistantId ||
            toolResources?.code_interpreter?.file_ids?.length ||
            toolResources?.code_interpreter?.files?.length ||
            toolResources?.file_search?.vector_store_ids?.length ||
            toolResources?.file_search?.files?.length ||
            toolResources?.file_search?.vector_store_object?.id
    )

export const isAssistantOperationCurrent = (operation, current) =>
    operation.scope === current.scope &&
    operation.scopeKey === current.scopeKey &&
    operation.generation === current.generation &&
    operation.assistantId === current.assistantId &&
    operation.openAIAssistantId === current.openAIAssistantId &&
    operation.credential === current.credential &&
    operation.show &&
    current.show

const idSchema = z.string().min(1)
export const MAX_CODE_INTERPRETER_FILES = 20
export const MAX_ASSISTANT_NAME_LENGTH = 256
export const MAX_ASSISTANT_DESCRIPTION_LENGTH = 512
export const MAX_ASSISTANT_INSTRUCTIONS_LENGTH = 256000
const nullableTextSchema = (maxLength) =>
    z
        .string()
        .max(maxLength)
        .nullable()
        .optional()
        .transform((value) => value ?? '')
const nullableNumberSchema = (minimum, maximum) =>
    z
        .number()
        .finite()
        .min(minimum)
        .max(maximum)
        .nullable()
        .optional()
        .transform((value) => value ?? null)

const hasUniqueIds = (values) => new Set(values).size === values.length
const haveSameIds = (left, right) => left.length === right.length && left.every((id) => right.includes(id))

const fileSchema = z
    .object({
        id: idSchema,
        filename: z.string().nullable().optional()
    })
    .passthrough()

const uploadedFilesSchema = z
    .array(fileSchema)
    .min(1)
    .refine((files) => hasUniqueIds(files.map((file) => file.id)))

const vectorStoreSchema = z
    .object({
        id: idSchema,
        name: z.string().nullable().optional()
    })
    .passthrough()

const codeInterpreterSchema = z
    .object({
        file_ids: z.array(idSchema).max(MAX_CODE_INTERPRETER_FILES).optional().default([]),
        files: z.array(fileSchema).max(MAX_CODE_INTERPRETER_FILES).optional().default([])
    })
    .passthrough()
    .refine(
        (codeInterpreter) =>
            hasUniqueIds(codeInterpreter.file_ids) &&
            hasUniqueIds(codeInterpreter.files.map((file) => file.id)) &&
            haveSameIds(
                codeInterpreter.file_ids,
                codeInterpreter.files.map((file) => file.id)
            )
    )

const fileSearchSchema = z
    .object({
        vector_store_ids: z.array(idSchema).max(1).optional().default([]),
        files: z.array(fileSchema).optional().default([]),
        vector_store_object: vectorStoreSchema.nullable().optional().default(null)
    })
    .passthrough()
    .refine((fileSearch) => {
        if (!hasUniqueIds(fileSearch.files.map((file) => file.id))) return false
        const vectorStoreId = fileSearch.vector_store_ids[0]
        if (!vectorStoreId) return fileSearch.files.length === 0 && fileSearch.vector_store_object === null
        return !fileSearch.vector_store_object || fileSearch.vector_store_object.id === vectorStoreId
    })

const toolResourcesSchema = z
    .object({
        code_interpreter: codeInterpreterSchema.nullable().optional(),
        file_search: fileSearchSchema.nullable().optional()
    })
    .strict()
    .nullable()
    .optional()
    .transform((value) => value ?? {})
    .transform((value) => ({
        ...(value.code_interpreter ? { code_interpreter: value.code_interpreter } : {}),
        ...(value.file_search ? { file_search: value.file_search } : {})
    }))

const assistantToolSchema = z.union([
    idSchema,
    z
        .object({
            type: idSchema
        })
        .passthrough()
])

const assistantDetailsSchema = z
    .object({
        id: idSchema,
        name: nullableTextSchema(MAX_ASSISTANT_NAME_LENGTH),
        description: nullableTextSchema(MAX_ASSISTANT_DESCRIPTION_LENGTH),
        model: idSchema,
        instructions: nullableTextSchema(MAX_ASSISTANT_INSTRUCTIONS_LENGTH),
        temperature: nullableNumberSchema(0, 2),
        top_p: nullableNumberSchema(0, 1),
        tools: z.array(assistantToolSchema).max(128).optional().default([]),
        tool_resources: toolResourcesSchema
    })
    .passthrough()
    .transform((details) => ({
        ...details,
        tools: details.tools.map((tool) => (typeof tool === 'string' ? tool : tool.type))
    }))

const storedAssistantResourceSchema = z
    .object({
        id: idSchema,
        iconSrc: z
            .string()
            .nullable()
            .optional()
            .transform((value) => value ?? ''),
        credential: idSchema,
        type: z.literal('OPENAI'),
        details: z.unknown()
    })
    .passthrough()

const deletionResponseSchema = z.union([
    z
        .object({
            affected: z.literal(1)
        })
        .passthrough(),
    z
        .object({
            deleted: z.literal(true),
            id: idSchema
        })
        .passthrough()
])

const safeResult = (result) => (result.success ? { success: true, data: result.data } : { success: false })

export const parseOptionalAssistantNumber = (value) => {
    if (value === '' || value === null || value === undefined) return null
    const parsed = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(parsed) ? parsed : null
}

export const parseAssistantSamplingParams = ({ temperature, topP }) => {
    const temperatureEmpty = temperature === '' || temperature === null || temperature === undefined
    const topPEmpty = topP === '' || topP === null || topP === undefined
    const parsedTemperature = parseOptionalAssistantNumber(temperature)
    const parsedTopP = parseOptionalAssistantNumber(topP)
    if (
        (!temperatureEmpty && parsedTemperature === null) ||
        (!topPEmpty && parsedTopP === null) ||
        (parsedTemperature !== null && (parsedTemperature < 0 || parsedTemperature > 2)) ||
        (parsedTopP !== null && (parsedTopP < 0 || parsedTopP > 1))
    ) {
        return { success: false }
    }
    return { success: true, data: { temperature: parsedTemperature, topP: parsedTopP } }
}

export const validateAssistantTextFields = ({ name, description, instructions }) =>
    typeof name === 'string' &&
    name.length <= MAX_ASSISTANT_NAME_LENGTH &&
    typeof description === 'string' &&
    description.length <= MAX_ASSISTANT_DESCRIPTION_LENGTH &&
    typeof instructions === 'string' &&
    instructions.length <= MAX_ASSISTANT_INSTRUCTIONS_LENGTH

export const parseAssistantDetails = (details) => {
    let parsedDetails = details
    if (typeof details === 'string') {
        try {
            parsedDetails = JSON.parse(details)
        } catch (_error) {
            return { success: false }
        }
    }

    return safeResult(assistantDetailsSchema.safeParse(parsedDetails))
}

export const parseAssistantToolResources = (toolResources) => safeResult(toolResourcesSchema.safeParse(toolResources))

export const parseStoredAssistantResource = (resource) => {
    const parsedResource = storedAssistantResourceSchema.safeParse(resource)
    if (!parsedResource.success) return { success: false }

    const parsedDetails = parseAssistantDetails(parsedResource.data.details)
    if (!parsedDetails.success) return { success: false }

    return {
        success: true,
        data: {
            ...parsedResource.data,
            details: parsedDetails.data
        }
    }
}

const mutationDetailsMatch = (actual, expected) => {
    const expectedToolResources = toolResourcesSchema.safeParse(expected.tool_resources)
    if (!expectedToolResources.success) return false

    const expectedId = expected.id
    return (
        (!expectedId || actual.id === expectedId) &&
        actual.name === (expected.name ?? '') &&
        actual.description === (expected.description ?? '') &&
        actual.model === expected.model &&
        actual.instructions === (expected.instructions ?? '') &&
        actual.temperature === (expected.temperature ?? null) &&
        actual.top_p === (expected.top_p ?? null) &&
        JSON.stringify(actual.tools) === JSON.stringify(expected.tools ?? []) &&
        JSON.stringify(actual.tool_resources) === JSON.stringify(expectedToolResources.data)
    )
}

export const validateAssistantMutationResponse = (
    responseData,
    { expectedAssistantId, expectedCredential, expectedIcon, expectedDetails }
) => {
    const parsedResource = parseStoredAssistantResource(responseData)
    if (!parsedResource.success) return { success: false }
    if (expectedAssistantId && parsedResource.data.id !== expectedAssistantId) return { success: false }
    if (parsedResource.data.credential !== expectedCredential) return { success: false }
    if (expectedIcon !== undefined && parsedResource.data.iconSrc !== expectedIcon) return { success: false }
    if (!mutationDetailsMatch(parsedResource.data.details, expectedDetails)) return { success: false }
    return parsedResource
}

export const validateAssistantDeletionResponse = (responseData, expectedAssistantId) => {
    const parsedResponse = deletionResponseSchema.safeParse(responseData)
    if (!parsedResponse.success) return false
    return 'affected' in parsedResponse.data || parsedResponse.data.id === expectedAssistantId
}

export const appendUploadedCodeInterpreterFiles = ({ uploadedFiles, currentToolResources, expectedFileCount }) => {
    const parsedFiles = uploadedFilesSchema.safeParse(uploadedFiles)
    if (!parsedFiles.success || (expectedFileCount !== undefined && parsedFiles.data.length !== expectedFileCount)) {
        return { success: false }
    }

    const currentCodeInterpreter = codeInterpreterSchema.safeParse(currentToolResources.code_interpreter ?? {})
    if (!currentCodeInterpreter.success) return { success: false }

    const currentIds = currentCodeInterpreter.data.file_ids
    if (
        currentIds.length + parsedFiles.data.length > MAX_CODE_INTERPRETER_FILES ||
        parsedFiles.data.some((file) => currentIds.includes(file.id))
    ) {
        return { success: false }
    }

    return {
        success: true,
        data: {
            ...currentToolResources,
            code_interpreter: {
                ...currentCodeInterpreter.data,
                files: [...currentCodeInterpreter.data.files, ...parsedFiles.data],
                file_ids: [...currentIds, ...parsedFiles.data.map((file) => file.id)]
            }
        }
    }
}

export const removeCodeInterpreterFile = ({ fileId, currentToolResources }) => {
    if (!fileId) return { success: false }
    const currentCodeInterpreter = codeInterpreterSchema.safeParse(currentToolResources.code_interpreter ?? {})
    if (!currentCodeInterpreter.success || !currentCodeInterpreter.data.file_ids.includes(fileId)) return { success: false }

    return {
        success: true,
        data: {
            ...currentToolResources,
            code_interpreter: {
                ...currentCodeInterpreter.data,
                files: currentCodeInterpreter.data.files.filter((file) => file.id !== fileId),
                file_ids: currentCodeInterpreter.data.file_ids.filter((id) => id !== fileId)
            }
        }
    }
}

export const appendUploadedVectorStoreFiles = ({ uploadedFiles, vectorStoreId, currentToolResources, expectedFileCount }) => {
    const parsedFiles = uploadedFilesSchema.safeParse(uploadedFiles)
    const currentFileSearch = fileSearchSchema.safeParse(currentToolResources.file_search)
    if (
        !parsedFiles.success ||
        (expectedFileCount !== undefined && parsedFiles.data.length !== expectedFileCount) ||
        !currentFileSearch.success ||
        currentFileSearch.data.vector_store_ids[0] !== vectorStoreId
    ) {
        return { success: false }
    }

    const currentIds = currentFileSearch.data.files.map((file) => file.id)
    if (parsedFiles.data.some((file) => currentIds.includes(file.id))) return { success: false }

    return {
        success: true,
        data: {
            ...currentToolResources,
            file_search: {
                ...currentFileSearch.data,
                files: [...currentFileSearch.data.files, ...parsedFiles.data]
            }
        }
    }
}
