import express from 'express'
import chatflowsController from '../../controllers/chatflows'
import { checkAnyPermission } from '../../enterprise/rbac/PermissionCheck'
const router = express.Router()

// CREATE
router.post('/', checkAnyPermission('chatflows:create,agentflows:create'), chatflowsController.saveChatflow)

// READ
router.get('/', checkAnyPermission('chatflows:view,agentflows:view'), chatflowsController.getAllChatflows)
router.get(['/', '/:id'], checkAnyPermission('chatflows:view,agentflows:view'), chatflowsController.getChatflowById)
router.get(['/apikey/', '/apikey/:apikey'], chatflowsController.getChatflowByApiKey)

// UPDATE
router.put(['/', '/:id'], checkAnyPermission('chatflows:update,agentflows:update'), chatflowsController.updateChatflow)

// DELETE
router.delete(['/', '/:id'], checkAnyPermission('chatflows:delete,agentflows:delete,assistants:delete'), chatflowsController.deleteChatflow)

// WEBHOOK SECRET
router.post('/:id/webhook-secret', checkAnyPermission('chatflows:update,agentflows:update'), chatflowsController.setWebhookSecret)
router.delete('/:id/webhook-secret', checkAnyPermission('chatflows:update,agentflows:update'), chatflowsController.clearWebhookSecret)

// CHECK FOR CHANGE
router.get(
    '/has-changed/:id/:lastUpdatedDateTime',
    checkAnyPermission('chatflows:update,agentflows:update'),
    chatflowsController.checkIfChatflowHasChanged
)

// SCHEDULE
router.get('/:id/schedule/status', checkAnyPermission('chatflows:view,agentflows:view'), chatflowsController.getScheduleStatus)
router.patch('/:id/schedule/enabled', checkAnyPermission('chatflows:update,agentflows:update'), chatflowsController.toggleScheduleEnabled)
router.get('/:id/schedule/trigger-logs', checkAnyPermission('chatflows:view,agentflows:view'), chatflowsController.getScheduleTriggerLogs)
router.delete(
    '/:id/schedule/trigger-logs',
    checkAnyPermission('chatflows:update,agentflows:update,executions:delete'),
    chatflowsController.deleteScheduleTriggerLogs
)

export default router
