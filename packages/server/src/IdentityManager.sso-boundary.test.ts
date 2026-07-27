import { Application } from 'express'
import { Platform } from './Interface'

const mockReadOrganization = jest.fn()
const mockReadLoginMethodByOrganizationId = jest.fn()
const mockDecryptLoginMethodConfig = jest.fn()
const mockLoggerWarn = jest.fn()
const mockQueryRunner = {
    connect: jest.fn(),
    release: jest.fn()
}

jest.mock('./utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            createQueryRunner: () => mockQueryRunner
        }
    })
}))

jest.mock('./enterprise/services/organization.service', () => ({
    OrganizationService: jest.fn().mockImplementation(() => ({
        readOrganization: mockReadOrganization
    }))
}))

jest.mock('./enterprise/services/login-method.service', () => ({
    LoginMethodService: jest.fn().mockImplementation(() => ({
        readLoginMethodByOrganizationId: mockReadLoginMethodByOrganizationId,
        decryptLoginMethodConfig: mockDecryptLoginMethodConfig
    }))
}))

jest.mock('./utils/logger', () => ({
    __esModule: true,
    default: { warn: mockLoggerWarn }
}))

jest.mock('./enterprise/sso/AzureSSO', () => ({
    __esModule: true,
    default: class {
        initialize = jest.fn()
        setSSOConfig = jest.fn()
    }
}))
jest.mock('./enterprise/sso/GoogleSSO', () => ({
    __esModule: true,
    default: class {
        initialize = jest.fn()
        setSSOConfig = jest.fn()
    }
}))
jest.mock('./enterprise/sso/Auth0SSO', () => ({
    __esModule: true,
    default: class {
        initialize = jest.fn()
        setSSOConfig = jest.fn()
    }
}))
jest.mock('./enterprise/sso/GithubSSO', () => ({
    __esModule: true,
    default: class {
        initialize = jest.fn()
        setSSOConfig = jest.fn()
    }
}))

import { IdentityManager } from './IdentityManager'

describe('IdentityManager enterprise SSO organization boundary', () => {
    const originalAdminOnlyMode = process.env.ADMIN_ONLY_MODE

    beforeEach(() => {
        jest.clearAllMocks()
        process.env.ADMIN_ONLY_MODE = 'false'
        mockReadOrganization.mockResolvedValue([{ id: 'org-only' }])
        mockReadLoginMethodByOrganizationId.mockResolvedValue([
            { name: 'google', status: 'enable', config: 'encrypted-config', organizationId: 'org-only' }
        ])
        mockDecryptLoginMethodConfig.mockResolvedValue(
            JSON.stringify({ clientID: 'client-id', configEnabled: true, organizationId: 'attacker-selected-org' })
        )
    })

    afterAll(() => {
        if (originalAdminOnlyMode === undefined) delete process.env.ADMIN_ONLY_MODE
        else process.env.ADMIN_ONLY_MODE = originalAdminOnlyMode
    })

    function enterpriseIdentityManager() {
        const identityManager = new IdentityManager()
        identityManager.currentInstancePlatform = Platform.ENTERPRISE
        const initializeProvider = jest.spyOn(identityManager, 'initializeSsoProvider').mockImplementation(() => undefined)
        return { identityManager, initializeProvider }
    }

    it('overrides a persisted provider organization with the sole enterprise organization', async () => {
        const { identityManager, initializeProvider } = enterpriseIdentityManager()

        await identityManager.initializeSSO({} as Application)

        expect(mockReadLoginMethodByOrganizationId).toHaveBeenCalledWith('org-only', mockQueryRunner)
        expect(initializeProvider).toHaveBeenCalledWith(
            {},
            'google',
            expect.objectContaining({ clientID: 'client-id', configEnabled: true, organizationId: 'org-only' })
        )
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('keeps every provider disabled and skips config loading when multiple organizations exist', async () => {
        mockReadOrganization.mockResolvedValue([{ id: 'org-one' }, { id: 'org-two' }])
        const { identityManager, initializeProvider } = enterpriseIdentityManager()

        await identityManager.initializeSSO({} as Application)

        expect(initializeProvider).toHaveBeenCalledTimes(4)
        expect(initializeProvider.mock.calls.every(([, , config]) => config === undefined)).toBe(true)
        expect(mockReadLoginMethodByOrganizationId).not.toHaveBeenCalled()
        expect(mockDecryptLoginMethodConfig).not.toHaveBeenCalled()
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('clears an already configured provider when a second organization exists', async () => {
        mockReadOrganization.mockResolvedValue([{ id: 'org-one' }, { id: 'org-two' }])
        const identityManager = new IdentityManager()
        identityManager.currentInstancePlatform = Platform.ENTERPRISE
        const app = {} as Application
        identityManager.initializeSsoProvider(app, 'google', { clientID: 'client-id', configEnabled: true })
        const googleProvider = identityManager.ssoProviders.get('google') as any
        googleProvider.setSSOConfig.mockClear()

        await identityManager.initializeSSO(app)

        expect(googleProvider.setSSOConfig).toHaveBeenCalledWith(undefined)
        expect(mockReadLoginMethodByOrganizationId).not.toHaveBeenCalled()
    })

    it('preserves admin-only mode by disabling providers before any datastore access', async () => {
        process.env.ADMIN_ONLY_MODE = 'true'
        const { identityManager, initializeProvider } = enterpriseIdentityManager()

        await identityManager.initializeSSO({} as Application)

        expect(initializeProvider).toHaveBeenCalledTimes(4)
        expect(initializeProvider.mock.calls.every(([, , config]) => config === undefined)).toBe(true)
        expect(mockReadOrganization).not.toHaveBeenCalled()
        expect(mockQueryRunner.connect).not.toHaveBeenCalled()
    })

    it('skips and security-logs a historical unsupported provider without decrypting its config or failing startup', async () => {
        mockReadLoginMethodByOrganizationId.mockResolvedValue([
            {
                name: 'unsupported-provider',
                status: 'enable',
                config: 'encrypted-client-secret-must-not-be-logged',
                organizationId: 'org-only'
            }
        ])
        const { identityManager, initializeProvider } = enterpriseIdentityManager()

        await expect(identityManager.initializeSSO({} as Application)).resolves.toBeUndefined()

        expect(mockDecryptLoginMethodConfig).not.toHaveBeenCalled()
        expect(initializeProvider.mock.calls.some(([, providerName]) => providerName === 'unsupported-provider')).toBe(false)
        expect(mockLoggerWarn).toHaveBeenCalledWith('sso_provider_initialization_skipped_invalid_provider')
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('unsupported-provider')
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('encrypted-client-secret-must-not-be-logged')
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })
})
