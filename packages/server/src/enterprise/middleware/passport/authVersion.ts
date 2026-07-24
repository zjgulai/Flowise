import { createHmac } from 'crypto'
import { getJWTAuthTokenSecret } from '../../utils/authSecrets'

/** A one-way identity generation marker; changing the password or confirmed email invalidates serialized sessions. */
export function createCredentialAuthVersion(
    credential: string | null | undefined,
    email: string | null | undefined,
    secret = getJWTAuthTokenSecret()
): string | undefined {
    if (!credential) return undefined
    return createHmac('sha256', secret)
        .update(credential)
        .update('\0')
        .update(email?.trim().toLowerCase() ?? '')
        .digest('hex')
}
