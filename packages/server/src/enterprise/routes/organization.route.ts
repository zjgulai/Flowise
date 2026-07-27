import express, { NextFunction, Request, Response } from 'express'
import { OrganizationController } from '../controllers/organization.controller'
import { ErrorMessage } from '../Interface.Enterprise'
import { requireInteractiveSession, requireOrganizationAdminSession } from '../middleware/passport/interactiveSession'

const router = express.Router()
const organizationController = new OrganizationController()

const forbid = (res: Response) => res.status(403).json({ message: ErrorMessage.FORBIDDEN })

const requireActiveOrganizationQuery = (req: Request, res: Response, next: NextFunction) => {
    const organizationId = typeof req.query.id === 'string' ? req.query.id : undefined
    if (!organizationId || organizationId !== req.user?.activeOrganizationId) return forbid(res)
    return next()
}

export const bindOrganizationCreateToCurrentUser = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id) return forbid(res)
    req.body = { name: req.body?.name, createdBy: req.user.id }
    return next()
}

export const bindOrganizationUpdateToActiveTenant = (req: Request, res: Response, next: NextFunction) => {
    if (!req.user?.id || !req.body?.id || req.body.id !== req.user.activeOrganizationId) return forbid(res)
    req.body = { id: req.user.activeOrganizationId, name: req.body?.name, updatedBy: req.user.id }
    return next()
}

router.get('/', requireInteractiveSession, requireActiveOrganizationQuery, organizationController.read)

router.post('/', requireOrganizationAdminSession, bindOrganizationCreateToCurrentUser, organizationController.create)

router.put('/', requireOrganizationAdminSession, bindOrganizationUpdateToActiveTenant, organizationController.update)

router.get('/additional-seats-quantity', requireOrganizationAdminSession, organizationController.getAdditionalSeatsQuantity)

router.get('/customer-default-source', requireOrganizationAdminSession, organizationController.getCustomerWithDefaultSource)

router.get('/additional-seats-proration', requireOrganizationAdminSession, organizationController.getAdditionalSeatsProration)

router.post('/update-additional-seats', requireOrganizationAdminSession, organizationController.updateAdditionalSeats)

router.get('/plan-proration', requireOrganizationAdminSession, organizationController.getPlanProration)

router.post('/update-subscription-plan', requireOrganizationAdminSession, organizationController.updateSubscriptionPlan)

router.get('/get-current-usage', requireOrganizationAdminSession, organizationController.getCurrentUsage)

export default router
