import express, { NextFunction, Request, Response } from 'express'
import openaiAssistantsController from '../../controllers/openai-assistants'
import { checkAnyPermission } from '../../enterprise/rbac/PermissionCheck'
import { assertOpenAIAssistantResourceCreationAllowed } from '../../services/assistants/legacyPolicy'
import { createAssistantUploadWithinLimits } from './uploadLimits'

export { ASSISTANT_FILE_COUNT_LIMIT, ASSISTANT_MULTIPART_PART_LIMIT, parseFileSizeLimit } from './uploadLimits'

const router = express.Router()

const uploadWithinLimits = createAssistantUploadWithinLimits()
const rejectLegacyResourceCreation = (_req: Request, _res: Response, next: NextFunction) => {
    try {
        assertOpenAIAssistantResourceCreationAllowed()
    } catch (error) {
        next(error)
    }
}

router.post('/download/', openaiAssistantsController.getFileFromAssistant)
router.post(
    '/upload/',
    checkAnyPermission('assistants:create,assistants:update'),
    rejectLegacyResourceCreation,
    uploadWithinLimits,
    openaiAssistantsController.uploadAssistantFiles
)

export default router
