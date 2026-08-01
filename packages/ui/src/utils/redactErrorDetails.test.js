import { redactErrorDetails } from './redactErrorDetails'

describe('redactErrorDetails', () => {
    it('redacts nested error-bearing fields while preserving safe data', () => {
        const input = {
            output: 'safe output',
            error: { message: 'provider secret', requestId: 'internal-id' },
            nested: [{ stackTrace: 'private stack' }, { status: 'complete' }]
        }

        expect(redactErrorDetails(input)).toEqual({
            output: 'safe output',
            error: '执行失败，详细信息仅对管理员可见',
            nested: [{ stackTrace: '执行失败，详细信息仅对管理员可见' }, { status: 'complete' }]
        })
        expect(JSON.stringify(input)).toContain('provider secret')
    })

    it('preserves primitives and null', () => {
        expect(redactErrorDetails(null)).toBeNull()
        expect(redactErrorDetails('safe')).toBe('safe')
    })
})
