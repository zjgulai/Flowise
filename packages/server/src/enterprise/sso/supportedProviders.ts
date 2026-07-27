export const SUPPORTED_SSO_PROVIDERS = ['azure', 'google', 'auth0', 'github'] as const

export type SupportedSSOProvider = (typeof SUPPORTED_SSO_PROVIDERS)[number]

const supportedSSOProviderSet = new Set<string>(SUPPORTED_SSO_PROVIDERS)

export function isSupportedSSOProvider(providerName: unknown): providerName is SupportedSSOProvider {
    return typeof providerName === 'string' && supportedSSOProviderSet.has(providerName)
}
