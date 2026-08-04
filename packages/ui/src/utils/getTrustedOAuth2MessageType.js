const SUCCESS_KEYS = new Set(['type', 'credentialId', 'success', 'message'])
const ERROR_KEYS = new Set(['type', 'success', 'message', 'error'])

const hasOnlyKeys = (value, allowedKeys) => Object.keys(value).every((key) => allowedKeys.has(key))
const hasOptionalString = (value, key) => value[key] === undefined || typeof value[key] === 'string'

export const getTrustedOAuth2MessageType = (event, { expectedOrigin, expectedSource, credentialId }) => {
    if (event?.origin !== expectedOrigin || event?.source !== expectedSource) return null

    const data = event.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    if (data.type === 'OAUTH2_SUCCESS') {
        if (!hasOnlyKeys(data, SUCCESS_KEYS)) return null
        if (data.success !== true || data.credentialId !== credentialId || !hasOptionalString(data, 'message')) return null
        return 'OAUTH2_SUCCESS'
    }

    if (data.type === 'OAUTH2_ERROR') {
        if (!hasOnlyKeys(data, ERROR_KEYS)) return null
        if (data.success !== false || !hasOptionalString(data, 'message') || !hasOptionalString(data, 'error')) return null
        return 'OAUTH2_ERROR'
    }

    return null
}
