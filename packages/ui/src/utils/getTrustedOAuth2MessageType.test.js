import { getTrustedOAuth2MessageType } from './getTrustedOAuth2MessageType'

describe('getTrustedOAuth2MessageType', () => {
    const expectedOrigin = 'https://flowise.example.invalid'
    const expectedSource = {}
    const credentialId = 'credential-1'

    const classify = (event) => getTrustedOAuth2MessageType(event, { expectedOrigin, expectedSource, credentialId })

    it('accepts a same-origin success from the exact authorization window', () => {
        expect(
            classify({
                origin: expectedOrigin,
                source: expectedSource,
                data: { type: 'OAUTH2_SUCCESS', success: true, credentialId, message: 'completed' }
            })
        ).toBe('OAUTH2_SUCCESS')
    })

    it('accepts a bounded error signal without returning its untrusted detail', () => {
        expect(
            classify({
                origin: expectedOrigin,
                source: expectedSource,
                data: { type: 'OAUTH2_ERROR', success: false, message: 'untrusted detail', error: 'provider_error' }
            })
        ).toBe('OAUTH2_ERROR')
    })

    it.each([
        ['wrong origin', { origin: 'https://attacker.example.invalid', source: expectedSource }],
        ['wrong window', { origin: expectedOrigin, source: {} }],
        [
            'wrong credential',
            { origin: expectedOrigin, source: expectedSource, data: { type: 'OAUTH2_SUCCESS', success: true, credentialId: 'other' } }
        ],
        [
            'unexpected field',
            { origin: expectedOrigin, source: expectedSource, data: { type: 'OAUTH2_ERROR', success: false, token: 'secret' } }
        ]
    ])('rejects %s', (_name, overrides) => {
        expect(
            classify({
                origin: expectedOrigin,
                source: expectedSource,
                data: { type: 'OAUTH2_ERROR', success: false },
                ...overrides
            })
        ).toBeNull()
    })
})
