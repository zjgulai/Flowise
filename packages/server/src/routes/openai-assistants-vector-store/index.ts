import express, { NextFunction, Request, Response } from 'express'
import openaiAssistantsVectorStoreController from '../../controllers/openai-assistants-vector-store'
import { checkPermission } from '../../enterprise/rbac/PermissionCheck'
import {
    assertOpenAIAssistantResourceCreationAllowed,
    assertOpenAIAssistantResourceDestructionAllowed
} from '../../services/assistants/legacyPolicy'
import { createAssistantUploadWithinLimits } from '../openai-assistants-files/uploadLimits'

const router = express.Router()
const rejectLegacyResourceCreation = (_req: Request, _res: Response, next: NextFunction) => {
    try {
        assertOpenAIAssistantResourceCreationAllowed()
    } catch (error) {
        next(error)
    }
}
const rejectLegacyResourceDestruction = (_req: Request, _res: Response, next: NextFunction) => {
    try {
        assertOpenAIAssistantResourceDestructionAllowed()
    } catch (error) {
        next(error)
    }
}

// CREATE
router.post(
    '/',
    checkPermission('assistants:create'),
    rejectLegacyResourceCreation,
    openaiAssistantsVectorStoreController.createAssistantVectorStore
)

// READ
router.get(
    '/:id',
    checkPermission('assistants:view'),
    checkPermission('credentials:view'),
    openaiAssistantsVectorStoreController.getAssistantVectorStore
)

// LIST
router.get(
    '/',
    checkPermission('assistants:view'),
    checkPermission('credentials:view'),
    openaiAssistantsVectorStoreController.listAssistantVectorStore
)

// UPDATE
router.put(
    ['/', '/:id'],
    checkPermission('assistants:update'),
    checkPermission('credentials:view'),
    openaiAssistantsVectorStoreController.updateAssistantVectorStore
)

// DELETE
router.delete(
    ['/', '/:id'],
    checkPermission('assistants:delete'),
    rejectLegacyResourceDestruction,
    openaiAssistantsVectorStoreController.deleteAssistantVectorStore
)

// UPLOAD FILES — permission check must precede multer to reject unauthorized requests before file parsing
router.post(
    '/:id',
    checkPermission('assistants:update'),
    rejectLegacyResourceCreation,
    createAssistantUploadWithinLimits(),
    openaiAssistantsVectorStoreController.uploadFilesToAssistantVectorStore
)

// DELETE FILES
router.patch(
    ['/', '/:id'],
    checkPermission('assistants:update'),
    rejectLegacyResourceDestruction,
    openaiAssistantsVectorStoreController.deleteFilesFromAssistantVectorStore
)

export default router
