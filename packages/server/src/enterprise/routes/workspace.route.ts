import express from 'express'
import { WorkspaceController } from '../controllers/workspace.controller'
import { IdentityManager } from '../../IdentityManager'
import { checkPermission } from '../rbac/PermissionCheck'
import { requireInteractiveSession } from '../middleware/passport/interactiveSession'

const router = express.Router()
const workspaceController = new WorkspaceController()

router.get('/', IdentityManager.checkFeatureByPlan('feat:workspaces'), checkPermission('workspace:view'), workspaceController.read)

router.post(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:create'),
    workspaceController.create
)

// no feature flag because user with lower plan can switch to invited workspaces with higher plan
router.post('/switch', requireInteractiveSession, workspaceController.switchWorkspace)

router.put(
    '/',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:update'),
    workspaceController.update
)

router.delete(
    ['/', '/:id'],
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkPermission('workspace:delete'),
    workspaceController.delete
)

router.get(
    ['/shared', '/shared/:id'],
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    workspaceController.getSharedWorkspacesForItem
)
router.post(
    ['/shared', '/shared/:id'],
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    workspaceController.setSharedWorkspacesForItem
)

export default router
