/**
 * OAuth2 Authorization Code Flow Implementation
 *
 * This module implements a complete OAuth2 authorization code flow for Flowise credentials.
 * It supports Microsoft Graph and other OAuth2 providers.
 *
 * CREDENTIAL DATA STRUCTURE:
 * The credential's encryptedData should contain a JSON object with the following fields:
 *
 * Required fields:
 * - client_id: OAuth2 application client ID
 * - client_secret: OAuth2 application client secret
 *
 * Optional fields (provider-specific):
 * - tenant_id: Microsoft Graph tenant ID (if using Microsoft Graph)
 * - authorization_endpoint: Custom authorization URL (defaults to Microsoft Graph if tenant_id provided)
 * - token_endpoint: Custom token URL (defaults to Microsoft Graph if tenant_id provided)
 * - redirect_uri: Ignored; the callback is always derived from canonical APP_URL
 * - scope: OAuth2 scopes to request (e.g., "user.read mail.read")
 * - response_type: Ignored; authorization code flow always uses "code"
 * - response_mode: Ignored; callback handling always uses "query"
 *
 * ENDPOINTS:
 *
 * 1. POST /api/v1/oauth2/authorize/:credentialId
 *    - Generates authorization URL for initiating OAuth2 flow
 *    - Creates a short-lived, opaque, one-time state bound to the initiating session and workspace
 *    - Returns authorization URL to redirect user to
 *
 * 2. GET /api/v1/oauth2/callback
 *    - Handles OAuth2 callback with authorization code
 *    - Requires the same authenticated session and consumes state before token exchange
 *    - Exchanges code for access token
 *    - Updates credential with token data
 *    - Supports Microsoft Graph and custom OAuth2 providers
 *
 * 3. POST /api/v1/oauth2/refresh/:credentialId
 *    - Refreshes expired access tokens using refresh token
 *    - Updates credential with new token data
 *
 * USAGE FLOW:
 * 1. Create a credential with OAuth2 configuration (client_id, client_secret, etc.)
 * 2. Call POST /oauth2/authorize/:credentialId to get authorization URL
 * 3. Redirect user to authorization URL
 * 4. User authorizes and gets redirected to callback endpoint
 * 5. Callback endpoint exchanges code for tokens and saves them
 * 6. Use POST /oauth2/refresh/:credentialId when tokens expire
 *
 * TOKEN STORAGE:
 * After successful authorization, the credential will contain additional fields:
 * - access_token: OAuth2 access token
 * - refresh_token: OAuth2 refresh token (if provided)
 * - token_type: Token type (usually "Bearer")
 * - expires_in: Token lifetime in seconds
 * - expires_at: Token expiry timestamp (ISO string)
 * - granted_scope: Actual scopes granted by provider
 * - token_received_at: When token was received (ISO string)
 */

import { randomBytes } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import { createFixedOriginPolicy, resolveFlowiseRequestTarget, secureAxiosRequest } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { Credential } from '../../database/entities/Credential'
import { ErrorMessage, LoggedInUser } from '../../enterprise/Interface.Enterprise'
import { reloadSessionAuthorization } from '../../enterprise/middleware/passport/AuthStrategy'
import { isInteractiveSessionRequest, requireInteractiveSession } from '../../enterprise/middleware/passport/interactiveSession'
import { checkPermission } from '../../enterprise/rbac/PermissionCheck'
import { getActiveWorkspaceIdForRequest, getLoggedInUser } from '../../enterprise/utils/tenantRequestGuards'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { decryptCredentialData, encryptCredentialData } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { MAX_OAUTH2_TOKEN_LENGTH, normalizeOAuth2TokenResponse, validateStrictOAuth2Url } from '../../utils/oauth2Security'
import { refreshOAuth2CredentialForWorkspace } from '../../services/oauth2CredentialRefresh'
import { generateErrorPage, generateSuccessPage } from './templates'

const router = express.Router()

const OAUTH2_STATE_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_OAUTH2_STATES = 10
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024
const OAUTH_CONFIGURATION_INVALID = 'OAuth2 credential configuration is invalid'
const RESERVED_AUTHORIZATION_PARAMETERS = new Set(['client_id', 'response_type', 'response_mode', 'state', 'redirect_uri', 'scope'])

