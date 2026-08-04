export const getStateKeyOptions = (serializedState) => {
    if (!serializedState) return []

    try {
        const parsedState = JSON.parse(serializedState)
        if (Array.isArray(parsedState)) {
            return parsedState.map((item) => item?.key).filter((key) => typeof key === 'string' && key.length > 0)
        }
        if (parsedState && typeof parsedState === 'object') return Object.keys(parsedState)
    } catch {
        // Invalid legacy state metadata has no selectable keys.
    }

    return []
}
