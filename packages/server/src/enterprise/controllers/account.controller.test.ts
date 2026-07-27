import { NextFunction, Request, Response } from 'express'

const mockAccountLogout = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../services/account.service', () => ({
    AccountService: jest.fn().mockImplementation(() => ({
        logout: mockAccountLogout
    }))
}))

import { AccountController } from './account.controller'
import { resolveSecureCookie } from '../middleware/passport/authSecurityPolicy'

type LogoutCallback = (error?: unknown) => void

interface MockRequestControls {
    request: Request
    getLogoutCallback: () => LogoutCallback | undefined
    getDestroyCallback: () => LogoutCallback | undefined
    events: string[]
}

function createRequest({ hasUser = true, authenticated = true }: { hasUser?: boolean; authenticated?: boolean } = {}): MockRequestControls {
    const events: string[] = []
    let logoutCallback: LogoutCallback | undefined
    let destroyCallback: LogoutCallback | undefined

    const request = {
        user: hasUser ? { id: 'synthetic-user' } : undefined,
        isAuthenticated: jest.fn().mockReturnValue(authenticated),
        logout: jest.fn((callback: LogoutCallback) => {
            events.push('logout-called')
            logoutCallback = callback
        }),
        session: {
            destroy: jest.fn((callback: LogoutCallback) => {
                events.push('destroy-called')
                destroyCallback = callback
            })
        }
    } as unknown as Request

    return {
        request,
        getLogoutCallback: () => logoutCallback,
        getDestroyCallback: () => destroyCallback,
        events
    }
}

function createResponse(events: string[] = []): Response {
    const response = {} as Response
    response.clearCookie = jest.fn().mockImplementation(() => response)
    response.status = jest.fn().mockImplementation((statusCode: number) => {
        events.push(`status-${statusCode}`)
        return response
    })
    response.json = jest.fn().mockImplementation(() => response)
    response.redirect = jest.fn().mockImplementation(() => response)
    return response
}

function expectAuthCookiesCleared(response: Response) {
    const cookieOptions = {
        path: '/',
        httpOnly: true,
        secure: resolveSecureCookie(),
        sameSite: 'lax'
    }

    expect(response.clearCookie).toHaveBeenCalledTimes(3)
    expect(response.clearCookie).toHaveBeenNthCalledWith(1, 'connect.sid', cookieOptions)
    expect(response.clearCookie).toHaveBeenNthCalledWith(2, 'token', cookieOptions)
    expect(response.clearCookie).toHaveBeenNthCalledWith(3, 'refreshToken', cookieOptions)
}

describe('AccountController.logout', () => {
    const controller = new AccountController()

    beforeEach(() => {
        jest.clearAllMocks()
        mockAccountLogout.mockResolvedValue(undefined)
    })

    it('waits for Passport logout and session destruction before returning success', async () => {
        const controls = createRequest()
        const response = createResponse(controls.events)
        const next = jest.fn() as NextFunction

        const result = controller.logout(controls.request, response, next)
        await Promise.resolve()
        await Promise.resolve()

        expect(controls.getLogoutCallback()).toBeDefined()
        controls.getLogoutCallback()?.()
        await Promise.resolve()

        expect(controls.getDestroyCallback()).toBeDefined()
        controls.events.push('destroy-completed')
        controls.getDestroyCallback()?.()
        await result

        expect(controls.events.indexOf('status-200')).toBeGreaterThan(controls.events.indexOf('destroy-completed'))
        expect(response.status).toHaveBeenCalledTimes(1)
        expect(response.status).toHaveBeenCalledWith(200)
        expect(response.json).toHaveBeenCalledWith({ message: 'logged_out', redirectTo: '/login' })
        expect(next).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
    })

    it('returns only the logout failure after clearing client authentication cookies', async () => {
        const controls = createRequest()
        const response = createResponse()
        const next = jest.fn() as NextFunction

        const result = controller.logout(controls.request, response, next)
        await Promise.resolve()
        await Promise.resolve()
        controls.getLogoutCallback()?.(new Error('passport logout failed'))
        await result

        expect(response.status).toHaveBeenCalledTimes(1)
        expect(response.status).toHaveBeenCalledWith(500)
        expect(response.json).toHaveBeenCalledTimes(1)
        expect(response.json).toHaveBeenCalledWith({ message: 'Logout failed' })
        expect(controls.request.session.destroy).not.toHaveBeenCalled()
        expect(next).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
    })

    it('returns only the session destruction failure after clearing client authentication cookies', async () => {
        const controls = createRequest()
        const response = createResponse()
        const next = jest.fn() as NextFunction

        const result = controller.logout(controls.request, response, next)
        await Promise.resolve()
        await Promise.resolve()
        controls.getLogoutCallback()?.()
        await Promise.resolve()
        controls.getDestroyCallback()?.(new Error('session destroy failed'))
        await result

        expect(response.status).toHaveBeenCalledTimes(1)
        expect(response.status).toHaveBeenCalledWith(500)
        expect(response.json).toHaveBeenCalledTimes(1)
        expect(response.json).toHaveBeenCalledWith({ message: 'Failed to destroy session' })
        expect(next).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
    })

    it('preserves the JWT logout redirect while clearing all authentication cookies', async () => {
        const controls = createRequest({ authenticated: false })
        const response = createResponse()
        const next = jest.fn() as NextFunction

        await controller.logout(controls.request, response, next)

        expect(mockAccountLogout).toHaveBeenCalledWith(controls.request.user)
        expect(controls.request.logout).not.toHaveBeenCalled()
        expect(response.redirect).toHaveBeenCalledWith('/login')
        expect(response.status).not.toHaveBeenCalled()
        expect(next).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
    })

    it('is idempotent for a stale unauthenticated request and still clears all authentication cookies', async () => {
        const controls = createRequest({ hasUser: false })
        const response = createResponse()
        const next = jest.fn() as NextFunction

        await controller.logout(controls.request, response, next)

        expect(mockAccountLogout).not.toHaveBeenCalled()
        expect(controls.request.isAuthenticated).not.toHaveBeenCalled()
        expect(controls.request.logout).not.toHaveBeenCalled()
        expect(controls.request.session.destroy).not.toHaveBeenCalled()
        expect(response.status).toHaveBeenCalledWith(200)
        expect(response.json).toHaveBeenCalledWith({ message: 'logged_out', redirectTo: '/login' })
        expect(next).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
    })

    it('clears authentication cookies before forwarding an account-service failure', async () => {
        const serviceError = new Error('audit logout failed')
        mockAccountLogout.mockRejectedValue(serviceError)
        const controls = createRequest()
        const response = createResponse()
        const next = jest.fn() as NextFunction

        await controller.logout(controls.request, response, next)

        expect(next).toHaveBeenCalledWith(serviceError)
        expect(response.status).not.toHaveBeenCalled()
        expect(response.json).not.toHaveBeenCalled()
        expect(controls.request.logout).not.toHaveBeenCalled()
        expectAuthCookiesCleared(response)
        expect((response.clearCookie as jest.Mock).mock.invocationCallOrder[2]).toBeLessThan(mockAccountLogout.mock.invocationCallOrder[0])
    })
})