const isBoundedOAuth2String = (value: unknown, required: boolean): value is string =>
    typeof value === 'string' && (!required || value.length > 0) && value.length <= MAX_OAUTH2_TOKEN_LENGTH

type PendingOAuth2State = {
    credentialId: string
    workspaceId: string
    organizationId: string
    initiatorUserId: string
    sessionId: string
    redirectUri: string
    expiresAt: number
}

type OAuth2Session = Request['session'] & {
    flowiseOAuth2States?: Record<string, PendingOAuth2State>
}

const requireCurrentOAuthCallbackSession = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.session || !req.sessionID || !isInteractiveSessionRequest(req)) {
            return res.status(StatusCodes.UNAUTHORIZED).json({ message: ErrorMessage.INVALID_MISSING_TOKEN })
        }

        const currentUser = await reloadSessionAuthorization(req.user as LoggedInUser)
        if (!currentUser) return res.status(StatusCodes.UNAUTHORIZED).json({ message: ErrorMessage.INVALID_MISSING_TOKEN })

        req.user = currentUser
        const passportSession = (req.session as OAuth2Session & { passport?: { user?: LoggedInUser } }).passport
        if (!passportSession) return res.status(StatusCodes.UNAUTHORIZED).json({ message: ErrorMessage.INVALID_MISSING_TOKEN })
        passportSession.user = currentUser
        await saveSession(req)
        return next()
    } catch (error) {
        return next(error)
    }
}

const saveSession = async (req: Request): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
        req.session.save((error) => (error ? reject(error) : resolve()))
    })
}

const storeOAuth2State = async (req: Request, state: string, pendingState: PendingOAuth2State): Promise<void> => {
    const now = Date.now()
    const session = req.session as OAuth2Session
    const activeStates = Object.entries(session.flowiseOAuth2States ?? {})
        .filter(([, value]) => value.expiresAt > now)
        .sort(([, left], [, right]) => right.expiresAt - left.expiresAt)
        .slice(0, MAX_PENDING_OAUTH2_STATES - 1)

    session.flowiseOAuth2States = Object.fromEntries(activeStates)
    session.flowiseOAuth2States[state] = pendingState
    await saveSession(req)
}

const consumeOAuth2State = async (req: Request, state: string, user: LoggedInUser): Promise<PendingOAuth2State | undefined> => {
    const session = req.session as OAuth2Session
    const pendingState = session.flowiseOAuth2States?.[state]
    if (!pendingState) return undefined

    delete session.flowiseOAuth2States?.[state]
    await saveSession(req)

    if (
        pendingState.expiresAt <= Date.now() ||
        pendingState.sessionId !== req.sessionID ||
        pendingState.initiatorUserId !== user.id ||
        pendingState.workspaceId !== user.activeWorkspaceId ||
        pendingState.organizationId !== user.activeOrganizationId
    ) {
        return undefined
    }

    return pendingState
}

const getOwnedCredential = async (credentialId: string, workspaceId: string) => {
    const appServer = getRunningExpressApp()
    const credentialRepository = appServer.AppDataSource.getRepository(Credential)
    const credential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
    return { credential, credentialRepository }
}

