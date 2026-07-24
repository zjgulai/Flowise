import { Request, Response } from 'express'
import jwt, { JwtPayload, sign } from 'jsonwebtoken'
import { v4 as uuidv4 } from 'uuid'
import { getRunningExpressApp } from '../../../utils/getRunningExpressApp'
import { LoggedInUser } from '../../Interface.Enterprise'
import { getJWTAudience, getJWTAuthTokenSecret, getJWTIssuer, getJWTRefreshTokenSecret } from '../../utils/authSecrets'
import { encryptToken, generateSafeCopy } from '../../utils/tempTokenUtils'
import { resolveSecureCookie } from './authSecurityPolicy'

export const setTokenOrCookies = (
    res: Response,
    user: any,
    regenerateRefreshToken: boolean,
    req?: Request,
    redirect?: boolean,
    isSSO?: boolean
) => {
    const secureCookie = resolveSecureCookie()
    const token = generateJwtAuthToken(user)
    const refreshToken = regenerateRefreshToken ? generateJwtRefreshToken(user) : req?.cookies?.refreshToken
    const returnUser = generateSafeCopy(user)
    delete returnUser.authVersion
    returnUser.isSSO = Boolean(isSSO)

    const responseWithCookies = res
        .cookie('token', token, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'lax'
        })
        .cookie('refreshToken', refreshToken, {
            httpOnly: true,
            secure: secureCookie,
            sameSite: 'lax'
        })

    if (redirect) {
        const ssoToken = uuidv4()
        getRunningExpressApp().cachePool.addSSOTokenCache(ssoToken, returnUser)
        return responseWithCookies.redirect(`/sso-success?token=${ssoToken}`)
    }

    return responseWithCookies.type('json').send({ ...returnUser })
}

export const generateJwtAuthToken = (user: any) => {
    let expiryInMinutes = -1
    if (user?.ssoToken) {
        const jwtHeader = jwt.decode(user.ssoToken, { complete: true })
        if (jwtHeader) {
            const utcSeconds = (jwtHeader.payload as any).exp
            const expiry = new Date(0)
            expiry.setUTCSeconds(utcSeconds)
            expiryInMinutes = Math.abs(expiry.getTime() - Date.now()) / 60000
        }
    }
    if (expiryInMinutes === -1) {
        expiryInMinutes = process.env.JWT_TOKEN_EXPIRY_IN_MINUTES ? parseInt(process.env.JWT_TOKEN_EXPIRY_IN_MINUTES) : 60
    }
    return generateJwtToken(user, expiryInMinutes, getJWTAuthTokenSecret())
}

export const generateJwtRefreshToken = (user: any) => {
    let expiryInMinutes = -1
    if (user.ssoRefreshToken) {
        const jwtHeader = jwt.decode(user.ssoRefreshToken, { complete: false })
        if (jwtHeader && typeof jwtHeader !== 'string') {
            const utcSeconds = (jwtHeader as JwtPayload).exp
            if (utcSeconds) {
                const expiry = new Date(0)
                expiry.setUTCSeconds(utcSeconds)
                expiryInMinutes = Math.abs(expiry.getTime() - Date.now()) / 60000
            }
        }
    }
    if (expiryInMinutes === -1) {
        expiryInMinutes = process.env.JWT_REFRESH_TOKEN_EXPIRY_IN_MINUTES
            ? parseInt(process.env.JWT_REFRESH_TOKEN_EXPIRY_IN_MINUTES)
            : 129600
    }
    return generateJwtToken(user, expiryInMinutes, getJWTRefreshTokenSecret())
}

const generateJwtToken = (user: Partial<LoggedInUser>, expiryInMinutes: number, secret: string) => {
    const encryptedUserInfo = encryptToken(`${user?.id}:${user?.activeWorkspaceId}`)
    return sign({ id: user?.id, username: user?.name, meta: encryptedUserInfo }, secret, {
        expiresIn: `${expiryInMinutes}m`,
        notBefore: '0',
        algorithm: 'HS256',
        audience: getJWTAudience(),
        issuer: getJWTIssuer()
    })
}
