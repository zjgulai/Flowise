const REDACTED_ERROR_MESSAGE = '执行失败，详细信息仅对管理员可见'
const SENSITIVE_ERROR_KEY = /^(?:error|errors|exception|stack|stacktrace)$/i

export const redactErrorDetails = (value) => {
    if (Array.isArray(value)) return value.map((item) => redactErrorDetails(item))
    if (!value || typeof value !== 'object') return value

    return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
            key,
            SENSITIVE_ERROR_KEY.test(key) ? REDACTED_ERROR_MESSAGE : redactErrorDetails(nestedValue)
        ])
    )
}
