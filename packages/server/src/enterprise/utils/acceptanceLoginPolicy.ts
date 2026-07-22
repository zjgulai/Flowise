import { createHash } from 'node:crypto'

export const ACCEPTANCE_LOGIN_PATH = '/api/v1/auth/acceptance-login'
export const ACCEPTANCE_TOKEN_PREFIX = 'acceptance:v1:'
export const ACCEPTANCE_LOGIN_MESSAGE = '认证不可用或已失效，请重新生成一次性认证码。'

const ACCEPTANCE_HASH_CONTEXT = 'flowise-acceptance:v1\0'
const ACCEPTANCE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SYNTHETIC_EMAIL_PATTERN = /^flowise-acceptance\+([a-z0-9][a-z0-9-]{0,63})@acceptance\.invalid$/

export function hashAcceptanceCode(code: unknown): string | undefined {
    if (typeof code !== 'string' || !ACCEPTANCE_CODE_PATTERN.test(code)) return undefined
    const digest = createHash('sha256').update(ACCEPTANCE_HASH_CONTEXT, 'utf8').update(code, 'utf8').digest('hex')
    return `${ACCEPTANCE_TOKEN_PREFIX}${digest}`
}

export function getAcceptanceRunId(email: unknown): string | undefined {
    if (typeof email !== 'string') return undefined
    return SYNTHETIC_EMAIL_PATTERN.exec(email)?.[1]
}

export function isAcceptanceTokenUnexpired(expiry: Date | null | undefined, now = new Date()): boolean {
    return expiry instanceof Date && Number.isFinite(expiry.getTime()) && expiry.getTime() > now.getTime()
}
