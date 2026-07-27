import { StatusCodes } from 'http-status-codes'
import { DataSource, QueryRunner } from 'typeorm'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { generateId } from '../../utils'
import { GeneralErrorMessage } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { Telemetry } from '../../utils/telemetry'
import { Organization, OrganizationName } from '../database/entities/organization.entity'
import { isInvalidName, isInvalidUUID } from '../utils/validation.util'
import { UserErrorMessage, UserService } from './user.service'

export const enum OrganizationErrorMessage {
    INVALID_ORGANIZATION_ID = 'Invalid Organization Id',
    INVALID_ORGANIZATION_NAME = 'Invalid Organization Name',
    ORGANIZATION_NOT_FOUND = 'Organization Not Found',
    ORGANIZATION_FOUND_MULTIPLE = 'Organization Found Multiple',
    ORGANIZATION_RESERVERD_NAME = 'Organization name cannot be Default Organization - this is a reserved name',
    ORGANIZATION_HAS_NO_SUBSCRIPTION = 'Organization has no subscription'
}

export type PublicOrganizationCreateInput = Pick<Organization, 'name'>
export type PublicOrganizationUpdateInput = Pick<Organization, 'id' | 'name'>

type TrustedOrganizationProvisioningInput = Partial<Pick<Organization, 'name' | 'customerId' | 'subscriptionId' | 'createdBy'>>

export class OrganizationService {
    private telemetry: Telemetry
    private dataSource: DataSource
    private userService: UserService

    constructor() {
        const appServer = getRunningExpressApp()
        this.dataSource = appServer.AppDataSource
        this.telemetry = appServer.telemetry
        this.userService = new UserService()
    }

    public validateOrganizationId(id: string | undefined) {
        if (isInvalidUUID(id)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OrganizationErrorMessage.INVALID_ORGANIZATION_ID)
    }

    public async readOrganizationById(id: string | undefined, queryRunner: QueryRunner) {
        this.validateOrganizationId(id)
        return await queryRunner.manager.findOneBy(Organization, { id })
    }

    public validateOrganizationName(name: string | undefined, isRegister: boolean = false) {
        if (isInvalidName(name)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OrganizationErrorMessage.INVALID_ORGANIZATION_NAME)
        if (!isRegister && name === OrganizationName.DEFAULT_ORGANIZATION) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, OrganizationErrorMessage.ORGANIZATION_RESERVERD_NAME)
        }
    }

    public async readOrganizationByName(name: string | undefined, queryRunner: QueryRunner) {
        this.validateOrganizationName(name)
        return await queryRunner.manager.findOneBy(Organization, { name })
    }

    public async countOrganizations(queryRunner: QueryRunner) {
        return await queryRunner.manager.count(Organization)
    }

    public async readOrganization(queryRunner: QueryRunner) {
        return await queryRunner.manager.find(Organization)
    }

    private createOrganizationEntity(data: Partial<Organization>, queryRunner: QueryRunner, isRegister: boolean) {
        this.validateOrganizationName(data.name, isRegister)
        return queryRunner.manager.create(Organization, {
            ...data,
            id: generateId(),
            updatedBy: data.createdBy
        })
    }

    /**
     * Creates an organization from the public organization-management path.
     * Billing identifiers and caller-supplied primary/audit fields are deliberately
     * excluded before the entity reaches TypeORM.
     */
    public createNewOrganization(data: PublicOrganizationCreateInput & Pick<Organization, 'createdBy'>, queryRunner: QueryRunner) {
        return this.createOrganizationEntity(
            {
                name: data.name,
                createdBy: data.createdBy
            },
            queryRunner,
            false
        )
    }

    /** Trusted account-registration path for provider-issued billing identifiers. */
    public createNewOrganizationForRegistration(data: TrustedOrganizationProvisioningInput, queryRunner: QueryRunner) {
        return this.createOrganizationEntity(
            {
                name: data.name,
                customerId: data.customerId,
                subscriptionId: data.subscriptionId,
                createdBy: data.createdBy
            },
            queryRunner,
            true
        )
    }

    public async saveOrganization(data: Partial<Organization>, queryRunner: QueryRunner) {
        return await queryRunner.manager.save(Organization, data)
    }

    public async createOrganization(data: PublicOrganizationCreateInput, createdBy: string) {
        const queryRunner = this.dataSource.createQueryRunner()
        await queryRunner.connect()

        const user = await this.userService.readUserById(createdBy, queryRunner)
        if (!user) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)

        let newOrganization = this.createNewOrganization({ name: data.name, createdBy }, queryRunner)
        try {
            await queryRunner.startTransaction()
            newOrganization = await this.saveOrganization(newOrganization, queryRunner)
            await queryRunner.commitTransaction()
        } catch (error) {
            await queryRunner.rollbackTransaction()
            throw error
        } finally {
            await queryRunner.release()
        }

        return newOrganization
    }

    public async updateOrganization(data: PublicOrganizationUpdateInput, updatedBy: string, activeOrganizationId: string) {
        if (!data.id || data.id !== activeOrganizationId) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, GeneralErrorMessage.FORBIDDEN)
        }

        const queryRunner = this.dataSource.createQueryRunner()
        await queryRunner.connect()

        const oldOrganizationData = await this.readOrganizationById(data.id, queryRunner)
        if (!oldOrganizationData) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)
        const user = await this.userService.readUserById(updatedBy, queryRunner)
        if (!user) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)
        this.validateOrganizationName(data.name)

        const allowedUpdate: Partial<Organization> = {
            id: oldOrganizationData.id,
            name: data.name,
            createdBy: oldOrganizationData.createdBy,
            updatedBy
        }
        let updateOrganization = queryRunner.manager.merge(Organization, oldOrganizationData, allowedUpdate)
        try {
            await queryRunner.startTransaction()
            await this.saveOrganization(updateOrganization, queryRunner)
            await queryRunner.commitTransaction()
        } catch (error) {
            await queryRunner.rollbackTransaction()
            throw error
        } finally {
            await queryRunner.release()
        }

        return updateOrganization
    }
}
