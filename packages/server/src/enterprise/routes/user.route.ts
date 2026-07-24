import express from 'express'
import { UserController } from '../controllers/user.controller'
import { requireInteractiveSession } from '../middleware/passport/interactiveSession'
import { checkPermission } from '../rbac/PermissionCheck'

const router = express.Router()
const userController = new UserController()

router.get('/', requireInteractiveSession, userController.read)
router.get('/test', requireInteractiveSession, userController.test)

router.post('/', requireInteractiveSession, checkPermission('users:manage'), userController.create)

router.put('/', requireInteractiveSession, userController.update)

export default router
