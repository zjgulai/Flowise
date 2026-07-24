import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockRoleCreate = jest.fn((_req: Request, res: Response) => res.status(201).json({ handler: 'role-create' }))
const mockRoleUpdate = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'role-update' }))
const mockRoleDelete = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'role-delete' }))

const mockLoginMethodCreate = jest.fn((_req: Request, res: Response) => res.status(201).json({ handler: 'login-method-create' }))
const mockLoginMethodUpdate = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'login-method-update' }))
const mockLoginMethodTest = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'login-method-test' }))

jest.mock('../controllers/role.controller', () => ({
    RoleController: jest.fn().mockImplementation(() => ({
        read: jest.fn(),
        create: mockRoleCreate,
        update: mockRoleUpdate,
        delete: mockRoleDelete
    }))
}))

jest.mock('../controllers/login-method.controller', () => ({
    LoginMethodController: jest.fn().mockImplementation(() => ({
        read: jest.fn(),
        defaultMethods: jest.fn(),
        create: mockLoginMethodCreate,
        update: mockLoginMethodUpdate,
        testConfig: mockLoginMethodTest
    }))
}))

import loginMethodRouter from './login-method.route'
import roleRouter from './role.route'

type TestPrincipal = {
    id?: string
    activeOrganizationId: string
    activeWorkspaceId: string
    isOrganizationAdmin: boolean
    permissions: string[]
}

const apiKeyPrincipal: TestPrincipal = {
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: false,
    permissions: ['roles:manage', 'sso:manage']
}

const interactiveManager: TestPrincipal = {
    id: 'manager-user',
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: false,
    permissions: ['roles:manage', 'sso:manage']
}

const organizationAdmin: TestPrincipal = {
    id: 'admin-user',
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: true,
    permissions: []
}

function buildApp(principal: TestPrincipal) {
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = principal as Request['user']
        Object.defineProperty(req, 'session', {
            configurable: true,
            value: principal.id ? { passport: { user: { id: principal.id } } } : {}
        })
        next()
    })
    app.use('/role', roleRouter)
    app.use('/loginmethod', loginMethodRouter)
    return app
}

describe('role and login-method mutation route boundaries', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([
        ['post', '/role'],
        ['put', '/role'],
        ['delete', '/role?id=role-id&organizationId=org-active'],
        ['post', '/loginmethod'],
        ['put', '/loginmethod'],
        ['post', '/loginmethod/test']
    ] as const)('rejects an API key principal before the controller on %s %s', async (method, path) => {
        const response = await request(buildApp(apiKeyPrincipal))[method](path).send({})

        expect(response.status).toBe(403)
        expect(mockRoleCreate).not.toHaveBeenCalled()
        expect(mockRoleUpdate).not.toHaveBeenCalled()
        expect(mockRoleDelete).not.toHaveBeenCalled()
        expect(mockLoginMethodCreate).not.toHaveBeenCalled()
        expect(mockLoginMethodUpdate).not.toHaveBeenCalled()
        expect(mockLoginMethodTest).not.toHaveBeenCalled()
    })

    it('allows interactive role managers to mutate roles', async () => {
        const app = buildApp(interactiveManager)

        await request(app).post('/role').send({ name: 'Manager', permissions: 'chatflows:view' }).expect(201)
        await request(app).put('/role').send({ id: 'role-id', name: 'Manager' }).expect(200)
        await request(app).delete('/role?id=role-id&organizationId=org-active').expect(200)

        expect(mockRoleCreate).toHaveBeenCalledTimes(1)
        expect(mockRoleUpdate).toHaveBeenCalledTimes(1)
        expect(mockRoleDelete).toHaveBeenCalledTimes(1)
    })

    it('requires an organization-admin interactive session before an SSO provider test', async () => {
        await request(buildApp(interactiveManager))
            .post('/loginmethod/test')
            .send({ organizationId: 'org-active', providerName: 'google', providers: [] })
            .expect(403)

        expect(mockLoginMethodTest).not.toHaveBeenCalled()

        await request(buildApp(organizationAdmin))
            .post('/loginmethod/test')
            .send({ organizationId: 'org-active', providerName: 'google', providers: [] })
            .expect(200)

        expect(mockLoginMethodTest).toHaveBeenCalledTimes(1)
    })

    it('keeps SSO configuration changes interactive even when the permission is granted', async () => {
        const app = buildApp(interactiveManager)

        await request(app).post('/loginmethod').send({ name: 'google' }).expect(201)
        await request(app).put('/loginmethod').send({ providers: [] }).expect(200)

        expect(mockLoginMethodCreate).toHaveBeenCalledTimes(1)
        expect(mockLoginMethodUpdate).toHaveBeenCalledTimes(1)
    })
})
