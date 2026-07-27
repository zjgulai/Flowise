import { StatusCodes } from 'http-status-codes'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertAccountProvisioningAllowed, assertAdminPasswordLoginAllowed, isAdminOnlyModeEnabled } from './adminOnlyPolicy'

describe('admin-only mode policy', () => {
    const original = process.env.ADMIN_ONLY_MODE

    afterEach(() => {
        if (original === undefined) delete process.env.ADMIN_ONLY_MODE
        else process.env.ADMIN_ONLY_MODE = original
    })

    it('fails closed by default and only disables for the exact false value', () => {
        delete process.env.ADMIN_ONLY_MODE
        expect(isAdminOnlyModeEnabled()).toBe(true)

        process.env.ADMIN_ONLY_MODE = 'false'
        expect(isAdminOnlyModeEnabled()).toBe(false)

        process.env.ADMIN_ONLY_MODE = 'FALSE'
        expect(isAdminOnlyModeEnabled()).toBe(true)
    })

    it('rejects account provisioning before a service can write', () => {
        delete process.env.ADMIN_ONLY_MODE

        expect(() => assertAccountProvisioningAllowed()).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN, message: '当前系统仅开放管理员账号登录。' })
        )
    })

    it('allows the legacy provisioning path only when explicitly disabled', () => {
        process.env.ADMIN_ONLY_MODE = 'false'
        expect(() => assertAccountProvisioningAllowed()).not.toThrow()
    })

    it('requires owner membership in both the workspace and organization scopes', () => {
        const activeOwner = {
            userStatus: 'active',
            workspaceStatus: 'active',
            organizationStatus: 'active',
            workspaceRoleId: 'owner-role',
            organizationRoleId: 'owner-role',
            ownerRoleId: 'owner-role'
        }

        expect(() => assertAdminPasswordLoginAllowed(activeOwner)).not.toThrow()
        expect(() => assertAdminPasswordLoginAllowed({ ...activeOwner, organizationRoleId: 'member-role' })).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.UNAUTHORIZED, message: 'Invalid administrator credentials' })
        )
        expect(() => assertAdminPasswordLoginAllowed({ ...activeOwner, organizationRoleId: undefined })).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.UNAUTHORIZED, message: 'Invalid administrator credentials' })
        )
    })

    it('wires the fail-closed policy before registration, invitation, acceptance, and SSO entry points', () => {
        const controller = readFileSync(resolve(__dirname, '../controllers/account.controller.ts'), 'utf8')
        const passport = readFileSync(resolve(__dirname, '../middleware/passport/index.ts'), 'utf8')
        const identityManager = readFileSync(resolve(__dirname, '../../IdentityManager.ts'), 'utf8')

        const registerMethod = controller.match(/public async register[\s\S]*?public async invite/)?.[0] ?? ''
        const inviteMethod = controller.match(/public async invite[\s\S]*?public async verify/)?.[0] ?? ''
        const verifyMethod = controller.match(/public async verify[\s\S]*?public async resendVerificationEmail/)?.[0] ?? ''
        const resendMethod = controller.match(/public async resendVerificationEmail[\s\S]*?public async confirmEmailChange/)?.[0] ?? ''
        expect(registerMethod.indexOf('assertAccountProvisioningAllowed()')).toBeLessThan(registerMethod.indexOf('new AccountService()'))
        expect(inviteMethod.indexOf('assertAccountProvisioningAllowed()')).toBeLessThan(inviteMethod.indexOf('new AccountService()'))
        expect(verifyMethod.indexOf('assertAccountProvisioningAllowed()')).toBeLessThan(verifyMethod.indexOf('new AccountService()'))
        expect(resendMethod.indexOf('assertAccountProvisioningAllowed()')).toBeLessThan(resendMethod.indexOf('new AccountService()'))
        expect(passport).toContain('if (!isAdminOnlyModeEnabled())')
        expect(identityManager).toContain('if (isAdminOnlyModeEnabled())')
        expect(identityManager).toContain('if (isAdminOnlyModeEnabled()) providerConfig = undefined')
    })
})
