import { Platform } from '../../Interface'

const mockIdentityManager = {
    getPlatformType: jest.fn(),
    isLicenseValid: jest.fn()
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => ({ identityManager: mockIdentityManager }))
}))

import settingsService from './index'

describe('settings public login contract', () => {
    const originalPublicLoginEnabled = process.env.PUBLIC_LOGIN_ENABLED

    beforeEach(() => {
        jest.clearAllMocks()
        mockIdentityManager.getPlatformType.mockReturnValue(Platform.OPEN_SOURCE)
        delete process.env.PUBLIC_LOGIN_ENABLED
    })

    afterAll(() => {
        if (originalPublicLoginEnabled === undefined) delete process.env.PUBLIC_LOGIN_ENABLED
        else process.env.PUBLIC_LOGIN_ENABLED = originalPublicLoginEnabled
    })

    it('keeps the public login UI enabled unless explicitly disabled', async () => {
        await expect(settingsService.getSettings()).resolves.toMatchObject({ PUBLIC_LOGIN_ENABLED: true })
    })

    it('disables the public login UI only for the exact false value', async () => {
        process.env.PUBLIC_LOGIN_ENABLED = 'false'

        await expect(settingsService.getSettings()).resolves.toMatchObject({ PUBLIC_LOGIN_ENABLED: false })
    })
})
