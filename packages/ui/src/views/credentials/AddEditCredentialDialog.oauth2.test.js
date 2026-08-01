/** @jest-environment ./test/canvasless-jsdom-environment.cjs */

jest.mock('@/store/constant', () => ({
    baseURL: 'https://flowise.example.invalid',
    REDACTED_CREDENTIAL_VALUE: 'redacted'
}))

import { createOAuth2PopupSession } from './AddEditCredentialDialog'

const createHarness = () => {
    const scheduled = {}
    const eventTarget = {
        addEventListener: jest.fn((_type, callback) => {
            scheduled.message = callback
        }),
        removeEventListener: jest.fn(),
        setInterval: jest.fn((callback) => {
            scheduled.closedCheck = callback
            return 11
        }),
        clearInterval: jest.fn(),
        setTimeout: jest.fn((callback) => {
            scheduled.timeout = callback
            return 22
        }),
        clearTimeout: jest.fn()
    }
    const authWindow = {
        closed: false,
        close: jest.fn(() => {
            authWindow.closed = true
        })
    }
    const onSuccess = jest.fn()
    const onFailure = jest.fn()
    const credentialId = 'credential-1'
    const expectedOrigin = 'https://flowise.example.invalid'

    createOAuth2PopupSession({ authWindow, credentialId, expectedOrigin, eventTarget, onSuccess, onFailure })

    const trustedSuccess = {
        origin: expectedOrigin,
        source: authWindow,
        data: { type: 'OAUTH2_SUCCESS', success: true, credentialId }
    }

    return { authWindow, eventTarget, onSuccess, onFailure, scheduled, trustedSuccess }
}

describe('OAuth2 popup session', () => {
    it('fails closed when the closed-window check wins the race against a queued success message', () => {
        const { authWindow, eventTarget, onSuccess, onFailure, scheduled, trustedSuccess } = createHarness()

        authWindow.closed = true
        scheduled.closedCheck()
        scheduled.message(trustedSuccess)

        expect(onSuccess).not.toHaveBeenCalled()
        expect(onFailure).toHaveBeenCalledTimes(1)
        expect(onFailure).toHaveBeenCalledWith('closed')
        expect(eventTarget.clearInterval).toHaveBeenCalledWith(11)
        expect(eventTarget.clearTimeout).toHaveBeenCalledWith(22)
        expect(eventTarget.removeEventListener).toHaveBeenCalledWith('message', scheduled.message)
    })

    it('settles successfully only for a trusted success message and ignores every later signal', () => {
        const { authWindow, onSuccess, onFailure, scheduled, trustedSuccess } = createHarness()

        scheduled.message({ ...trustedSuccess, origin: 'https://attacker.example.invalid' })
        expect(onSuccess).not.toHaveBeenCalled()

        scheduled.message(trustedSuccess)
        scheduled.closedCheck()
        scheduled.timeout()

        expect(onSuccess).toHaveBeenCalledTimes(1)
        expect(onFailure).not.toHaveBeenCalled()
        expect(authWindow.close).toHaveBeenCalledTimes(1)
    })
})
