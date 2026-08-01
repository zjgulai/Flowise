const HUMAN_INPUT_EDGE_LABELS = Object.freeze({
    proceed: '继续',
    Proceed: '继续',
    reject: '拒绝',
    Reject: '拒绝'
})

/**
 * Translate known human-input branch labels for rendering only.
 *
 * The raw label remains on the edge data so saves, handles, and other machine
 * contracts continue to use the original value.
 */
export const getEdgeDisplayLabel = (label, isHumanInput = false) => {
    if (typeof label !== 'string') return undefined
    if (!isHumanInput) return label
    return HUMAN_INPUT_EDGE_LABELS[label] ?? label
}
