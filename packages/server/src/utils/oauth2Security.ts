import { ALLOWED_OAUTH2_TOKEN_FIELDS, DEFAULT_ALLOWED_OAUTH2_DOMAINS } from './constants'

export const MAX_OAUTH2_TOKEN_LENGTH = 128 * 1024
export const MAX_OAUTH2_TOKEN_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60

function getCustomDomains(): string[] {
    return (process.env.OAUTH2_ALLOWED_TOKEN_DOMAINS ?? '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
}

/**
 * Validates a persisted OAuth endpoint for server-side authorization and token
 * exchange. Unlike the legacy configurable validator, this policy cannot be
 * disabled: execution endpoints must always use HTTPS and an explicit domain
 * allowlist.
 */
export function validateStrictOAuth2Url(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
        throw new Error('OAuth2 endpoint is not allowed.')
    }

    try {
        const parsed = new URL(value)
        const hostname = parsed.hostname.toLowerCase()
        const allowedDomains = [...new Set([...DEFAULT_ALLOWED_OAUTH2_DOMAINS, ...getCustomDomains()])]
        const isAllowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !isAllowed) {
            throw new Error('OAuth2 endpoint is not allowed.')
        }
        return parsed.toString()
    } catch {
        throw new Error('OAuth2 endpoint is not allowed.')
    }
}

/**
 * Builds the effective list of allowed OAuth2 token-endpoint domains.
 *
 * When `OAUTH2_SECURITY_CHECK` is enabled (default), the returned list is the union
 * of `DEFAULT_ALLOWED_OAUTH2_DOMAINS` and any extra domains specified in the
 * `OAUTH2_ALLOWED_TOKEN_DOMAINS` env var. When disabled (`OAUTH2_SECURITY_CHECK=false`),
 * only the custom env var entries are used (empty list if none are configured).
 *
 * @returns Array of lowercase domain strings that OAuth2 URLs are permitted to contact
 */
export function getOAuth2AllowedDomains(): string[] {
    const securityCheckEnabled = process.env.OAUTH2_SECURITY_CHECK !== 'false'
    const customDomains = getCustomDomains()
    if (securityCheckEnabled) {
        return [...new Set([...DEFAULT_ALLOWED_OAUTH2_DOMAINS, ...customDomains])]
    }
    return customDomains
}

/**
 * Validates an OAuth2 URL against the allowed domain list.
 *
 * This is a defence-in-depth measure against SSRF: even if the caller also uses
 * `secureAxiosRequest` (which blocks private/internal IPs), this function ensures
 * the server only contacts known, legitimate OAuth2 provider domains.
 *
 * Subdomain matching is supported — e.g. allowing `zoom.us` also permits
 * `accounts.zoom.us`. When `OAUTH2_SECURITY_CHECK=false` and no custom domains
 * are configured, validation is skipped entirely.
 *
 * HTTPS is enforced only when `OAUTH2_SECURITY_CHECK` is enabled (the default).
 * Setting `OAUTH2_SECURITY_CHECK=false` allows HTTP, which is intended for local
 * development and testing against non-TLS OAuth2 servers.
 *
 * @param url - The OAuth2 authorization or token endpoint URL to validate
 * @throws Error if the URL's domain is not in the allowed list, or if HTTPS is
 *   required (`OAUTH2_SECURITY_CHECK` enabled) and the URL uses a non-HTTPS protocol
 */
export function validateOAuth2Url(url: string): void {
    const securityCheckEnabled = process.env.OAUTH2_SECURITY_CHECK !== 'false'
    const allowedDomains = getOAuth2AllowedDomains()

    if (!securityCheckEnabled && allowedDomains.length === 0) return

    const parsed = new URL(url)

    if (securityCheckEnabled && parsed.protocol !== 'https:') {
        throw new Error(`OAuth2 URL must use HTTPS: ${url}`)
    }

    const hostname = parsed.hostname.toLowerCase()
    const isAllowed = allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
    if (!isAllowed) {
        throw new Error(`OAuth2 URL domain "${hostname}" is not in the allowed list.`)
    }
}

/**
 * Extracts only recognised OAuth2 token fields from an arbitrary response object.
 *
 * Prevents data exfiltration by discarding any unexpected keys that a malicious or
 * misconfigured token endpoint might return. Only fields listed in
 * `ALLOWED_OAUTH2_TOKEN_FIELDS` are copied to the result.
 *
 * @param data - The raw JSON response body from the OAuth2 token endpoint
 * @returns A new object containing only the allowed OAuth2 token fields
 * @throws Error if the data is not a valid object (null, undefined, array, or primitive type)
 */
export function extractOAuth2TokenFields(data: Record<string, any>): Record<string, any> {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid OAuth2 token response: expected an object')
    }

    const result: Record<string, any> = {}
    for (const key of ALLOWED_OAUTH2_TOKEN_FIELDS) {
        if (data[key] !== undefined) {
            result[key] = data[key]
        }
    }
    return result
}

/** Normalizes the token response shared by authorization-code and refresh flows. */
export function normalizeOAuth2TokenResponse(data: unknown): Record<string, any> {
    const invalid = () => new Error('OAuth2 token response is invalid.')
    let tokenData: Record<string, any>
    try {
        tokenData = extractOAuth2TokenFields(data as Record<string, any>)
    } catch {
        throw invalid()
    }

    if (typeof tokenData.access_token !== 'string' || !tokenData.access_token || tokenData.access_token.length > MAX_OAUTH2_TOKEN_LENGTH) {
        throw invalid()
    }

    for (const field of ['refresh_token', 'token_type', 'scope', 'id_token', 'granted_scope']) {
        const value = tokenData[field]
        if (value !== undefined && (typeof value !== 'string' || value.length > MAX_OAUTH2_TOKEN_LENGTH)) {
            throw invalid()
        }
    }

    if (tokenData.expires_in !== undefined) {
        const expiresIn = Number(tokenData.expires_in)
        if (!Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_OAUTH2_TOKEN_LIFETIME_SECONDS) {
            throw invalid()
        }
        tokenData.expires_in = expiresIn
    }

    return tokenData
}
