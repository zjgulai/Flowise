const localizeTransportMessage = (message) => {
    const normalized = message.trim()

    if (/^network error$/i.test(normalized)) return '网络连接失败'
    if (/^(?:failed to fetch|load failed)$/i.test(normalized)) return '网络请求失败'
    if (/^(?:request )?(?:aborted|cancelled|canceled)$/i.test(normalized)) return '请求已取消'
    if (/timeout|timed out|etimedout/i.test(normalized)) return '请求超时'

    return null
}

export const getErrorMessage = (error, fallback = '操作失败，请稍后重试') => {
    const responseData = error?.response?.data
    const candidates = []

    if (typeof responseData === 'string' && responseData.trim()) candidates.push(responseData)
    if (responseData && typeof responseData === 'object') {
        const responseMessage = responseData.message ?? responseData.error
        if (typeof responseMessage === 'string' && responseMessage.trim()) candidates.push(responseMessage)
    }
    if (typeof error?.message === 'string' && error.message.trim()) candidates.push(error.message)

    for (const candidate of candidates) {
        const localizedMessage = localizeTransportMessage(candidate)
        if (localizedMessage) return localizedMessage
    }

    return fallback
}
