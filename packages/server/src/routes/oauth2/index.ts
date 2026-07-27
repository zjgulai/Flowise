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
 * - redirect_uri: Custom redirect URI (defaults to this callback endpoint)
 * - scope: OAuth2 scopes to request (e.g., "user.read mail.read")
 * - response_type: OAuth2 response type (defaults to "code")
 * - response_mode: OAuth2 response mode (defaults to "query")
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

import axios from 'axios'
import { randomBytes } from 'crypto'
import express, { NextFunction, Request, Response } from 'express'
import { secureAxiosRequest } from 'flowise-components'
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
import { extractOAuth2TokenFields, validateOAuth2Url } from '../../utils/oauth2Security'
import { generateErrorPage, generateSuccessPage } from './templates'

const router = express.Router()

const OAUTH2_STATE_TTL_MS = 10 * 60 * 1000
const MAX_PENDING_OAUTH2_STATES = 10

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

        const {
            clientId,
            authorizationUrl,
            redirect_uri,
            scope,
            response_type = 'code',
            response_mode = 'query',
            additionalParameters = ''
        } = decryptedData

        if (!clientId) {
            return res.status(400).json({
                success: false,
                message: 'Missing clientId in credential data'
            })
        }

        if (!authorizationUrl) {
            return res.status(400).json({
                success: false,
                message: 'No authorizationUrl specified in credential data'
            })
        }

        try {
            validateOAuth2Url(authorizationUrl)
        } catch (err) {
            return res.status(400).json({
                success: false,
                message: err instanceof Error ? err.message : 'Invalid authorization URL'
            })
        }

        const defaultRedirectUri = `${req.protocol}://${req.get('host')}/api/v1/oauth2-credential/callback`
        const finalRedirectUri = redirect_uri || defaultRedirectUri

        const state = randomBytes(32).toString('base64url')
        await storeOAuth2State(req, state, {
            credentialId,
            workspaceId,
            organizationId: user.activeOrganizationId,
            initiatorUserId: user.id,
            sessionId: req.sessionID,
            redirectUri: finalRedirectUri,
            expiresAt: Date.now() + OAUTH2_STATE_TTL_MS
        })

        const authParams = new URLSearchParams({
            client_id: clientId,
            response_type,
            response_mode,
            state,
            redirect_uri: finalRedirectUri
        })

        if (scope) {
            authParams.append('scope', scope)
        }

        if (additionalParameters) {
            const reservedParameters = new Set(['client_id', 'response_type', 'response_mode', 'state', 'redirect_uri'])
            const additionalAuthParams = new URLSearchParams(additionalParameters.toString().replace(/^\?/, ''))
            for (const [key, value] of additionalAuthParams) {
                if (!reservedParameters.has(key)) authParams.append(key, value)
            }
        }

        const authorizationEndpoint = new URL(authorizationUrl)
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
        next(
            new InternalFlowiseError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                `OAuth2 authorization error: ${error instanceof Error ? error.message : 'Unknown error'}`
            )
        )
    }
}

router.post('/authorize/:credentialId', requireInteractiveSession, checkPermission('credentials:update'), authorizeOAuth2)

