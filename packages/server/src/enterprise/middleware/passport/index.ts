import { HttpStatusCode } from 'axios'
import { RedisStore } from 'connect-redis'
import express, { NextFunction, Request, Response } from 'express'
import session from 'express-session'
import jwt from 'jsonwebtoken'
import passport from 'passport'
import { VerifiedCallback } from 'passport-jwt'
import { IdentityManager } from '../../../IdentityManager'
import { Platform } from '../../../Interface'
import { getRunningExpressApp } from '../../../utils/getRunningExpressApp'
import { WorkspaceUser } from '../../database/entities/workspace-user.entity'
import { ErrorMessage, LoggedInUser } from '../../Interface.Enterprise'
import { AcceptanceLoginService } from '../../services/acceptanceLogin.service'
import { AccountService } from '../../services/account.service'
import { buildLoggedInUser } from '../../services/loggedInUserBuilder'
import { OrganizationService } from '../../services/organization.service'
import {
    getExpressSessionSecret,
    getJWTAudience,
    getJWTAuthTokenSecret,
    getJWTIssuer,
    getJWTRefreshTokenSecret
} from '../../utils/authSecrets'
import { decryptToken } from '../../utils/tempTokenUtils'
import { getAuthStrategy, isTokenBoundToSession, reloadSessionAuthorization } from './AuthStrategy'
import { registerAcceptanceLoginRoute } from './acceptanceLogin'
import { adminLoginRateLimiter } from './authRateLimit'
import { enforceAuthResolvePostOnly, resolveSecureCookie } from './authSecurityPolicy'
import { isAdminOnlyModeEnabled } from '../../utils/adminOnlyPolicy'
import { initializeDBClientAndStore, initializeMemoryStore, initializeRedisClientAndStore } from './SessionPersistance'
import { setTokenOrCookies } from './tokenResponse'

export { generateJwtAuthToken, generateJwtRefreshToken, setTokenOrCookies } from './tokenResponse'

const localStrategy = require('passport-local').Strategy

const expireAuthTokensOnRestart = process.env.EXPIRE_AUTH_TOKENS_ON_RESTART === 'true'

const _initializePassportMiddleware = async (app: express.Application, secureCookie: boolean) => {
    // Configure session middleware
    let options: any = {
        secret: getExpressSessionSecret(),
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: secureCookie,
            httpOnly: true,
            sameSite: 'lax' // Add sameSite attribute
        }
    }

    // if the auth tokens are not to be expired on restart, then configure the session store
    if (!expireAuthTokensOnRestart) {
        // configure session store based on the mode
        if (process.env.MODE === 'queue') {
            const redisStore = initializeRedisClientAndStore()
            options.store = redisStore as RedisStore
        } else {
            // for the database store, choose store basis the DB configuration from .env
            const dbSessionStore = initializeDBClientAndStore()
            if (dbSessionStore) {
                options.store = dbSessionStore
            } else {
                options.store = initializeMemoryStore()
            }
        }
    } else {
        options.store = initializeMemoryStore()
    }

    app.use(session(options))
    app.use(passport.initialize())
    app.use(passport.session())

    if (options.store) {
        const appServer = getRunningExpressApp()
        appServer.sessionStore = options.store
    }

    passport.serializeUser((user: any, done) => {
        done(null, user)
    })

    passport.deserializeUser((user: any, done) => {
        done(null, user)
    })
}