// Initiate OAuth2 authorization flow
const authorizeOAuth2 = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { credentialId } = req.params
        const user = getLoggedInUser(req)
        const workspaceId = getActiveWorkspaceIdForRequest(req)
        const { credential } = await getOwnedCredential(credentialId, workspaceId)

        if (!credential) {
            return next(new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Credential not found'))
        }

        // Decrypt the credential data to get OAuth configuration
        const decryptedData = await decryptCredentialData(credential.encryptedData)

        const { clientId, authorizationUrl, scope, additionalParameters = '' } = decryptedData

        if (!isBoundedOAuth2String(clientId, true) || (scope !== undefined && !isBoundedOAuth2String(scope, false))) {
            return res.status(400).json({
                success: false,
                message: OAUTH_CONFIGURATION_INVALID
            })
        }

        if (!authorizationUrl) {
            return res.status(400).json({
                success: false,
                message: 'No authorizationUrl specified in credential data'
            })
        }

        try {
            validateStrictOAuth2Url(authorizationUrl)
        } catch {
            return res.status(400).json({
                success: false,
                message: OAUTH_CONFIGURATION_INVALID
            })
        }

        let finalRedirectUri: string
        try {
            finalRedirectUri = `${resolveFlowiseRequestTarget().canonicalOrigin}/api/v1/oauth2-credential/callback`
        } catch {
            return res.status(400).json({ success: false, message: OAUTH_CONFIGURATION_INVALID })
        }

        const authorizationEndpoint = new URL(validateStrictOAuth2Url(authorizationUrl))
        if ([...authorizationEndpoint.searchParams.keys()].some((key) => RESERVED_AUTHORIZATION_PARAMETERS.has(key.toLowerCase()))) {
            return res.status(400).json({ success: false, message: OAUTH_CONFIGURATION_INVALID })
        }

        const state = randomBytes(32).toString('base64url')
        const authParams = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            response_mode: 'query',
            state,
            redirect_uri: finalRedirectUri
        })

        if (scope) {
            authParams.append('scope', scope)
        }

        if (additionalParameters) {
            if (typeof additionalParameters !== 'string' || additionalParameters.length > 4096) {
                return res.status(400).json({ success: false, message: OAUTH_CONFIGURATION_INVALID })
            }
            const additionalAuthParams = new URLSearchParams(additionalParameters.replace(/^\?/, ''))
            for (const [key, value] of additionalAuthParams) {
                if (!key || RESERVED_AUTHORIZATION_PARAMETERS.has(key.toLowerCase())) {
                    return res.status(400).json({ success: false, message: OAUTH_CONFIGURATION_INVALID })
                }
                authParams.append(key, value)
            }
        }

        await storeOAuth2State(req, state, {
            credentialId,
            workspaceId,
            organizationId: user.activeOrganizationId,
            initiatorUserId: user.id,
            sessionId: req.sessionID,
            redirectUri: finalRedirectUri,
            expiresAt: Date.now() + OAUTH2_STATE_TTL_MS
        })

        for (const [key, value] of authParams) authorizationEndpoint.searchParams.set(key, value)
        const fullAuthorizationUrl = authorizationEndpoint.toString()

        res.json({
            success: true,
            message: 'Authorization URL generated successfully',
            credentialId,
            authorizationUrl: fullAuthorizationUrl,
            redirectUri: finalRedirectUri
        })
    } catch (error) {
        if (error instanceof InternalFlowiseError) {
            return next(error)
        }
        next(new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'OAuth2 authorization failed'))
    }
}

router.post('/authorize/:credentialId', requireInteractiveSession, checkPermission('credentials:update'), authorizeOAuth2)