// OAuth2 callback endpoint
router.get('/callback', requireCurrentOAuthCallbackSession, checkPermission('credentials:update'), async (req: Request, res: Response) => {
    try {
        const { code, state, error, error_description } = req.query

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
            const errorHtml = generateErrorPage(
                error as string,
                (error_description as string) || 'An error occurred',
                error_description ? `Description: ${error_description}` : undefined
            )

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

        if (!clientId || !clientSecret) {
            const errorHtml = generateErrorPage(
                'Missing OAuth configuration',
                'Missing clientId or clientSecret',
                'Please check your credential setup.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        let tokenUrl = accessTokenUrl
        if (!tokenUrl) {
            const errorHtml = generateErrorPage(
                'Missing token endpoint URL',
                'No Access Token URL specified in credential data',
                'Please check your credential configuration.'
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        try {
            validateOAuth2Url(tokenUrl)
        } catch (err) {
            const errorHtml = generateErrorPage(
                'Invalid token endpoint URL',
                err instanceof Error ? err.message : 'Token endpoint URL is not allowed',
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

        const tokenResponse = await secureAxiosRequest({
            method: 'POST',
            url: tokenUrl,
            data: new URLSearchParams(tokenRequestData).toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        })

        if (tokenResponse.status >= 400) {
            const errorHtml = generateErrorPage(
                tokenResponse.data?.error || 'token_exchange_failed',
                tokenResponse.data?.error_description || 'Token exchange failed',
                tokenResponse.data?.error_description ? `Description: ${tokenResponse.data.error_description}` : undefined
            )
            res.setHeader('Content-Type', 'text/html')
            return res.status(tokenResponse.status).send(errorHtml)
        }

        const tokenData = extractOAuth2TokenFields(tokenResponse.data)

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
        await credentialRepository.update(credential.id, {
            encryptedData,
            updatedDate: new Date()
        })

        // Return HTML that closes the popup window on success
        const successHtml = generateSuccessPage(credential.id)

        res.setHeader('Content-Type', 'text/html')
        res.send(successHtml)
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const axiosError = error
            const errorHtml = generateErrorPage(
                axiosError.response?.data?.error || 'token_exchange_failed',
                axiosError.response?.data?.error_description || 'Token exchange failed',
                axiosError.response?.data?.error_description ? `Description: ${axiosError.response?.data?.error_description}` : undefined
            )

            res.setHeader('Content-Type', 'text/html')
            return res.status(400).send(errorHtml)
        }

        // Generic error HTML page
        const errorHtml = generateErrorPage(
            'An unexpected error occurred',
            'Please try again later.',
            error instanceof Error ? error.message : 'Unknown error'
        )

        res.setHeader('Content-Type', 'text/html')
        res.status(500).send(errorHtml)
    }
})

// Refresh OAuth2 access token
const refreshOAuth2AccessToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { credentialId } = req.params
        const workspaceId = getActiveWorkspaceIdForRequest(req)
        const { credential, credentialRepository } = await getOwnedCredential(credentialId, workspaceId)

        if (!credential) {
            return res.status(404).json({
                success: false,
                message: 'Credential not found'
            })
        }

        const decryptedData = await decryptCredentialData(credential.encryptedData)

        const { clientId, clientSecret, refresh_token, accessTokenUrl, scope } = decryptedData

        if (!clientId || !clientSecret || !refresh_token) {
            return res.status(400).json({
                success: false,
                message: 'Missing required OAuth configuration: clientId, clientSecret, or refresh_token'
            })
        }

        let tokenUrl = accessTokenUrl
        if (!tokenUrl) {
            return res.status(400).json({
                success: false,
                message: 'No Access Token URL specified in credential data'
            })
        }

        try {
            validateOAuth2Url(tokenUrl)
        } catch (err) {
            return res.status(400).json({
                success: false,
                message: err instanceof Error ? err.message : 'Token endpoint URL is not allowed'
            })
        }

        const refreshRequestData: any = {
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'refresh_token',
            refresh_token
        }

        if (scope) {
            refreshRequestData.scope = scope
        }

        const tokenResponse = await secureAxiosRequest({
            method: 'POST',
            url: tokenUrl,
            data: new URLSearchParams(refreshRequestData).toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }
        })

        if (tokenResponse.status >= 400) {
            return res.status(tokenResponse.status).json({
                success: false,
                message: `Token refresh failed: ${tokenResponse.data?.error_description || tokenResponse.statusText}`,
                details: tokenResponse.data
            })
        }

        const tokenData = extractOAuth2TokenFields(tokenResponse.data)

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
        await credentialRepository.update(credential.id, {
            encryptedData,
            updatedDate: new Date()
        })

        res.json({
            success: true,
            message: 'OAuth2 token refreshed successfully',
            credentialId: credential.id,
            tokenInfo: {
                token_type: tokenData.token_type,
                has_new_refresh_token: !!tokenData.refresh_token,
                expires_at: updatedCredentialData.expires_at
            }
        })
    } catch (error) {
        if (axios.isAxiosError(error)) {
            const axiosError = error
            return res.status(400).json({
                success: false,
                message: `Token refresh failed: ${axiosError.response?.data?.error_description || axiosError.message}`,
                details: axiosError.response?.data
            })
        }

        next(
            new InternalFlowiseError(
                StatusCodes.INTERNAL_SERVER_ERROR,
                `OAuth2 token refresh error: ${error instanceof Error ? error.message : 'Unknown error'}`
            )
        )
    }
}

router.post('/refresh/:credentialId', requireInteractiveSession, checkPermission('credentials:update'), refreshOAuth2AccessToken)

export default router
