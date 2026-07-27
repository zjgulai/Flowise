const INVALID_SIGN_IN_ERROR = '登录链接中的错误信息无效，请重试。'
const MAX_ERROR_PARAM_LENGTH = 4096
const MAX_ERROR_MESSAGE_LENGTH = 500

export const parseSignInError = (value) => {
    if (value === null || value === undefined) return null
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ERROR_PARAM_LENGTH) return INVALID_SIGN_IN_ERROR

    const candidates = [value]
    try {
        const decoded = decodeURIComponent(value)
        if (decoded !== value) candidates.push(decoded)
    } catch {
        return INVALID_SIGN_IN_ERROR
    }

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate)
            if (
                parsed &&
                !Array.isArray(parsed) &&
                typeof parsed.message === 'string' &&
                parsed.message.trim().length > 0 &&
                parsed.message.length <= MAX_ERROR_MESSAGE_LENGTH
            ) {
                return parsed.message.trim()
            }
        } catch {
            // Try the next supported encoding before returning the safe fallback.
        }
    }

    return INVALID_SIGN_IN_ERROR
}
