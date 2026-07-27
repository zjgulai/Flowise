import express, { NextFunction, Request, Response } from 'express'
import request from 'supertest'

const mockUserRead = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'user-read' }))
const mockUserCreate = jest.fn((_req: Request, res: Response) => res.status(201).json({ handler: 'user-create' }))
const mockUserUpdate = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'user-update' }))
const mockUserTest = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'user-test' }))

const mockOrganizationRead = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'organization-read' }))
const mockOrganizationCreate = jest.fn((_req: Request, res: Response) => res.status(201).json({ handler: 'organization-create' }))
const mockOrganizationUpdate = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'organization-update' }))
const mockBillingRead = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'billing-read' }))
const mockBillingWrite = jest.fn((_req: Request, res: Response) => res.status(200).json({ handler: 'billing-write' }))

jest.mock('../controllers/user.controller', () => ({
    UserController: jest.fn().mockImplementation(() => ({
        read: mockUserRead,
        create: mockUserCreate,
        update: mockUserUpdate,
        test: mockUserTest
    }))
}))

jest.mock('../controllers/organization.controller', () => ({
    OrganizationController: jest.fn().mockImplementation(() => ({
        read: mockOrganizationRead,
        create: mockOrganizationCreate,
        update: mockOrganizationUpdate,
        getAdditionalSeatsQuantity: mockBillingRead,
        getCustomerWithDefaultSource: mockBillingRead,
        getAdditionalSeatsProration: mockBillingRead,
        updateAdditionalSeats: mockBillingWrite,
        getPlanProration: mockBillingRead,
        updateSubscriptionPlan: mockBillingWrite,
        getCurrentUsage: mockBillingRead
    }))
}))

import organizationRouter from './organization.route'
import userRouter from './user.route'

type TestPrincipal = {
    id?: string
    activeOrganizationId: string
    activeWorkspaceId: string
    isOrganizationAdmin: boolean
    permissions: string[]
}

const lowScopeApiKey: TestPrincipal = {
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: false,
    permissions: ['chatflows:view']
}

const organizationAdmin: TestPrincipal = {
    id: 'admin-user',
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: true,
    permissions: []
}

const regularInteractiveUser: TestPrincipal = {
    id: 'regular-user',
    activeOrganizationId: 'org-active',
    activeWorkspaceId: 'workspace-active',
    isOrganizationAdmin: false,
    permissions: ['chatflows:view']
}

function buildApp(principal: TestPrincipal) {
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = principal as Request['user']
        Object.defineProperty(req, 'session', {
            configurable: true,
            value: principal.id ? { passport: { user: principal } } : {}
        })
        next()
    })
    app.use('/user', userRouter)
    app.use('/organization', organizationRouter)
    return app
}

describe('sensitive identity and organization routes', () => {
    beforeEach(() => jest.clearAllMocks())

    it.each([
        ['get', '/user?id=target-user'],
        ['post', '/user'],
        ['put', '/user'],
        ['get', '/user/test'],
        ['get', '/organization?id=org-active'],
        ['post', '/organization'],
        ['put', '/organization'],
        ['get', '/organization/additional-seats-quantity?subscriptionId=sub-active'],
        ['get', '/organization/customer-default-source?customerId=cus-active'],
        ['get', '/organization/additional-seats-proration?subscriptionId=sub-active&quantity=2'],
        ['post', '/organization/update-additional-seats'],
        ['get', '/organization/plan-proration?subscriptionId=sub-active&newPlanId=plan-next'],
        ['post', '/organization/update-subscription-plan'],
        ['get', '/organization/get-current-usage']
    ] as const)('rejects a low-scope API key on %s %s', async (method, path) => {
        const response = await request(buildApp(lowScopeApiKey))[method](path).send({
            id: 'org-active',
            subscriptionId: 'sub-active',
            quantity: 2,
            prorationDate: 1,
            newPlanId: 'plan-next'
        })

        expect(response.status).toBe(403)
    })

    it('rejects cross-tenant organization reads before the controller runs', async () => {
        const response = await request(buildApp(organizationAdmin)).get('/organization?id=org-other')

        expect(response.status).toBe(403)
        expect(mockOrganizationRead).not.toHaveBeenCalled()
    })

    it('rejects name-based organization lookup because it cannot be tenant-bound', async () => {
        const response = await request(buildApp(organizationAdmin)).get('/organization?name=another-organization')

        expect(response.status).toBe(403)
        expect(mockOrganizationRead).not.toHaveBeenCalled()
    })

    it('rejects cross-tenant organization updates before the controller runs', async () => {
        const response = await request(buildApp(organizationAdmin)).put('/organization').send({ id: 'org-other', name: 'Other' })

        expect(response.status).toBe(403)
        expect(mockOrganizationUpdate).not.toHaveBeenCalled()
    })

    it('allows an organization administrator to read and update only the active organization', async () => {
        const app = buildApp(organizationAdmin)

        await request(app).get('/organization?id=org-active').expect(200)
        await request(app).put('/organization').send({ id: 'org-active', name: 'Renamed' }).expect(200)

        expect(mockOrganizationRead).toHaveBeenCalledTimes(1)
        expect(mockOrganizationUpdate).toHaveBeenCalledTimes(1)
    })

    it('keeps self-service user reads and updates available to an interactive user', async () => {
        const app = buildApp(regularInteractiveUser)

        await request(app).get('/user?id=regular-user').expect(200)
        await request(app).put('/user').send({ id: 'regular-user', name: 'Updated' }).expect(200)
        await request(app).post('/user').send({ email: 'synthetic@example.invalid' }).expect(403)

        expect(mockUserRead).toHaveBeenCalledTimes(1)
        expect(mockUserUpdate).toHaveBeenCalledTimes(1)
        expect(mockUserCreate).not.toHaveBeenCalled()
    })

    it('binds organization audit fields to the authenticated administrator', async () => {
        const app = buildApp(organizationAdmin)

        await request(app).post('/organization').send({ name: 'New Organization', createdBy: 'attacker-controlled' }).expect(201)
        await request(app).put('/organization').send({ id: 'org-active', name: 'Renamed', updatedBy: 'attacker-controlled' }).expect(200)

        expect(mockOrganizationCreate).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.objectContaining({ createdBy: 'admin-user' }) }),
            expect.anything(),
            expect.anything()
        )
        expect(mockOrganizationUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ body: expect.objectContaining({ updatedBy: 'admin-user' }) }),
            expect.anything(),
            expect.anything()
        )
    })
})
