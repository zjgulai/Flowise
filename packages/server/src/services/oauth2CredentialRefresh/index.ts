import { createFixedOriginPolicy, ICommonObject, OAuth2CredentialRefreshCapability, secureAxiosRequest } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { UpdateResult } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { decryptCredentialData, encryptCredentialData } from '../../utils'
import { DEFAULT_ALLOWED_OAUTH2_DOMAINS } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { MAX_OAUTH2_TOKEN_LENGTH, normalizeOAuth2TokenResponse } from '../../utils/oauth2Security'

const MAX_IDENTIFIER_LENGTH = 256
const MAX_TOKEN_RESPONSE_BYTES = 1024 * 1024

const OAUTH_REFRESH_FAILED = 'OAuth2 credential refresh failed'
const OAUTH_CREDENTIAL_NOT_FOUND = 'OAuth2 credential not found'
const OAUTH_CREDENTIAL_INVALID = 'OAuth2 credential configuration is invalid'

const inFlightRefreshes = new Map<string, Promise<ICommonObject>>()

const getStrictAllowedTokenDomains = (): string[] => {
    const customDomains = (process.env.OAUTH2_ALLOWED_TOKEN_DOMAINS ?? '')
        .split(',')
        .map((domain) => domain.trim().toLowerCase())
        .filter(Boolean)
    return [...new Set([...DEFAULT_ALLOWED_OAUTH2_DOMAINS, ...customDomains])]
}

const requireIdentifier = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_IDENTIFIER_LENGTH) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid ${field}`)
    }
    return value
}

const validateTokenEndpoint = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OAUTH_CREDENTIAL_INVALID)
    }

    try {
        const tokenUrl = new URL(value)
        const hostname = tokenUrl.hostname.toLowerCase()
        const isAllowedDomain = getStrictAllowedTokenDomains().some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
        if (tokenUrl.protocol !== 'https:' || tokenUrl.username || tokenUrl.password || tokenUrl.hash || !isAllowedDomain) {
            throw new Error(OAUTH_CREDENTIAL_INVALID)
        }
        return tokenUrl.toString()
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OAUTH_CREDENTIAL_INVALID)
    }
}

const requireTokenString = (value: unknown): string => {
    if (typeof value !== 'string' || !value || value.length > MAX_OAUTH2_TOKEN_LENGTH) {
        throw new InternalFlowiseError(StatusCodes.BAD_GATEWAY, OAUTH_REFRESH_FAILED)
    }
    return value
}

const refreshOwnedOAuth2Credential = async (credentialId: string, workspaceId: string): Promise<ICommonObject> => {
    const appServer = getRunningExpressApp()
    const credentialRepository = appServer.AppDataSource.getRepository(Credential)
    const credential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
    if (!credential) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OAUTH_CREDENTIAL_NOT_FOUND)

    const decryptedData = await decryptCredentialData(credential.encryptedData)
    const clientId = requireTokenString(decryptedData.clientId)
    const clientSecret = requireTokenString(decryptedData.clientSecret)
    const refreshToken = requireTokenString(decryptedData.refresh_token)
    const tokenUrl = validateTokenEndpoint(decryptedData.accessTokenUrl)
    const scope =
        decryptedData.scope === undefined
            ? undefined
            : typeof decryptedData.scope === 'string' && decryptedData.scope.length <= MAX_OAUTH2_TOKEN_LENGTH
            ? decryptedData.scope
            : (() => {
                  throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OAUTH_CREDENTIAL_INVALID)
              })()

    const refreshRequestData: Record<string, string> = {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    }
    if (scope) refreshRequestData.scope = scope

    let tokenResponse
    try {
        tokenResponse = await secureAxiosRequest(
            {
                method: 'POST',
                url: tokenUrl,
                data: new URLSearchParams(refreshRequestData).toString(),
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
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_GATEWAY, OAUTH_REFRESH_FAILED)
    }

    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
        throw new InternalFlowiseError(StatusCodes.BAD_GATEWAY, OAUTH_REFRESH_FAILED)
    }

    let tokenData: ICommonObject
    try {
        tokenData = normalizeOAuth2TokenResponse(tokenResponse.data)
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_GATEWAY, OAUTH_REFRESH_FAILED)
    }
    const refreshedAt = new Date()
    const updatedCredentialData: ICommonObject = {
        ...decryptedData,
        ...tokenData,
        token_received_at: refreshedAt.toISOString()
    }
    if (!tokenData.refresh_token) updatedCredentialData.refresh_token = refreshToken
    if (tokenData.expires_in) {
        updatedCredentialData.expires_at = new Date(refreshedAt.getTime() + Number(tokenData.expires_in) * 1000).toISOString()
    } else {
        delete updatedCredentialData.expires_at
    }

    const encryptedData = await encryptCredentialData(updatedCredentialData)
    const updateResult = (await credentialRepository.update(
        { id: credential.id, workspaceId, encryptedData: credential.encryptedData },
        { encryptedData, updatedDate: refreshedAt }
    )) as UpdateResult

    if (updateResult?.affected === 0) {
        const currentCredential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
        if (currentCredential?.encryptedData && currentCredential.encryptedData !== credential.encryptedData) {
            return decryptCredentialData(currentCredential.encryptedData)
        }
        throw new InternalFlowiseError(StatusCodes.CONFLICT, OAUTH_REFRESH_FAILED)
    }

    return updatedCredentialData
}

export const refreshOAuth2CredentialForWorkspace = async (credentialIdInput: string, workspaceIdInput: string): Promise<ICommonObject> => {
    const credentialId = requireIdentifier(credentialIdInput, 'credential ID')
    const workspaceId = requireIdentifier(workspaceIdInput, 'workspace ID')
    const refreshKey = JSON.stringify([workspaceId, credentialId])
    const existingRefresh = inFlightRefreshes.get(refreshKey)
    if (existingRefresh) return existingRefresh

    const refreshPromise = refreshOwnedOAuth2Credential(credentialId, workspaceId).finally(() => {
        if (inFlightRefreshes.get(refreshKey) === refreshPromise) inFlightRefreshes.delete(refreshKey)
    })
    inFlightRefreshes.set(refreshKey, refreshPromise)
    return refreshPromise
}

export const createWorkspaceOAuth2RefreshCapability = (workspaceIdInput: string): OAuth2CredentialRefreshCapability => {
    const workspaceId = requireIdentifier(workspaceIdInput, 'workspace ID')
    return async (credentialId: string) => refreshOAuth2CredentialForWorkspace(credentialId, workspaceId)
}
