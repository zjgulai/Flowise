import express from 'express'
import { WorkspaceUserController } from '../controllers/workspace-user.controller'
import { IdentityManager } from '../../IdentityManager'
import { checkPermission } from '../rbac/PermissionCheck'
import { bindWorkspaceMembershipMutation } from '../middleware/membershipMutationGuards'
import { requireInteractiveSession } from '../middleware/passport/interactiveSession'

const router = express.Router()
const workspaceUserController = new WorkspaceUserController()

// no feature flag because user with lower plan can read invited workspaces with higher plan
router.get('/', workspaceUserController.read)

router.post(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:add-user'),
    bindWorkspaceMembershipMutation,
    workspaceUserController.create
)

router.put(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:add-user'),
    bindWorkspaceMembershipMutation,
    workspaceUserController.update
)

router.delete(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:unlink-user'),
    bindWorkspaceMembershipMutation,
    workspaceUserController.delete
)

export default router
