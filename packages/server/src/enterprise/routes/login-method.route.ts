import express from 'express'
import { LoginMethodController } from '../controllers/login-method.controller'
import { requireInteractiveSession, requireOrganizationAdminSession } from '../middleware/passport/interactiveSession'
import { checkPermission } from '../rbac/PermissionCheck'

const router = express.Router()
const loginMethodController = new LoginMethodController()

router.get('/', checkPermission('sso:manage'), loginMethodController.read)

router.get('/default', loginMethodController.defaultMethods)

router.post('/', requireInteractiveSession, checkPermission('sso:manage'), loginMethodController.create)

router.put('/', requireInteractiveSession, checkPermission('sso:manage'), loginMethodController.update)

router.post('/test', requireOrganizationAdminSession, checkPermission('sso:manage'), loginMethodController.testConfig)

export default router
