import { JwtFromRequestFunction, Strategy as JwtStrategy, VerifiedCallback } from 'passport-jwt'
import { decryptToken } from '../../utils/tempTokenUtils'
import { Strategy } from 'passport'
import { Request } from 'express'
import { ICommonObject } from 'flowise-components'
import { DataSource } from 'typeorm'
import { IdentityManager } from '../../../IdentityManager'
import { getRunningExpressApp } from '../../../utils/getRunningExpressApp'
import { UserStatus } from '../../database/entities/user.entity'
import { WorkspaceUser } from '../../database/entities/workspace-user.entity'
import { LoggedInUser } from '../../Interface.Enterprise'
import { buildLoggedInUser } from '../../services/loggedInUserBuilder'
import { UserService } from '../../services/user.service'
import { WorkspaceUserService } from '../../services/workspace-user.service'
import { isAdminOnlyModeEnabled } from '../../utils/adminOnlyPolicy'
import { createCredentialAuthVersion } from './authVersion'

const _cookieExtractor = (req: any) => {
    let jwt = null

    if (req && req.cookies) {
        jwt = req.cookies['token']
    }

    return jwt
}

type VersionedLoggedInUser = LoggedInUser & { authVersion?: string }

type AuthorizationReloadDependencies = {
    dataSource?: Pick<DataSource, 'createQueryRunner'>
    identityManager?: IdentityManager
    userService?: Pick<UserService, 'readUserById'>
    workspaceUserService?: Pick<WorkspaceUserService, 'readWorkspaceUserByWorkspaceIdUserId'>
    buildUser?: typeof buildLoggedInUser
    credentialVersion?: typeof createCredentialAuthVersion
    adminOnlyMode?: boolean
}

export function isTokenBoundToSession(payload: ICommonObject, decryptedMeta: string, user: Partial<LoggedInUser>): boolean {
    return payload.id === user.id && decryptedMeta === `${user.id}:${user.activeWorkspaceId}`
}

/** Reloads status, membership, role and permissions instead of trusting the serialized Passport snapshot. */
export async function reloadSessionAuthorization(
    sessionUser: VersionedLoggedInUser,
    overrides: AuthorizationReloadDependencies = {}
): Promise<VersionedLoggedInUser | undefined> {
    if (!sessionUser?.id || !sessionUser.activeWorkspaceId) return undefined

    const needsRunningApp =
        !overrides.dataSource ||
        !overrides.identityManager ||
        !overrides.userService ||
        !overrides.workspaceUserService ||
        !overrides.buildUser
    const app = needsRunningApp ? getRunningExpressApp() : undefined
    const dataSource = overrides.dataSource ?? app!.AppDataSource
    const identityManager = overrides.identityManager ?? app!.identityManager
    const userService = overrides.userService ?? new UserService()
    const workspaceUserService = overrides.workspaceUserService ?? new WorkspaceUserService()
    const buildUser = overrides.buildUser ?? buildLoggedInUser
    const credentialVersion = overrides.credentialVersion ?? createCredentialAuthVersion
    const adminOnlyMode = overrides.adminOnlyMode ?? isAdminOnlyModeEnabled()
    const queryRunner = dataSource.createQueryRunner()

    try {
        await queryRunner.connect()
        const currentUser = await userService.readUserById(sessionUser.id, queryRunner)
        if (!currentUser || currentUser.status !== UserStatus.ACTIVE) return undefined

        const currentAuthVersion = credentialVersion(currentUser.credential, currentUser.email)
        if (currentAuthVersion && !sessionUser.authVersion && !sessionUser.ssoProvider) return undefined
        if (sessionUser.authVersion && sessionUser.authVersion !== currentAuthVersion) return undefined

        const { workspace, workspaceUser } = await workspaceUserService.readWorkspaceUserByWorkspaceIdUserId(
            sessionUser.activeWorkspaceId,
            sessionUser.id,
            queryRunner
        )
        if (!workspaceUser) return undefined

        let rebuilt: LoggedInUser
        try {
            rebuilt = await buildUser({
                user: currentUser,
                workspaceUser: { ...workspaceUser, workspace } as WorkspaceUser,
                queryRunner,
                identityManager,
                mode: 'acceptance-login',
                adminOnlyMode
            })
        } catch {
            return undefined
        }
        if (adminOnlyMode && !rebuilt.isOrganizationAdmin) return undefined

        return {
            ...rebuilt,
            ...(currentAuthVersion ? { authVersion: currentAuthVersion } : {}),
            ssoProvider: sessionUser.ssoProvider,
            ssoToken: sessionUser.ssoToken,
            ssoRefreshToken: sessionUser.ssoRefreshToken
        }
    } finally {
        if (!queryRunner.isReleased) await queryRunner.release()
    }
}

export const getAuthStrategy = (options: any): Strategy => {
    let jwtFromRequest: JwtFromRequestFunction
    jwtFromRequest = _cookieExtractor
    const jwtOptions = {
        jwtFromRequest: jwtFromRequest,
        passReqToCallback: true,
        ...options
    }
    const jwtVerify = async (req: Request, payload: ICommonObject, done: VerifiedCallback) => {
        try {
            if (!req.user) {
                return done(null, false, 'Unauthorized.')
            }
            const meta = decryptToken(payload.meta)
            if (!meta) {
                return done(null, false, 'Unauthorized.')
            }
            if (!isTokenBoundToSession(payload, meta, req.user)) {
                return done(null, false, 'Unauthorized.')
            }
            const currentUser = await reloadSessionAuthorization(req.user as VersionedLoggedInUser)
            if (!currentUser) return done(null, false, 'Unauthorized.')
            done(null, currentUser)
        } catch (error) {
            done(error, false)
        }
    }
    return new JwtStrategy(jwtOptions, jwtVerify)
}
