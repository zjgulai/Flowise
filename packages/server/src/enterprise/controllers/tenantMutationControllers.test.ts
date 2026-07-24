import { NextFunction, Request, Response } from 'express'

const mockCreateRole = jest.fn()
const mockUpdateRole = jest.fn()
const mockDeleteRole = jest.fn()
const mockCreateLoginMethod = jest.fn()
const mockCreateOrUpdateConfig = jest.fn()
const mockGetConfigWithSecrets = jest.fn()
const mockReadLoginMethodByOrganizationId = jest.fn()
const mockReadOrganization = jest.fn()
const mockGoogleTestSetup = jest.fn()
const mockInitializeSsoProvider = jest.fn()

const mockQueryRunner = {
    connect: jest.fn(),
    release: jest.fn(),
    manager: {}
}
const mockCreateQueryRunner = jest.fn(() => mockQueryRunner)

const mockGetRunningExpressApp = jest.fn(() => ({
    identityManager: {
        getPlatformType: jest.fn(() => 'enterprise'),
        initializeSsoProvider: mockInitializeSsoProvider
    },
    AppDataSource: {
        createQueryRunner: mockCreateQueryRunner
    },
    app: {}
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

jest.mock('../services/role.service', () => ({
    RoleErrorMessage: { ROLE_NOT_FOUND: 'Role Not Found' },
    RoleService: jest.fn().mockImplementation(() => ({
        createRole: mockCreateRole,
        updateRole: mockUpdateRole,
        deleteRole: mockDeleteRole
    }))
}))

jest.mock('../services/login-method.service', () => ({
    LoginMethodErrorMessage: {
        INVALID_LOGIN_METHOD_CONFIG: 'Invalid Login Method Config',
        LOGIN_METHOD_NOT_FOUND: 'Login Method Not Found'
    },
    LoginMethodService: jest.fn().mockImplementation(() => ({
        createLoginMethod: mockCreateLoginMethod,
        createOrUpdateConfig: mockCreateOrUpdateConfig,
        getConfigWithSecrets: mockGetConfigWithSecrets,
        readLoginMethodByOrganizationId: mockReadLoginMethodByOrganizationId
    }))
}))

jest.mock('../services/organization.service', () => ({
    OrganizationService: jest.fn().mockImplementation(() => ({
        readOrganization: mockReadOrganization
    }))
}))

jest.mock('../utils/tenantRequestGuards', () => ({
    getLoggedInUser: (req: Request) => req.user,
    assertQueryOrganizationMatchesActiveOrg: (user: { activeOrganizationId: string }, organizationId?: string) => {
        if (organizationId && organizationId !== user.activeOrganizationId) {
            throw Object.assign(new Error('Forbidden'), { statusCode: 403 })
        }
    }
}))

jest.mock('../sso/AzureSSO', () => ({
    __esModule: true,
    default: { getCallbackURL: jest.fn(), testSetup: jest.fn() }
}))

jest.mock('../sso/GoogleSSO', () => ({
    __esModule: true,
    default: { getCallbackURL: jest.fn(), testSetup: mockGoogleTestSetup }
}))

jest.mock('../sso/Auth0SSO', () => ({
    __esModule: true,
    default: { getCallbackURL: jest.fn(), testSetup: jest.fn() }
}))

jest.mock('../sso/GithubSSO', () => ({
    __esModule: true,
    default: { getCallbackURL: jest.fn(), testSetup: jest.fn() }
}))

import { LoginMethodController } from './login-method.controller'
import { RoleController } from './role.controller'

const activeUser = {
    id: 'user-active',
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: true,
    permissions: ['roles:manage', 'sso:manage']
}

function requestWith(body: Record<string, unknown> = {}, query: Record<string, unknown> = {}, user = activeUser): Request {
    return { body, query, user } as unknown as Request
}

function response(): Response {
    const res = {} as Response
    res.status = jest.fn(() => res)
    res.json = jest.fn(() => res)
    return res
}

describe('role mutation controller tenant binding', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCreateRole.mockResolvedValue({ id: 'generated-role' })
        mockUpdateRole.mockResolvedValue({ id: 'role-active' })
        mockDeleteRole.mockResolvedValue({ message: 'deleted' })
    })

    it('whitelists the create DTO and binds tenant/audit fields to the session', async () => {
        const req = requestWith({
            id: 'attacker-selected-id',
            organizationId: 'org-active',
            name: 'Operators',
            description: 'Can operate flows',
            permissions: 'chatflows:view',
            createdBy: 'attacker',
            updatedBy: 'attacker',
            createdDate: '2000-01-01'
        })

        await new RoleController().create(req, response(), jest.fn() as NextFunction)

        expect(mockCreateRole).toHaveBeenCalledTimes(1)
        const data = mockCreateRole.mock.calls[0][0]
        expect(data).toEqual({
            organizationId: 'org-active',
            name: 'Operators',
            description: 'Can operate flows',
            permissions: 'chatflows:view',
            createdBy: 'user-active',
            updatedBy: 'user-active'
        })
        expect(data.id).toBeUndefined()
    })

    it('rejects a cross-tenant update before invoking the role service', async () => {
        const next = jest.fn()

        await new RoleController().update(
            requestWith({ id: 'role-other', organizationId: 'org-other', name: 'Compromised' }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
        expect(mockUpdateRole).not.toHaveBeenCalled()
    })

    it('binds role updates to the active organization and authenticated actor', async () => {
        await new RoleController().update(
            requestWith({
                id: 'role-active',
                organizationId: 'org-active',
                name: 'Operators',
                permissions: 'chatflows:view',
                createdBy: 'attacker',
                updatedBy: 'attacker'
            }),
            response(),
            jest.fn() as NextFunction
        )

        expect(mockUpdateRole).toHaveBeenCalledWith(
            {
                id: 'role-active',
                organizationId: 'org-active',
                name: 'Operators',
                description: undefined,
                permissions: 'chatflows:view',
                updatedBy: 'user-active'
            },
            'org-active'
        )
    })

    it('rejects a cross-tenant delete before invoking the role service', async () => {
        const next = jest.fn()

        await new RoleController().delete(requestWith({}, { id: 'role-other', organizationId: 'org-other' }), response(), next)

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
        expect(mockDeleteRole).not.toHaveBeenCalled()
    })
})

describe('login-method mutation controller tenant binding', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCreateLoginMethod.mockResolvedValue({ id: 'generated-login-method' })
        mockCreateOrUpdateConfig.mockResolvedValue({ status: 'OK', organizationId: 'org-active' })
        mockGetConfigWithSecrets.mockResolvedValue({ clientID: 'stored-client', clientSecret: 'stored-secret' })
        mockReadLoginMethodByOrganizationId.mockResolvedValue([])
        mockReadOrganization.mockResolvedValue([{ id: 'org-active' }])
        mockGoogleTestSetup.mockResolvedValue({ message: 'valid' })
    })

    it('whitelists the create DTO and drops an attacker-selected primary key', async () => {
        await new LoginMethodController().create(
            requestWith({
                id: 'attacker-selected-id',
                organizationId: 'org-active',
                name: 'google',
                config: '{"clientID":"client"}',
                status: 'enable',
                createdBy: 'attacker',
                updatedBy: 'attacker'
            }),
            response(),
            jest.fn() as NextFunction
        )

        expect(mockCreateLoginMethod).toHaveBeenCalledTimes(1)
        const data = mockCreateLoginMethod.mock.calls[0][0]
        expect(data).toEqual({
            organizationId: 'org-active',
            name: 'google',
            config: '{"clientID":"client"}',
            status: 'enable',
            createdBy: 'user-active',
            updatedBy: 'user-active'
        })
        expect(data.id).toBeUndefined()
    })

    it('rejects an unsupported provider create before opening a datastore connection or writing', async () => {
        const next = jest.fn()

        await new LoginMethodController().create(
            requestWith({
                organizationId: 'org-active',
                name: 'unsupported-provider',
                config: '{"clientSecret":"must-not-be-persisted"}',
                status: 'enable'
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
        expect(mockCreateQueryRunner).not.toHaveBeenCalled()
        expect(mockCreateLoginMethod).not.toHaveBeenCalled()
    })

    it('rejects malformed provider config before committing an SSO update', async () => {
        const next = jest.fn()

        await new LoginMethodController().update(
            requestWith({
                organizationId: 'org-active',
                providers: [{ providerName: 'google', config: null, status: 'enable' }]
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
        expect(mockCreateOrUpdateConfig).not.toHaveBeenCalled()
    })

    it('rejects an unsupported provider update before opening a datastore connection or writing', async () => {
        const next = jest.fn()

        await new LoginMethodController().update(
            requestWith({
                organizationId: 'org-active',
                providers: [
                    {
                        providerName: 'unsupported-provider',
                        config: { clientID: 'client', clientSecret: 'must-not-be-persisted' },
                        status: 'enable'
                    }
                ]
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
        expect(mockCreateQueryRunner).not.toHaveBeenCalled()
        expect(mockCreateOrUpdateConfig).not.toHaveBeenCalled()
        expect(mockInitializeSsoProvider).not.toHaveBeenCalled()
    })

    it('fails closed before a global SSO update when enterprise contains multiple organizations', async () => {
        mockReadOrganization.mockResolvedValue([{ id: 'org-active' }, { id: 'org-other' }])
        const next = jest.fn()

        await new LoginMethodController().update(
            requestWith({
                organizationId: 'org-active',
                providers: [{ providerName: 'google', config: { clientID: 'client' }, status: 'enable' }]
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
        expect(mockCreateOrUpdateConfig).not.toHaveBeenCalled()
        expect(mockInitializeSsoProvider).not.toHaveBeenCalled()
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('binds a hot-reloaded SSO provider to the sole active organization', async () => {
        await new LoginMethodController().update(
            requestWith({
                organizationId: 'org-active',
                providers: [
                    {
                        providerName: 'google',
                        config: { clientID: 'client', organizationId: 'attacker-selected-org' },
                        status: 'enable'
                    }
                ]
            }),
            response(),
            jest.fn() as NextFunction
        )

        expect(mockInitializeSsoProvider).toHaveBeenCalledWith(
            {},
            'google',
            expect.objectContaining({ clientID: 'client', configEnabled: true, organizationId: 'org-active' })
        )
    })

    it('hot-disables a provider even when the disabled payload has no client ID', async () => {
        await new LoginMethodController().update(
            requestWith({
                organizationId: 'org-active',
                providers: [{ providerName: 'google', config: {}, status: 'disable' }]
            }),
            response(),
            jest.fn() as NextFunction
        )

        expect(mockInitializeSsoProvider).toHaveBeenCalledWith(
            {},
            'google',
            expect.objectContaining({ configEnabled: false, organizationId: 'org-active' })
        )
    })

    it('returns no public SSO providers when enterprise contains multiple organizations', async () => {
        mockReadOrganization.mockResolvedValue([{ id: 'org-active' }, { id: 'org-other' }])
        const res = response()

        await new LoginMethodController().defaultMethods(requestWith(), res, jest.fn() as NextFunction)

        expect(res.status).toHaveBeenCalledWith(200)
        expect(res.json).toHaveBeenCalledWith({})
        expect(mockReadLoginMethodByOrganizationId).not.toHaveBeenCalled()
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects a cross-tenant SSO test before a datastore or provider call', async () => {
        const next = jest.fn()

        await new LoginMethodController().testConfig(
            requestWith({
                organizationId: 'org-other',
                providerName: 'google',
                providers: [{ providerName: 'google', config: { clientID: 'client', clientSecret: 'secret' } }]
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
        expect(mockCreateQueryRunner).not.toHaveBeenCalled()
        expect(mockGetConfigWithSecrets).not.toHaveBeenCalled()
        expect(mockGoogleTestSetup).not.toHaveBeenCalled()
    })

    it('rejects an unsupported provider test before opening a datastore connection or calling an adapter', async () => {
        const next = jest.fn()

        await new LoginMethodController().testConfig(
            requestWith({
                organizationId: 'org-active',
                providerName: 'unsupported-provider',
                providers: [{ providerName: 'google', config: { clientID: 'client' } }]
            }),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
        expect(mockCreateQueryRunner).not.toHaveBeenCalled()
        expect(mockGetConfigWithSecrets).not.toHaveBeenCalled()
        expect(mockGoogleTestSetup).not.toHaveBeenCalled()
    })

    it('rejects a non-admin direct SSO test before a provider call', async () => {
        const next = jest.fn()
        const nonAdmin = { ...activeUser, isOrganizationAdmin: false }

        await new LoginMethodController().testConfig(
            requestWith(
                {
                    organizationId: 'org-active',
                    providerName: 'google',
                    providers: [{ providerName: 'google', config: { clientID: 'client' } }]
                },
                {},
                nonAdmin
            ),
            response(),
            next
        )

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }))
        expect(mockGoogleTestSetup).not.toHaveBeenCalled()
    })

    it('loads secrets only from the active organization before the provider test', async () => {
        const res = response()

        await new LoginMethodController().testConfig(
            requestWith({
                organizationId: 'org-active',
                providerName: 'google',
                providers: [{ providerName: 'google', config: { clientID: 'incoming-client', clientSecret: '********' } }]
            }),
            res,
            jest.fn() as NextFunction
        )

        expect(mockGetConfigWithSecrets).toHaveBeenCalledWith(
            'org-active',
            'google',
            { clientID: 'incoming-client', clientSecret: '********' },
            mockQueryRunner
        )
        expect(mockGoogleTestSetup).toHaveBeenCalledWith({ clientID: 'stored-client', clientSecret: 'stored-secret' })
        expect(res.json).toHaveBeenCalledWith({ message: 'valid' })
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })
})
