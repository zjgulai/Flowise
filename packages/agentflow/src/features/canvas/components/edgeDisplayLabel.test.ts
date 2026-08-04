import { getEdgeDisplayLabel } from './edgeDisplayLabel'

describe('getEdgeDisplayLabel', () => {
    it('localizes known human-input branches for display only', () => {
        expect(getEdgeDisplayLabel('proceed', true)).toBe('继续')
        expect(getEdgeDisplayLabel('Proceed', true)).toBe('继续')
        expect(getEdgeDisplayLabel('reject', true)).toBe('拒绝')
        expect(getEdgeDisplayLabel('Reject', true)).toBe('拒绝')
    })

    it('preserves unknown and non-human machine labels', () => {
        expect(getEdgeDisplayLabel('1', false)).toBe('1')
        expect(getEdgeDisplayLabel('custom', true)).toBe('custom')
        expect(getEdgeDisplayLabel('Proceed', false)).toBe('Proceed')
    })

    it('fails safely for non-string labels', () => {
        expect(getEdgeDisplayLabel(undefined, true)).toBeUndefined()
        expect(getEdgeDisplayLabel(null, true)).toBeUndefined()
        expect(getEdgeDisplayLabel(1, true)).toBeUndefined()
        expect(getEdgeDisplayLabel({ label: 'Proceed' }, true)).toBeUndefined()
    })
})
