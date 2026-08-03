import fs from 'fs'
import os from 'os'
import path from 'path'
import { getOrCreateStoredSecret } from '.'

describe('filesystem auth secret continuity', () => {
    let root: string
    const previousSecretPath = process.env.SECRETKEY_PATH
    const previousEnvSecret = process.env.FLOWISE_TEST_STORED_SECRET_UNSET

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flowise-secret-test-'))
        process.env.SECRETKEY_PATH = path.join(root, 'auth')
    })

    afterEach(async () => {
        if (previousSecretPath === undefined) delete process.env.SECRETKEY_PATH
        else process.env.SECRETKEY_PATH = previousSecretPath
        if (previousEnvSecret === undefined) delete process.env.FLOWISE_TEST_STORED_SECRET_UNSET
        else process.env.FLOWISE_TEST_STORED_SECRET_UNSET = previousEnvSecret
        await fs.promises.rm(root, { recursive: true, force: true })
    })

    const options = {
        envKey: 'FLOWISE_TEST_STORED_SECRET_UNSET',
        fileName: 'token-hash.key',
        awsSecretIdSuffix: 'TestTokenHash'
    }

    it('atomically creates one durable secret with private directory and file modes', async () => {
        const values = await Promise.all(Array.from({ length: 20 }, () => getOrCreateStoredSecret(options)))
        const filePath = path.join(process.env.SECRETKEY_PATH!, options.fileName)

        expect(new Set(values).size).toBe(1)
        expect(values[0]).toHaveLength(44)
        expect(await fs.promises.readFile(filePath, 'utf8')).toBe(values[0])
        expect((await fs.promises.stat(process.env.SECRETKEY_PATH!)).mode & 0o777).toBe(0o700)
        expect((await fs.promises.stat(filePath)).mode & 0o777).toBe(0o600)
    })

    it('preserves an existing value while hardening its file mode', async () => {
        await fs.promises.mkdir(process.env.SECRETKEY_PATH!, { recursive: true })
        const filePath = path.join(process.env.SECRETKEY_PATH!, options.fileName)
        await fs.promises.writeFile(filePath, 'existing-secret', { mode: 0o644 })

        await expect(getOrCreateStoredSecret(options)).resolves.toBe('existing-secret')
        expect((await fs.promises.stat(filePath)).mode & 0o777).toBe(0o600)
    })

    it('normalizes an environment value before rejecting a padded legacy default', async () => {
        process.env.FLOWISE_TEST_STORED_SECRET_UNSET = '  popcorn\n'

        const value = await getOrCreateStoredSecret({ ...options, weakDefault: 'popcorn' })

        expect(value).toHaveLength(44)
        expect(value).not.toBe('popcorn')
    })

    it('fails closed for path traversal, empty files, and non-regular secret paths', async () => {
        await expect(getOrCreateStoredSecret({ ...options, fileName: '../outside.key' })).rejects.toThrow('Invalid stored secret file name')
        await fs.promises.mkdir(process.env.SECRETKEY_PATH!, { recursive: true })
        const filePath = path.join(process.env.SECRETKEY_PATH!, options.fileName)
        await fs.promises.writeFile(filePath, '')
        await expect(getOrCreateStoredSecret(options)).rejects.toThrow('Stored secret is empty')
        await fs.promises.rm(filePath)
        await fs.promises.mkdir(filePath)
        await expect(getOrCreateStoredSecret(options)).rejects.toThrow('Stored secret path is not a regular file')

        await fs.promises.rm(process.env.SECRETKEY_PATH!, { recursive: true })
        const realDirectory = path.join(root, 'real-auth')
        await fs.promises.mkdir(realDirectory)
        await fs.promises.symlink(realDirectory, process.env.SECRETKEY_PATH!)
        await expect(getOrCreateStoredSecret(options)).rejects.toThrow('Stored secret directory is invalid')
    })
})
