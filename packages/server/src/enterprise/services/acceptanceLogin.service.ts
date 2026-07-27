import { DataSource, IsNull, MoreThan } from 'typeorm'
import { IdentityManager } from '../../IdentityManager'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { User, UserStatus } from '../database/entities/user.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { LoggedInUser } from '../Interface.Enterprise'
import { getAcceptanceRunId, hashAcceptanceCode, isAcceptanceTokenUnexpired } from '../utils/acceptanceLoginPolicy'
import { OrganizationUserService } from './organization-user.service'
import { buildLoggedInUser } from './loggedInUserBuilder'
import { WorkspaceUserService } from './workspace-user.service'

export class AcceptanceLoginRejectedError extends Error {
    constructor() {
        super('Acceptance login rejected')
        this.name = 'AcceptanceLoginRejectedError'
    }
}

export interface AcceptanceLoginServiceDependencies {
    dataSource: DataSource
    identityManager: IdentityManager
    now?: () => Date
    buildUser?: typeof buildLoggedInUser
    workspaceUserService?: Pick<WorkspaceUserService, 'readWorkspaceUserByLastLogin'>
    organizationUserService?: Pick<OrganizationUserService, 'readOrganizationUserByWorkspaceIdUserId'>
}

export class AcceptanceLoginService {
    private readonly dataSource: DataSource
    private readonly identityManager: IdentityManager
    private readonly now: () => Date
    private readonly buildUser: typeof buildLoggedInUser
    private readonly workspaceUserService: Pick<WorkspaceUserService, 'readWorkspaceUserByLastLogin'>
    private readonly organizationUserService: Pick<OrganizationUserService, 'readOrganizationUserByWorkspaceIdUserId'>

    constructor(dependencies: AcceptanceLoginServiceDependencies) {
        this.dataSource = dependencies.dataSource
        this.identityManager = dependencies.identityManager
        this.now = dependencies.now ?? (() => new Date())
        this.buildUser = dependencies.buildUser ?? buildLoggedInUser
        this.workspaceUserService = dependencies.workspaceUserService ?? new WorkspaceUserService()
        this.organizationUserService = dependencies.organizationUserService ?? new OrganizationUserService()
    }

    async consume(code: unknown): Promise<LoggedInUser> {
        const storedHash = hashAcceptanceCode(code)
        if (!storedHash) throw new AcceptanceLoginRejectedError()

        const queryRunner = this.dataSource.createQueryRunner()
        await queryRunner.connect()
        try {
            const now = this.now()
            const user = await queryRunner.manager.findOneBy(User, { tempToken: storedHash })
            if (
                !user ||
                user.tempToken !== storedHash ||
                user.credential != null ||
                user.status !== UserStatus.ACTIVE ||
                !getAcceptanceRunId(user.email) ||
                !isAcceptanceTokenUnexpired(user.tokenExpiry, now)
            ) {
                throw new AcceptanceLoginRejectedError()
            }

            const workspaceResult = await this.workspaceUserService.readWorkspaceUserByLastLogin(user.id, queryRunner)
            const workspaceUsers = Array.isArray(workspaceResult) ? workspaceResult : [workspaceResult]
            if (workspaceUsers.length !== 1 || !workspaceUsers[0] || workspaceUsers[0].status !== WorkspaceUserStatus.ACTIVE) {
                throw new AcceptanceLoginRejectedError()
            }
            const workspaceUser = workspaceUsers[0] as WorkspaceUser

            const { organizationUser } = await this.organizationUserService.readOrganizationUserByWorkspaceIdUserId(
                workspaceUser.workspaceId,
                user.id,
                queryRunner
            )
            if (!organizationUser || organizationUser.status !== OrganizationUserStatus.ACTIVE) {
                throw new AcceptanceLoginRejectedError()
            }

            const result = await queryRunner.manager
                .createQueryBuilder()
                .update(User)
                .set({ tempToken: null, tokenExpiry: null })
                .where({
                    id: user.id,
                    email: user.email,
                    tempToken: storedHash,
                    tokenExpiry: MoreThan(now),
                    status: UserStatus.ACTIVE,
                    credential: IsNull()
                })
                .execute()
            if (result.affected !== 1) throw new AcceptanceLoginRejectedError()

            return await this.buildUser({
                user,
                workspaceUser,
                queryRunner,
                identityManager: this.identityManager,
                mode: 'acceptance-login'
            })
        } finally {
            await queryRunner.release()
        }
    }
}
