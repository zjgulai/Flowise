/** Localize human-input branch labels for rendering without changing the persisted machine value. */
export function getEdgeDisplayLabel(label: unknown, isHumanInput?: boolean): string | undefined {
    if (typeof label !== 'string') return undefined
    if (!isHumanInput) return label
    if (label === 'proceed' || label === 'Proceed') return '继续'
    if (label === 'reject' || label === 'Reject') return '拒绝'
    return label
}
