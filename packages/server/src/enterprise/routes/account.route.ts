import express from 'express'
import { IdentityManager } from '../../IdentityManager'
import { AccountController } from '../controllers/account.controller'
import { checkAnyPermission } from '../rbac/PermissionCheck'
import { adminPasswordRecoveryRateLimiter, adminVerificationRateLimiter } from '../middleware/passport/authRateLimit'
import { requireInteractiveSession, requireOrganizationAdminSession } from '../middleware/passport/interactiveSession'

const router = express.Router()
const accountController = new AccountController()

router.post('/register', accountController.register)

// feature flag to workspace since only user who has workspaces can invite
router.post(
    '/invite',
    requireInteractiveSession,
    IdentityManager.checkFeatureByPlan('feat:workspaces'),
    checkAnyPermission('workspace:add-user,users:manage'),
    accountController.invite
)

router.post('/logout', accountController.logout)

router.post('/verify', adminVerificationRateLimiter, accountController.verify)

router.post('/confirm-email-change', accountController.confirmEmailChange)

router.post('/resend-verification', adminVerificationRateLimiter, accountController.resendVerificationEmail)

router.post('/forgot-password', adminPasswordRecoveryRateLimiter, accountController.forgotPassword)

router.post('/reset-password', accountController.resetPassword)

router.post('/billing', requireOrganizationAdminSession, accountController.createStripeCustomerPortalSession)

router.delete('/delete', accountController.delete)

export default router
