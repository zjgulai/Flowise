import express from 'express'
import { OrganizationUserController } from '../controllers/organization-user.controller'
import { checkPermission } from '../rbac/PermissionCheck'
import { IdentityManager } from '../../IdentityManager'
import { requireInteractiveSession } from '../middleware/passport/interactiveSession'
import { bindOrganizationMembershipMutation } from '../middleware/membershipMutationGuards'

const router = express.Router()
const organizationUserController = new OrganizationUserController()

router.get('/', organizationUserController.read)

router.post(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:users'),
    checkPermission('users:manage'),
    bindOrganizationMembershipMutation,
    organizationUserController.create
)

router.put(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:users'),
    checkPermission('users:manage'),
    bindOrganizationMembershipMutation,
    organizationUserController.update
)

router.delete(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:users'),
    checkPermission('users:manage'),
    bindOrganizationMembershipMutation,
    organizationUserController.delete
)

export default router
