import { Args } from '@oclif/core'
import { QueryRunner } from 'typeorm'
import * as DataSource from '../DataSource'
import { User } from '../enterprise/database/entities/user.entity'
import { getHash } from '../enterprise/utils/encryption.util'
import { validatePasswordOrThrow } from '../enterprise/utils/validation.util'
import logger from '../utils/logger'
import { BaseCommand } from './base'
import { readPasswordFromStdin } from './passwordInput'

export async function resetUserPassword(queryRunner: QueryRunner, email: string, password: string): Promise<void> {
    const existingUser = await queryRunner.manager.findOne(User, {
        where: { email }
    })
    if (!existingUser) throw new Error(`User not found with email: ${email}`)

    validatePasswordOrThrow(password)

    // Keep the credential replacement and recovery-token invalidation atomic. We
    // intentionally do not initialize the HTTP session store from this CLI: the
    // credential-derived authVersion invalidates existing sessions on their next
    // authenticated request.
    const updateResult = await queryRunner.manager.update(
        User,
        { id: existingUser.id },
        {
            credential: getHash(password),
            tempToken: null,
            tokenExpiry: null,
            updatedBy: existingUser.id
        }
    )
    if (updateResult.affected !== 1) throw new Error(`Password reset failed for user: ${email}`)
}

export default class user extends BaseCommand {
    static args = {
        email: Args.string({
            description: 'Email address to search for in the user database'
        })
    }

    async run(): Promise<void> {
        const { args } = await this.parse(user)

        let queryRunner: QueryRunner | undefined
        try {
            logger.info('Initializing DataSource')
            const dataSource = await DataSource.getDataSource()
            await dataSource.initialize()

            queryRunner = dataSource.createQueryRunner()
            await queryRunner.connect()

            if (args.email) {
                logger.info('Running resetPassword')
                const password = await readPasswordFromStdin()
                await this.resetPassword(queryRunner, args.email, password)
            } else {
                logger.info('Running listUserEmails')
                await this.listUserEmails(queryRunner)
            }
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }
        await this.gracefullyExit()
    }

    async listUserEmails(queryRunner: QueryRunner) {
        logger.info('Listing all user emails')
        const users = await queryRunner.manager.find(User, {
            select: ['email']
        })

        const emails = users.map((user) => user.email)
        logger.info(`Email addresses: ${emails.join(', ')}`)
        logger.info(`Email count: ${emails.length}`)
        logger.info('To reset a user password, pass the email as the only argument and provide the new password through standard input.')
    }

    async resetPassword(queryRunner: QueryRunner, email: string, password: string) {
        logger.info(`Finding user by email: ${email}`)
        await resetUserPassword(queryRunner, email, password)
        logger.info(`Password reset for user: ${email}`)
    }
}
