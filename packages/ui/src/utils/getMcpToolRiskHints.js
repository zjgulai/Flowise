const BOOLEAN_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

export const getMcpToolRiskHints = (annotations = {}) => {
    const readOnly = annotations.readOnlyHint === true
    const writable = !readOnly

    return {
        readOnly,
        writable,
        additiveWrite: writable && annotations.destructiveHint === false,
        destructive: writable && annotations.destructiveHint !== false,
        idempotent: writable && annotations.idempotentHint === true,
        nonIdempotent: writable && annotations.idempotentHint !== true,
        openWorld: annotations.openWorldHint !== false,
        riskUnknown: BOOLEAN_HINTS.some((hint) => typeof annotations[hint] !== 'boolean')
    }
}
