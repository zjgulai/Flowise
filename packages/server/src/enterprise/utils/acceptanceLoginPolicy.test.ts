import {
    ACCEPTANCE_LOGIN_MESSAGE,
    ACCEPTANCE_TOKEN_PREFIX,
    getAcceptanceRunId,
    hashAcceptanceCode,
    isAcceptanceTokenUnexpired
} from './acceptanceLoginPolicy'

const validCode = 'A'.repeat(43)

describe('acceptanceLoginPolicy', () => {
    it.each([undefined, null, 42, '', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`])(
        'rejects malformed code %p without reflecting it',
        (value) => {
            expect(hashAcceptanceCode(value)).toBeUndefined()
            if (String(value).length > 0) expect(ACCEPTANCE_LOGIN_MESSAGE).not.toContain(String(value))
        }
    )

    it('creates the exact namespaced hash', () => {
        expect(hashAcceptanceCode(validCode)).toBe(
            `${ACCEPTANCE_TOKEN_PREFIX}99462e3028ecece1dbaa5ec0c1109eb54a968eec3c53b5b3984e02b4709163e5`
        )
    })

    it('separates different valid codes', () => {
        expect(hashAcceptanceCode('A'.repeat(43))).not.toBe(hashAcceptanceCode('B'.repeat(43)))
    })

    it.each([
        ['flowise-acceptance+run-01@acceptance.invalid', 'run-01'],
        ['real@example.com', undefined],
        ['flowise-acceptance+-bad@acceptance.invalid', undefined],
        [`flowise-acceptance+${'a'.repeat(65)}@acceptance.invalid`, undefined],
        [null, undefined]
    ])('validates synthetic namespace for %p', (email, expected) => {
        expect(getAcceptanceRunId(email)).toBe(expected)
    })

    it('uses a strict server-time expiry boundary', () => {
        const now = new Date('2026-07-22T00:00:00.000Z')
        expect(isAcceptanceTokenUnexpired(new Date(now.getTime() + 1), now)).toBe(true)
        expect(isAcceptanceTokenUnexpired(now, now)).toBe(false)
        expect(isAcceptanceTokenUnexpired(new Date(now.getTime() - 1), now)).toBe(false)
        expect(isAcceptanceTokenUnexpired(null, now)).toBe(false)
        expect(isAcceptanceTokenUnexpired(new Date('invalid'), now)).toBe(false)
    })
})
