import express from 'express'
import textToSpeechController from '../../controllers/text-to-speech'
import { checkAnyPermission, checkPermission } from '../../enterprise/rbac/PermissionCheck'

const router = express.Router()

router.post('/generate', textToSpeechController.getRateLimiterMiddleware, textToSpeechController.generateTextToSpeech)

router.post('/abort', textToSpeechController.abortTextToSpeech)

router.get(
    '/voices',
    checkAnyPermission('chatflows:create,chatflows:update,agentflows:create,agentflows:update'),
    checkPermission('credentials:view'),
    textToSpeechController.getVoices
)

export default router
