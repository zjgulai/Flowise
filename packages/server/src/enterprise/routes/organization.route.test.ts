import { NextFunction, Request, Response } from 'express'

jest.mock('../controllers/organization.controller', () => ({
    OrganizationController: jest.fn().mockImplementation(() => ({
        read: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        getAdditionalSeatsQuantity: jest.fn(),
        getCustomerWithDefaultSource: jest.fn(),
        getAdditionalSeatsProration: jest.fn(),
        updateAdditionalSeats: jest.fn(),
        getPlanProration: jest.fn(),
        updateSubscriptionPlan: jest.fn(),
        getCurrentUsage: jest.fn()
    }))
}))

import { bindOrganizationCreateToCurrentUser, bindOrganizationUpdateToActiveTenant } from './organization.route'

const makeResponse = () =>
    ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
    } as unknown as Response)

describe('organization HTTP mutation DTO boundaries', () => {
    it('allows only name on create and binds the creator to the session', () => {
        const req = {
            user: { id: 'admin-a', activeOrganizationId: 'org-a' },
            body: {
                id: 'attacker-selected-id',
                name: 'Public name',
                customerId: 'cus-attacker',
                subscriptionId: 'sub-attacker',
                createdBy: 'attacker',
                updatedBy: 'attacker'
            }
        } as unknown as Request
        const res = makeResponse()
        const next = jest.fn() as NextFunction

        bindOrganizationCreateToCurrentUser(req, res, next)

        expect(req.body).toEqual({ name: 'Public name', createdBy: 'admin-a' })
        expect(next).toHaveBeenCalledTimes(1)
        expect(res.status).not.toHaveBeenCalled()
    })

    it('allows only active organization id and name on update', () => {
        const req = {
            user: { id: 'admin-a', activeOrganizationId: 'org-a' },
            body: {
                id: 'org-a',
                name: 'Renamed',
                customerId: 'cus-attacker',
                subscriptionId: 'sub-attacker',
                createdBy: 'attacker',
                updatedBy: 'attacker'
            }
        } as unknown as Request
        const res = makeResponse()
        const next = jest.fn() as NextFunction

        bindOrganizationUpdateToActiveTenant(req, res, next)

        expect(req.body).toEqual({ id: 'org-a', name: 'Renamed', updatedBy: 'admin-a' })
        expect(next).toHaveBeenCalledTimes(1)
        expect(res.status).not.toHaveBeenCalled()
    })

    it('rejects update of a non-active organization before the controller', () => {
        const req = {
            user: { id: 'admin-a', activeOrganizationId: 'org-a' },
            body: { id: 'org-b', name: 'Renamed' }
        } as unknown as Request
        const res = makeResponse()
        const next = jest.fn() as NextFunction

        bindOrganizationUpdateToActiveTenant(req, res, next)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })
})
