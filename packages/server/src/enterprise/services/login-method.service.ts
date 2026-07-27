import { DataSource, QueryRunner } from 'typeorm'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { isInvalidName, isInvalidUUID } from '../utils/validation.util'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import { LoginMethod, LoginMethodStatus } from '../database/entities/login-method.entity'
import { isSupportedSSOProvider } from '../sso/supportedProviders'
import { decrypt, encrypt } from '../utils/encryption.util'
import { UserErrorMessage, UserService } from './user.service'
import { OrganizationErrorMessage, OrganizationService } from './organization.service'
import { IsNull } from 'typeorm'

export const enum LoginMethodErrorMessage {
    INVALID_LOGIN_METHOD_ID = 'Invalid Login Method Id',
    INVALID_LOGIN_METHOD_NAME = 'Invalid Login Method Name',
    INVALID_LOGIN_METHOD_STATUS = 'Invalid Login Method Status',
    INVALID_LOGIN_METHOD_CONFIG = 'Invalid Login Method Config',
    LOGIN_METHOD_NOT_FOUND = 'Login Method Not Found'
}

export class LoginMethodService {
    private dataSource: DataSource
    private userService: UserService
    private organizationService: OrganizationService

    constructor() {
        const appServer = getRunningExpressApp()
        this.dataSource = appServer.AppDataSource
        this.userService = new UserService()
        this.organizationService = new OrganizationService()
    }

    public validateLoginMethodId(id: string | undefined) {
        if (isInvalidUUID(id)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_ID)
    }

    public async readLoginMethodById(id: string | undefined, queryRunner: QueryRunner) {
        this.validateLoginMethodId(id)
        return await queryRunner.manager.findOneBy(LoginMethod, { id })
    }

