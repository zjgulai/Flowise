import express from 'express'
import assistantsController from '../../controllers/assistants'
import { checkPermission, checkAnyPermission } from '../../enterprise/rbac/PermissionCheck'

const router = express.Router()

// CREATE
router.post('/', checkPermission('assistants:create'), assistantsController.createAssistant)
router.post('/:id/custom-delete', checkPermission('assistants:delete'), assistantsController.deleteCustomAssistant)

// READ
router.get('/', checkPermission('assistants:view'), assistantsController.getAllAssistants)
router.get('/:id/custom-flow', checkPermission('assistants:view'), assistantsController.getCustomAssistantFlow)
router.get(['/', '/:id'], checkPermission('assistants:view'), assistantsController.getAssistantById)

// UPDATE
router.put('/:id/custom-save', checkPermission('assistants:update'), assistantsController.saveCustomAssistant)
router.put(['/', '/:id'], checkPermission('assistants:update'), assistantsController.updateAssistant)

// DELETE
router.delete(['/', '/:id'], checkPermission('assistants:delete'), assistantsController.deleteAssistant)

router.get(
    '/components/chatmodels',
    checkAnyPermission('assistants:create,assistants:update,assistants:view'),
    assistantsController.getChatModels
)
router.get(
    '/components/docstores',
    checkAnyPermission('assistants:create,assistants:update,assistants:view'),
    assistantsController.getDocumentStores
)
router.get('/components/tools', checkAnyPermission('assistants:create,assistants:update,assistants:view'), assistantsController.getTools)

// Generate Assistant Instruction
router.post(
    '/generate/instruction',
    checkAnyPermission('assistants:create,assistants:update'),
    checkPermission('credentials:view'),
    assistantsController.generateAssistantInstruction
)

export default router
