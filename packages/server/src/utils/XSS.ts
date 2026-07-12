import { NextFunction, Request, Response } from 'express'
import { isValidUUID } from 'flowise-components'
import sanitizeHtml from 'sanitize-html'
import { extractChatflowId, isPublicChatflowRequest, isTTSGenerateRequest, validateChatflowDomain } from './domainValidation'
import logger from './logger'

export function sanitizeMiddleware(req: Request, res: Response, next: NextFunction): void {
    // decoding is necessary as the url is encoded by the browser
    const decodedURI = decodeURI(req.url)
    req.url = sanitizeHtml(decodedURI)
    for (let p in req.query) {
        if (Array.isArray(req.query[p])) {
            const sanitizedQ = []
            for (const q of req.query[p] as string[]) {
                sanitizedQ.push(sanitizeHtml(q))
            }
            req.query[p] = sanitizedQ
        } else {
            req.query[p] = sanitizeHtml(req.query[p] as string)
        }
    }
    next()
}

export function getAllowedCorsOrigins(): string {
    // Expects FQDN separated by commas, otherwise nothing.
    return process.env.CORS_ORIGINS ?? ''
}

export function getAllowCredentials(): boolean {
    return process.env.CORS_ALLOW_CREDENTIALS === 'true'
}

export function getAllowedAuthCorsOrigins(): string[] {
    const appUrl = process.env.APP_URL?.trim()
    if (!appUrl) return []
    try {
        return [new URL(appUrl).origin.toLowerCase()]
    } catch {
        return []
    }
}

// Endpoints that issue or refresh session tokens — must not accept wildcard origins
const SESSION_ENDPOINTS = [
    '/api/v1/auth/login',
    '/api/v1/auth/refreshtoken',
    '/api/v1/account/register',
    '/api/v1/azure/callback',
    '/api/v1/google/callback',
    '/api/v1/auth0/callback',
    '/api/v1/github/callback'
]

function isSessionEndpoint(url: string): boolean {
    const path = url.split('?')[0].toLowerCase()
    return SESSION_ENDPOINTS.some((ep) => path === ep || path.startsWith(ep + '/'))
}

function parseAllowedOrigins(allowedOrigins: string): string[] {
    if (!allowedOrigins) {
        return []
    }
    if (allowedOrigins === '*') {
        return ['*']
    }
    return allowedOrigins
        .split(',')
        .map((origin) => origin.trim().toLowerCase())
        .filter((origin) => origin.length > 0)
}

export function validateCorsConfig(): void {
    const allowedOrigins = getAllowedCorsOrigins()
    if (!allowedOrigins && process.env.NODE_ENV === 'production') {
        logger.warn(
            '[CORS] CORS_ORIGINS is not set in production environment. ' +
                'All cross-origin requests will be rejected. ' +
                'Set CORS_ORIGINS to an explicit comma-separated list of trusted origins.'
        )
    }

    if (allowedOrigins === '*' && getAllowCredentials()) {
        logger.warn(
            '[CORS] Unsafe configuration detected: CORS_ORIGINS=* cannot be combined with ' +
                'CORS_ALLOW_CREDENTIALS=true. Access-Control-Allow-Credentials has been forced to false. ' +
                'To allow credentialed cross-origin requests, set CORS_ORIGINS to an explicit comma-separated ' +
                'list of trusted origins instead of *.'
        )
    }

    getAllowedIframeOrigins()
}

export function getCorsOptions(): any {
    return (req: any, callback: (err: Error | null, options?: any) => void) => {
        const allowedOrigins = getAllowedCorsOrigins()
        const requestedCredentials = getAllowCredentials()
        const credentials = allowedOrigins === '*' ? false : requestedCredentials

        const corsOptions = {
            credentials,
            origin: async (origin: string | undefined, originCallback: (err: Error | null, allow?: boolean) => void) => {
                const isPublicChatflowReq = isPublicChatflowRequest(req.url)
                const isTTSReq = isTTSGenerateRequest(req.url)
                const allowedList = parseAllowedOrigins(allowedOrigins)
                const originLc = origin?.toLowerCase()

                // Always allow no-Origin requests (same-origin, server-to-server)
                if (!originLc) return originCallback(null, true)

                // Block null origins (sandboxed iframes, data: URIs, file:// pages)
                if (originLc === 'null') return originCallback(null, false)

                // Session-issuing endpoints: ignore global wildcard, use APP_URL origin or explicit CORS_ORIGINS list
                if (isSessionEndpoint(req.url)) {
                    const authList = getAllowedAuthCorsOrigins()
                    return originCallback(null, authList.includes(originLc) || allowedList.includes(originLc))
                }

                // Global allow: '*' or exact match
                const globallyAllowed = allowedOrigins === '*' || allowedList.includes(originLc)

                if (isPublicChatflowReq || isTTSReq) {
                    // Per-chatflow allowlist OR globally allowed
                    // TTS generate passes chatflowId in the request body, not the URL path
                    const chatflowId = isTTSReq ? req.body?.chatflowId : extractChatflowId(req.url)
                    let chatflowAllowed = false
                    if (chatflowId) {
                        if (!isValidUUID(chatflowId)) {
                            return originCallback(null, globallyAllowed)
                        }
                        try {
                            chatflowAllowed = await validateChatflowDomain(chatflowId, originLc, req.user?.activeWorkspaceId)
                        } catch (error) {
                            // Log error and deny on failure
                            console.error('Domain validation error:', error)
                            chatflowAllowed = false
                        }
                    } else if (isTTSReq) {
                        // OPTIONS preflight has no body — allow it through so the actual POST can be validated with chatflowId
                        chatflowAllowed = true
                    }
                    return originCallback(null, globallyAllowed || chatflowAllowed)
                }

                // Non-prediction: rely on global policy only
                return originCallback(null, globallyAllowed)
            }
        }
        callback(null, corsOptions)
    }
}

