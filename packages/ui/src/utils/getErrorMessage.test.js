import { getErrorMessage } from './getErrorMessage'

describe('getErrorMessage', () => {
    it('does not expose arbitrary server response details', () => {
        expect(getErrorMessage({ response: { data: { message: '服务拒绝请求：内部令牌详情' } } })).toBe('操作失败，请稍后重试')
        expect(getErrorMessage({ response: { data: 'database stack and secret details' } }, '请求未完成')).toBe('请求未完成')
    })

    it('localizes a network error without dereferencing a missing response', () => {
        expect(getErrorMessage(new Error('Network Error'))).toBe('网络连接失败')
        expect(getErrorMessage(new Error('Failed to fetch'))).toBe('网络请求失败')
        expect(getErrorMessage(new Error('timeout of 10000ms exceeded'))).toBe('请求超时')
    })

    it('uses the supplied Chinese fallback for an empty error', () => {
        expect(getErrorMessage(undefined, '暂时无法完成操作')).toBe('暂时无法完成操作')
    })

    it('uses the supplied Chinese fallback for unknown runtime errors', () => {
        expect(getErrorMessage(new Error('Unexpected internal implementation detail'), '暂时无法完成操作')).toBe('暂时无法完成操作')
    })
})
