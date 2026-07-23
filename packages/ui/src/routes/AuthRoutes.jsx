import { lazy } from 'react'
import { Navigate } from 'react-router-dom'

import Loadable from '@/ui-component/loading/Loadable'
import AuthLayout from '@/layout/AuthLayout'
import { PublicLoginRoute } from '@/routes/PublicLoginRoute'

const ResolveLoginPage = Loadable(lazy(() => import('@/views/auth/login')))
const SignInPage = Loadable(lazy(() => import('@/views/auth/signIn')))
const VerifyEmailPage = Loadable(lazy(() => import('@/views/auth/verify-email')))
const ConfirmEmailChangePage = Loadable(lazy(() => import('@/views/auth/confirm-email-change')))
const ForgotPasswordPage = Loadable(lazy(() => import('@/views/auth/forgotPassword')))
const ResetPasswordPage = Loadable(lazy(() => import('@/views/auth/resetPassword')))
const UnauthorizedPage = Loadable(lazy(() => import('@/views/auth/unauthorized')))
const RateLimitedPage = Loadable(lazy(() => import('@/views/auth/rateLimited')))
const OrganizationSetupPage = Loadable(lazy(() => import('@/views/organization/index')))
const LicenseExpiredPage = Loadable(lazy(() => import('@/views/auth/expired')))
const AccessRestrictedPage = Loadable(lazy(() => import('@/views/auth/accessRestricted')))

const AuthRoutes = {
    path: '/',
    element: <AuthLayout />,
    children: [
        {
            path: '/login',
            element: (
                <PublicLoginRoute>
                    <ResolveLoginPage />
                </PublicLoginRoute>
            )
        },
        {
            path: '/signin',
            element: (
                <PublicLoginRoute>
                    <SignInPage />
                </PublicLoginRoute>
            )
        },
        {
            path: '/acceptance-login',
            element: <Navigate to='/signin' replace />
        },
        {
            path: '/access-restricted',
            element: <AccessRestrictedPage />
        },
        {
            path: '/register',
            element: <Navigate to='/signin' replace />
        },
        {
            path: '/verify',
            element: <VerifyEmailPage />
        },
        {
            path: '/confirm-email-change',
            element: <ConfirmEmailChangePage />
        },
        {
            path: '/forgot-password',
            element: <ForgotPasswordPage />
        },
        {
            path: '/reset-password',
            element: <ResetPasswordPage />
        },
        {
            path: '/unauthorized',
            element: <UnauthorizedPage />
        },
        {
            path: '/rate-limited',
            element: <RateLimitedPage />
        },
        {
            path: '/organization-setup',
            element: <OrganizationSetupPage />
        },
        {
            path: '/license-expired',
            element: <LicenseExpiredPage />
        }
    ]
}

export default AuthRoutes