function invalidIframeOrigins(reason: string): never {
    throw new Error(`[CSP] Invalid IFRAME_ORIGINS: ${reason}.`)
}

function isLocalHostname(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

export function parseIframeOrigins(rawValue: string | undefined, nodeEnv: string | undefined = process.env.NODE_ENV): string[] {
    const raw = rawValue?.trim()
    if (!raw) return ["'self'"]

    if (/[\u0000-\u001f\u007f;]/.test(raw)) {
        invalidIframeOrigins('control characters and directive separators are not allowed')
    }

    const sources = raw.split(',').map((source) => source.trim())
    if (sources.some((source) => source.length === 0)) {
        invalidIframeOrigins('empty comma-separated entries are not allowed')
    }

    const normalized: string[] = []
    for (const source of sources) {
        if (source === "'self'") {
            normalized.push(source)
            continue
        }
        if (source === "'none'") {
            normalized.push(source)
            continue
        }
        if (source === '*') {
            if (nodeEnv === 'production') invalidIframeOrigins('wildcard embedding is not allowed in production')
            normalized.push(source)
            continue
        }
        if (source.startsWith("'") || source.endsWith("'") || source === 'self' || source === 'none') {
            invalidIframeOrigins('unsupported quoted or bare keywords are not allowed')
        }

        let parsed: URL
        try {
            parsed = new URL(source)
        } catch {
            invalidIframeOrigins('each source must be an exact origin')
        }

        if (parsed.hostname.includes('*')) invalidIframeOrigins('hostname wildcards are not allowed')
        if (parsed.username || parsed.password) invalidIframeOrigins('URL credentials are not allowed')
        if (parsed.pathname !== '/' || source.includes('?') || source.includes('#')) {
            invalidIframeOrigins('paths, queries, and fragments are not allowed')
        }

        if (parsed.protocol === 'http:') {
            if (nodeEnv === 'production') invalidIframeOrigins('production origins must use HTTPS')
            if (!isLocalHostname(parsed.hostname)) invalidIframeOrigins('HTTP is limited to local development origins')
        } else if (parsed.protocol !== 'https:') {
            invalidIframeOrigins('origins must use HTTPS')
        }

        normalized.push(parsed.origin)
    }

    const uniqueSources = [...new Set(normalized)]
    if (uniqueSources.includes("'none'") && uniqueSources.length !== 1) {
        invalidIframeOrigins("'none' cannot be combined with another source")
    }
    if (uniqueSources.includes('*') && uniqueSources.length !== 1) {
        invalidIframeOrigins('wildcard cannot be combined with another source')
    }
    return uniqueSources
}

export function getAllowedIframeOrigins(): string {
    return parseIframeOrigins(process.env.IFRAME_ORIGINS).join(' ')
}

export function getIframeSecurityHeaders(allowedOrigins = getAllowedIframeOrigins()): Record<string, string> {
    if (allowedOrigins === '*') {
        return {
            'Content-Security-Policy': 'frame-ancestors *'
        }
    }

    if (allowedOrigins === "'self'") {
        return {
            'Content-Security-Policy': `frame-ancestors ${allowedOrigins}`,
            'X-Frame-Options': 'SAMEORIGIN'
        }
    }

    if (allowedOrigins === "'none'") {
        return {
            'Content-Security-Policy': `frame-ancestors ${allowedOrigins}`,
            'X-Frame-Options': 'DENY'
        }
    }

    return {
        'Content-Security-Policy': `frame-ancestors ${allowedOrigins}`
    }
}
