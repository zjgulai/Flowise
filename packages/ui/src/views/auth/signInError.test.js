import { parseSignInError } from './signInError'

const fallback = '登录链接中的错误信息无效，请重试。'

describe('parseSignInError', () => {
    it('returns null when the query parameter is absent', () => {
        expect(parseSignInError(null)).toBeNull()
    })

    it('extracts a bounded message from valid JSON', () => {
        expect(parseSignInError(JSON.stringify({ message: '会话已过期，请重新登录。' }))).toBe('会话已过期，请重新登录。')
    })

    it.each(['not-json', '[]', '{}', JSON.stringify({ message: '' }), 'x'.repeat(4097)])('fails closed for malformed input %#', (value) => {
        expect(parseSignInError(value)).toBe(fallback)
    })
})
