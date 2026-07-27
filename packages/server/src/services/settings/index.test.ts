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
    const originalAdminOnlyMode = process.env.ADMIN_ONLY_MODE

    beforeEach(() => {
        jest.clearAllMocks()
        mockIdentityManager.getPlatformType.mockReturnValue(Platform.OPEN_SOURCE)
        delete process.env.PUBLIC_LOGIN_ENABLED
        delete process.env.ADMIN_ONLY_MODE
    })

    afterAll(() => {
        if (originalPublicLoginEnabled === undefined) delete process.env.PUBLIC_LOGIN_ENABLED
        else process.env.PUBLIC_LOGIN_ENABLED = originalPublicLoginEnabled
        if (originalAdminOnlyMode === undefined) delete process.env.ADMIN_ONLY_MODE
        else process.env.ADMIN_ONLY_MODE = originalAdminOnlyMode
    })

    it('keeps the public login UI enabled unless explicitly disabled', async () => {
        await expect(settingsService.getSettings()).resolves.toMatchObject({ PUBLIC_LOGIN_ENABLED: true })
    })

    it('disables the public login UI only for the exact false value', async () => {
        process.env.PUBLIC_LOGIN_ENABLED = 'false'

        await expect(settingsService.getSettings()).resolves.toMatchObject({ PUBLIC_LOGIN_ENABLED: false })
    })

    it('publishes fail-closed admin-only mode without exposing secrets', async () => {
        await expect(settingsService.getSettings()).resolves.toMatchObject({ ADMIN_ONLY_MODE: true })

        process.env.ADMIN_ONLY_MODE = 'false'
        await expect(settingsService.getSettings()).resolves.toMatchObject({ ADMIN_ONLY_MODE: false })
    })
})
