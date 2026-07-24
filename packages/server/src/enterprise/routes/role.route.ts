import express from 'express'
import { RoleController } from '../controllers/role.controller'
import { requireInteractiveSession } from '../middleware/passport/interactiveSession'
import { checkPermission } from '../rbac/PermissionCheck'

const router = express.Router()
const roleController = new RoleController()

router.get('/', roleController.read)

router.post('/', requireInteractiveSession, checkPermission('roles:manage'), roleController.create)

router.put('/', requireInteractiveSession, checkPermission('roles:manage'), roleController.update)

router.delete('/', requireInteractiveSession, checkPermission('roles:manage'), roleController.delete)

export default router