export const initializeJwtCookieMiddleware = async (app: express.Application, identityManager: IdentityManager) => {
    const secureCookie = resolveSecureCookie()
    await _initializePassportMiddleware(app, secureCookie)

    const jwtOptions = {
        secretOrKey: getJWTAuthTokenSecret(),
        audience: getJWTAudience(),
        issuer: getJWTIssuer()
    }
    const strategy = getAuthStrategy(jwtOptions)
    passport.use(strategy)
    passport.use(
        'login',
        new localStrategy(
            {
                usernameField: 'email',
                passwordField: 'password',
                session: true
            },
            async (email: string, password: string, done: VerifiedCallback) => {
                let queryRunner
                try {
                    queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
                    await queryRunner.connect()
                    const accountService = new AccountService()
                    const body: any = {
                        user: {
                            email: email,
                            credential: password
                        }
                    }
                    const response = await accountService.login(body)
                    const workspaceUser: WorkspaceUser =
                        Array.isArray(response.workspaceDetails) && response.workspaceDetails.length > 0
                            ? response.workspaceDetails[0]
                            : (response.workspaceDetails as WorkspaceUser)
                    const loggedInUser = await buildLoggedInUser({
                        user: {
                            id: response.user.id!,
                            email: response.user.email!,
                            name: response.user.name ?? response.user.email!,
                            status: response.user.status ?? ''
                        },
                        workspaceUser,
                        queryRunner,
                        identityManager,
                        mode: 'password-login'
                    })
                    const authVersion = (response.user as typeof response.user & { authVersion?: string }).authVersion
                    if (!authVersion) throw new Error('Unable to establish credential version')
                    return done(null, { ...loggedInUser, authVersion }, { message: 'Logged in Successfully' })
                } catch (error) {
                    return done(error)
                } finally {
                    if (queryRunner) await queryRunner.release()
                }
            }
        )
    )

    if (!isAdminOnlyModeEnabled()) {
        const acceptanceLoginService = new AcceptanceLoginService({
            dataSource: getRunningExpressApp().AppDataSource,
            identityManager
        })
        registerAcceptanceLoginRoute(app, {
            appUrl: process.env.APP_URL,
            consume: (code) => acceptanceLoginService.consume(code),
            sendAuthenticatedResponse: setTokenOrCookies
        })
    }

    app.all('/api/v1/auth/resolve', enforceAuthResolvePostOnly)

    app.post('/api/v1/auth/resolve', async (req, res) => {
        // check for the organization, if empty redirect to the organization setup page for OpenSource and Enterprise Versions
        // for Cloud (Horizontal) version, redirect to the signin page
        const expressApp = getRunningExpressApp()
        const platform = expressApp.identityManager.getPlatformType()
        if (platform === Platform.CLOUD) {
            return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/signin' })
        }
        const orgService = new OrganizationService()
        const queryRunner = expressApp.AppDataSource.createQueryRunner()
        await queryRunner.connect()
        const registeredOrganizationCount = await orgService.countOrganizations(queryRunner)
        await queryRunner.release()
        if (registeredOrganizationCount === 0) {
            switch (platform) {
                case Platform.ENTERPRISE:
                    if (!identityManager.isLicenseValid()) {
                        return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/license-expired' })
                    }
                    return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/organization-setup' })
                default:
                    return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/organization-setup' })
            }
        }
        switch (platform) {
            case Platform.ENTERPRISE:
                if (!identityManager.isLicenseValid()) {
                    return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/license-expired' })
                }
                return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/signin' })
            default:
                return res.status(HttpStatusCode.Ok).json({ redirectUrl: '/signin' })
        }
    })

    app.post('/api/v1/auth/refreshToken', async (req, res) => {
        const refreshToken = req.cookies.refreshToken
        if (!refreshToken) return res.sendStatus(401)

        jwt.verify(
            refreshToken,
            getJWTRefreshTokenSecret(),
            { algorithms: ['HS256'], audience: getJWTAudience(), issuer: getJWTIssuer() },
            async (err: any, payload: any) => {
                try {
                    if (err || !payload) return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                    // @ts-ignore
                    const serializedUser = req.user as LoggedInUser
                    if (!serializedUser) return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                    const meta = decryptToken(payload.meta)
                    if (!meta || !isTokenBoundToSession(payload, meta, serializedUser)) {
                        return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                    }
                    const loggedInUser = await reloadSessionAuthorization(serializedUser)
                    if (!loggedInUser) return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                    let isSSO = false
                    let newTokenResponse: any = {}
                    if (loggedInUser.ssoRefreshToken) {
                        newTokenResponse = await identityManager.getRefreshToken(loggedInUser.ssoProvider, loggedInUser.ssoRefreshToken)
                        if (newTokenResponse.error) {
                            return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                        }
                        isSSO = true
                    }
                    if (isSSO) {
                        loggedInUser.ssoToken = newTokenResponse.access_token
                        if (newTokenResponse.refresh_token) {
                            loggedInUser.ssoRefreshToken = newTokenResponse.refresh_token
                        }
                        return setTokenOrCookies(res, loggedInUser, false, req, false, true)
                    } else {
                        return setTokenOrCookies(res, loggedInUser, false, req)
                    }
                } catch {
                    if (!res.headersSent) return res.status(401).json({ message: ErrorMessage.REFRESH_TOKEN_EXPIRED })
                }
            }
        )
    })

    app.post('/api/v1/auth/login', adminLoginRateLimiter, (req: Request, res: Response, next: NextFunction) => {
        passport.authenticate('login', async (err: any, user: LoggedInUser) => {
            try {
                if (err || !user) {
                    return next ? next(err) : res.status(401).json(err)
                }
                if (identityManager.isEnterprise() && !identityManager.isLicenseValid()) {
                    return res.status(401).json({ redirectUrl: '/license-expired' })
                }

                req.session.regenerate((regenerateErr?: unknown) => {
                    if (regenerateErr) {
                        return next ? next(regenerateErr) : res.status(500).json({ message: 'Session regeneration failed' })
                    }

                    req.login(user, { session: true }, async (error?: unknown) => {
                        if (error) {
                            return next ? next(error) : res.status(401).json(error)
                        }
                        return setTokenOrCookies(res, user, true, req)
                    })
                })
            } catch (error: any) {
                return next ? next(error) : res.status(401).json(error)
            }
        })(req, res, next)
    })
}

export const verifyToken = (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: true }, (err: any, user: LoggedInUser, info: object) => {
        if (err) {
            return next(err)
        }

        // @ts-ignore
        if (info && info.name === 'TokenExpiredError') {
            if (req.cookies && req.cookies.refreshToken) {
                return res.status(401).json({ message: ErrorMessage.TOKEN_EXPIRED, retry: true })
            }
            return res.status(401).json({ message: ErrorMessage.INVALID_MISSING_TOKEN })
        }

        if (!user) {
            return res.status(401).json({ message: ErrorMessage.INVALID_MISSING_TOKEN })
        }

        const identityManager = getRunningExpressApp().identityManager
        if (identityManager.isEnterprise() && !identityManager.isLicenseValid()) {
            return res.status(401).json({ redirectUrl: '/license-expired' })
        }

        req.user = user
        const passportSession = (req.session as any)?.passport
        if (passportSession) passportSession.user = user
        next()
    })(req, res, next)
}

export const verifyTokenForBullMQDashboard = (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('jwt', { session: true }, (err: any, user: LoggedInUser, info: object) => {
        if (err) {
            return next(err)
        }

        // @ts-ignore
        if (info && info.name === 'TokenExpiredError') {
            if (req.cookies && req.cookies.refreshToken) {
                return res.redirect('/signin?retry=true')
            }
            return res.redirect('/signin')
        }

        if (!user) {
            return res.redirect('/signin')
        }

        const identityManager = getRunningExpressApp().identityManager
        if (identityManager.isEnterprise() && !identityManager.isLicenseValid()) {
            return res.redirect('/license-expired')
        }

        req.user = user
        next()
    })(req, res, next)
}
