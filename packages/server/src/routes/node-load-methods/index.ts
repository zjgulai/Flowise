import express from 'express'
import nodesRouter from '../../controllers/nodes'
import { checkAnyPermission, checkPermission } from '../../enterprise/rbac/PermissionCheck'

const router = express.Router()
const checkAssistantsView = checkPermission('assistants:view')
const checkFlowEdit = checkAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update')
export const NODE_LOAD_COARSE_PERMISSIONS = [
    'chatflows:view',
    'chatflows:create',
    'chatflows:update',
    'chatflows:delete',
    'agentflows:view',
    'agentflows:create',
    'agentflows:update',
    'agentflows:delete',
    'documentStores:view',
    'documentStores:create',
    'documentStores:update',
    'documentStores:add-loader',
    'documentStores:upsert-config',
    'tools:view',
    'tools:create',
    'tools:update',
    'credentials:view'
] as const

const requireAssistantViewForLegacyOpenAINode: express.RequestHandler = (req, res, next) => {
    if (req.params.name !== 'openAIAssistant') return next()
    return checkAssistantsView(req, res, next)
}

const requireFlowEditForLegacyOpenAINode: express.RequestHandler = (req, res, next) => {
    if (req.params.name !== 'openAIAssistant') return next()
    return checkFlowEdit(req, res, next)
}

router.post(
    ['/', '/:name'],
    checkAnyPermission(NODE_LOAD_COARSE_PERMISSIONS.join(',')),
    requireFlowEditForLegacyOpenAINode,
    requireAssistantViewForLegacyOpenAINode,
    nodesRouter.getSingleNodeAsyncOptions
)

export default router
