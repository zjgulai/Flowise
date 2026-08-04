const MAX_DOCUMENT_STORE_REFERENCE_ID_LENGTH = 256

export interface CanonicalDocumentStoreReference {
    storeId: string
    suffix: string
    canonicalValue: string
}

/**
 * Canonical parser shared by save-time validation and import-time remapping.
 * Prefixed Agentflow references retain their typed suffix while whitespace
 * around the identifier and separator is removed.
 */
export const parseCanonicalDocumentStoreReference = (value: unknown, prefixed: boolean): CanonicalDocumentStoreReference | null => {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    if (!normalized || normalized.includes('\0')) return null

    const separatorIndex = prefixed ? normalized.indexOf(':') : -1
    const storeId = (separatorIndex < 0 ? normalized : normalized.slice(0, separatorIndex)).trim()
    const suffix = separatorIndex < 0 ? '' : normalized.slice(separatorIndex).trim()
    if (!storeId || storeId.length > MAX_DOCUMENT_STORE_REFERENCE_ID_LENGTH) return null
    if (suffix.includes('\0')) return null

    return { storeId, suffix, canonicalValue: `${storeId}${suffix}` }
}
