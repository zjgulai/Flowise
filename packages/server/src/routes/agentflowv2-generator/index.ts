import express from 'express'
import agentflowv2GeneratorController from '../../controllers/agentflowv2-generator'
import { checkAnyPermission, checkPermission } from '../../enterprise/rbac/PermissionCheck'
const router = express.Router()

router.post(
    '/generate',
    checkAnyPermission('agentflows:create,agentflows:update'),
    checkPermission('credentials:view'),
    agentflowv2GeneratorController.generateAgentflowv2
)

export default router