// OAuth2 callback endpoint
router.get('/callback', requireCurrentOAuthCallbackSession, checkPermission('credentials:update'), async (req: Request, res: Response) => {
    try {
        const { code, state, error } = req.query

        if (typeof state !== 'string') {
            const errorHtml = generateErrorPage('Invalid authorization state', 'The authorization request is invalid or expired.')
            res.setHeader('Content-Type', 'text/html')
            return res.status(StatusCodes.BAD_REQUEST).send(errorHtml)
        }

        const user = getLoggedInUser(req)
        const pendingState = await consumeOAuth2State(req, state, user)
        if (!pendingState) {
            const errorHtml = generateErrorPage('Invalid authorization state', 'The authorization request is invalid or expired.')
            res.setHeader('Content-Type', 'text/html')
            return res.status(StatusCodes.BAD_REQUEST).send(errorHtml)
        }

        if (error) {
            const errorHtml = generateErrorPage('Authorization denied', 'The OAuth provider did not authorize this request.')

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        if (typeof code !== 'string' || !code) {
            const errorHtml = generateErrorPage('Missing required parameters', 'Missing code or state', 'Please try again later.')

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        const { credential, credentialRepository } = await getOwnedCredential(pendingState.credentialId, pendingState.workspaceId)

        if (!credential) {
            const errorHtml = generateErrorPage(
                'Credential not found',
                'Credential not found for the provided authorization request.',
                'Please try the authorization process again.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(404).send(errorHtml)
        }

        const decryptedData = await decryptCredentialData(credential.encryptedData)

        const { clientId, clientSecret, accessTokenUrl, scope } = decryptedData

        if (
            !isBoundedOAuth2String(clientId, true) ||
            !isBoundedOAuth2String(clientSecret, true) ||
            (scope !== undefined && !isBoundedOAuth2String(scope, false))
        ) {
            const errorHtml = generateErrorPage(
                'Missing OAuth configuration',
                'The OAuth credential configuration is invalid.',
                'Please check your credential setup.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        if (!accessTokenUrl) {
            const errorHtml = generateErrorPage(
                'Missing token endpoint URL',
                'No Access Token URL specified in credential data',
                'Please check your credential configuration.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        let tokenUrl: string
        try {
            tokenUrl = validateStrictOAuth2Url(accessTokenUrl)
        } catch {
            const errorHtml = generateErrorPage(
                'Invalid token endpoint URL',
                'The configured token endpoint is not allowed.',
                'Please check your credential configuration.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        const finalRedirectUri = pendingState.redirectUri

        const tokenRequestData: any = {
            client_id: clientId,
            client_secret: clientSecret,
            code,
            grant_type: 'authorization_code',
            redirect_uri: finalRedirectUri
        }

        if (scope) {
            tokenRequestData.scope = scope
        }

        const tokenResponse = await secureAxiosRequest(
            {
                method: 'POST',
                url: tokenUrl,
                data: new URLSearchParams(tokenRequestData).toString(),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json'
                },
                maxContentLength: MAX_TOKEN_RESPONSE_BYTES,
                maxBodyLength: MAX_TOKEN_RESPONSE_BYTES,
                timeout: 30_000
            },
            5,
            undefined,
            createFixedOriginPolicy(new URL(tokenUrl).origin)
        )

        if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
            const errorHtml = generateErrorPage('Token exchange failed', 'The OAuth provider did not return a successful token response.')
            res.setHeader('Content-Type', 'text/html')
            return res.status(StatusCodes.BAD_GATEWAY).send(errorHtml)
        }

        let tokenData: Record<string, any>
        try {
            tokenData = normalizeOAuth2TokenResponse(tokenResponse.data)
        } catch {
            const errorHtml = generateErrorPage('Token exchange failed', 'The OAuth provider returned an invalid token response.')
            res.setHeader('Content-Type', 'text/html')
            return res.status(StatusCodes.BAD_GATEWAY).send(errorHtml)
        }

        const updatedCredentialData: any = {
            ...decryptedData,
            ...tokenData,
            token_received_at: new Date().toISOString()
        }

        if (tokenData.expires_in) {
            const expiryTime = new Date(Date.now() + tokenData.expires_in * 1000)
            updatedCredentialData.expires_at = expiryTime.toISOString()
        }

        // Encrypt the updated credential data
        const encryptedData = await encryptCredentialData(updatedCredentialData)

        // Update the credential in the database
        const updateResult = await credentialRepository.update(
            { id: credential.id, workspaceId: pendingState.workspaceId, encryptedData: credential.encryptedData },
            {
                encryptedData,
                updatedDate: new Date()
            }
        )
        if (updateResult?.affected !== 1) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'OAuth credential update conflict')
        }

        // Return HTML that closes the popup window on success
        const successHtml = generateSuccessPage(credential.id)

        res.setHeader('Content-Type', 'text/html')
        res.send(successHtml)
    } catch (error) {
        const errorHtml = generateErrorPage('OAuth callback failed', 'The authorization could not be completed.')

        res.setHeader('Content-Type', 'text/html')
        res.status(500).send(errorHtml)
    }
})

// Refresh OAuth2 access token
const refreshOAuth2AccessToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { credentialId } = req.params
        const workspaceId = getActiveWorkspaceIdForRequest(req)
        const updatedCredentialData = await refreshOAuth2CredentialForWorkspace(credentialId, workspaceId)

        res.json({
            success: true,
            message: 'OAuth2 token refreshed successfully',
            credentialId,
            tokenInfo: {
                token_type: updatedCredentialData.token_type,
                has_refresh_token:
                    typeof updatedCredentialData.refresh_token === 'string' && updatedCredentialData.refresh_token.length > 0,
                expires_at: updatedCredentialData.expires_at
            }
        })
    } catch (error) {
        if (error instanceof InternalFlowiseError) return next(error)
        next(new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'OAuth2 credential refresh failed'))
    }
}

router.post('/refresh/:credentialId', requireInteractiveSession, checkPermission('credentials:update'), refreshOAuth2AccessToken)

export default router