    public validateLoginMethodName(name: string | undefined) {
        if (isInvalidName(name) || !isSupportedSSOProvider(name)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_NAME)
        }
    }

    public validateLoginMethodStatus(status: string | undefined) {
        if (status && !Object.values(LoginMethodStatus).includes(status as LoginMethodStatus))
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_STATUS)
    }

    public async readLoginMethodByOrganizationId(organizationId: string | undefined, queryRunner: QueryRunner) {
        if (organizationId) {
            const organization = await this.organizationService.readOrganizationById(organizationId, queryRunner)
            if (!organization) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)
            return await queryRunner.manager.findBy(LoginMethod, { organizationId })
        } else {
            return await queryRunner.manager.findBy(LoginMethod, { organizationId: IsNull() })
        }
    }

    public async encryptLoginMethodConfig(config: string | undefined) {
        if (!config) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_STATUS)
        return await encrypt(config)
    }

    public async decryptLoginMethodConfig(config: string | undefined) {
        if (!config) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_STATUS)
        return await decrypt(config)
    }

    private async saveLoginMethod(data: Partial<LoginMethod>, queryRunner: QueryRunner) {
        return await queryRunner.manager.save(LoginMethod, data)
    }

    private isPlaceholderSecret(value: unknown): boolean {
        return !value || (typeof value === 'string' && /^\*+$/.test(value))
    }

    private mergeWithStoredClientSecret(incoming: Record<string, unknown>, existing: Record<string, unknown>): Record<string, unknown> {
        const sent = incoming.clientSecret
        if (this.isPlaceholderSecret(sent) && existing.clientSecret) {
            return { ...incoming, clientSecret: existing.clientSecret }
        }
        return { ...incoming }
    }

    /**
     * Returns config with clientSecret filled from stored config when the incoming value is a placeholder (empty or asterisks).
     * Used for both testing and saving so logic stays in one place.
     */
    public async getConfigWithSecrets(
        organizationId: string,
        providerName: string,
        incomingConfig: Record<string, unknown>,
        queryRunner: QueryRunner
    ): Promise<Record<string, unknown>> {
        const methods = await this.readLoginMethodByOrganizationId(organizationId, queryRunner)
        const existingProvider = methods?.find((m) => m.name === providerName)
        if (!existingProvider?.config) return { ...incomingConfig }
        const existing = JSON.parse(await this.decryptLoginMethodConfig(existingProvider.config)) as Record<string, unknown>
        return this.mergeWithStoredClientSecret(incomingConfig, existing)
    }

    public async createLoginMethod(data: Partial<LoginMethod>) {
        this.validateLoginMethodName(data.name)
        this.validateLoginMethodStatus(data.status)

        let queryRunner: QueryRunner | undefined
        let newLoginMethod: Partial<LoginMethod> | undefined
        try {
            queryRunner = this.dataSource.createQueryRunner()
            await queryRunner.connect()
            const createdBy = await this.userService.readUserById(data.createdBy, queryRunner)
            if (!createdBy) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)
            const organization = await this.organizationService.readOrganizationById(data.organizationId, queryRunner)
            if (!organization) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)
            const loginMethodData: Partial<LoginMethod> = {
                organizationId: organization.id,
                name: data.name,
                config: await this.encryptLoginMethodConfig(data.config),
                status: data.status,
                createdBy: createdBy.id,
                updatedBy: createdBy.id
            }

            newLoginMethod = queryRunner.manager.create(LoginMethod, loginMethodData)
            await queryRunner.startTransaction()
            newLoginMethod = await this.saveLoginMethod(newLoginMethod, queryRunner)
            await queryRunner.commitTransaction()
        } catch (error) {
            if (queryRunner?.isTransactionActive) await queryRunner.rollbackTransaction()
            throw error
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }

        return newLoginMethod as LoginMethod
    }

    public async createOrUpdateConfig(body: any) {
        const organizationId: string = body.organizationId
        const providers: any[] = body.providers
        const userId: string = body.userId

        if (!Array.isArray(providers)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_CONFIG)
        }
        for (const provider of providers) {
            if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, LoginMethodErrorMessage.INVALID_LOGIN_METHOD_CONFIG)
            }
            this.validateLoginMethodName(provider.providerName)
            this.validateLoginMethodStatus(provider.status)
        }

        let queryRunner
        try {
            queryRunner = this.dataSource.createQueryRunner()
            await queryRunner.connect()
            await queryRunner.startTransaction()
            const createdOrUpdatedByUser = await this.userService.readUserById(userId, queryRunner)
            if (!createdOrUpdatedByUser) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)
            const organization = await this.organizationService.readOrganizationById(organizationId, queryRunner)
            if (!organization) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)

            for (const provider of providers) {
                const name = provider.providerName
                const loginMethod = await queryRunner.manager.findOneBy(LoginMethod, { organizationId, name })
                let configToSave: Record<string, unknown>
                if (loginMethod) {
                    const existing = JSON.parse(await this.decryptLoginMethodConfig(loginMethod.config)) as Record<string, unknown>
                    configToSave = this.mergeWithStoredClientSecret(provider.config, existing)
                    loginMethod.status = provider.status
                    loginMethod.config = await this.encryptLoginMethodConfig(JSON.stringify(configToSave))
                    loginMethod.updatedBy = userId
                    await this.saveLoginMethod(loginMethod, queryRunner)
                } else {
                    configToSave = { ...provider.config }
                    const encryptedConfig = await this.encryptLoginMethodConfig(JSON.stringify(configToSave))
                    let newLoginMethod = queryRunner.manager.create(LoginMethod, {
                        organizationId,
                        name,
                        status: provider.status,
                        config: encryptedConfig,
                        createdBy: userId,
                        updatedBy: userId
                    })
                    await this.saveLoginMethod(newLoginMethod, queryRunner)
                }
            }
            await queryRunner.commitTransaction()
        } catch (error) {
            if (queryRunner) await queryRunner.rollbackTransaction()
            throw error
        } finally {
            if (queryRunner) await queryRunner.release()
        }
        return { status: 'OK', organizationId: organizationId }
    }

    public async updateLoginMethod(newLoginMethod: Partial<LoginMethod>) {
        if (newLoginMethod.name) this.validateLoginMethodName(newLoginMethod.name)
        if (newLoginMethod.status) this.validateLoginMethodStatus(newLoginMethod.status)

        const queryRunner = this.dataSource.createQueryRunner()
        await queryRunner.connect()

        const oldLoginMethod = await this.readLoginMethodById(newLoginMethod.id, queryRunner)
        if (!oldLoginMethod) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, LoginMethodErrorMessage.LOGIN_METHOD_NOT_FOUND)
        const updatedBy = await this.userService.readUserById(newLoginMethod.updatedBy, queryRunner)
        if (!updatedBy) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)
        if (newLoginMethod.organizationId) {
            const organization = await this.organizationService.readOrganizationById(newLoginMethod.organizationId, queryRunner)
            if (!organization) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)
        }
        if (newLoginMethod.config) newLoginMethod.config = await this.encryptLoginMethodConfig(newLoginMethod.config)
        newLoginMethod.createdBy = oldLoginMethod.createdBy

        let updateLoginMethod = queryRunner.manager.merge(LoginMethod, newLoginMethod)
        try {
            await queryRunner.startTransaction()
            updateLoginMethod = await this.saveLoginMethod(updateLoginMethod, queryRunner)
            await queryRunner.commitTransaction()
        } catch (error) {
            await queryRunner.rollbackTransaction()
            throw error
        } finally {
            await queryRunner.release()
        }

        return updateLoginMethod
    }
}
