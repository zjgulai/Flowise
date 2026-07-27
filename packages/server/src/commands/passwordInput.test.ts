import { Readable } from 'stream'
import { readPasswordFromStdin } from './passwordInput'

describe('readPasswordFromStdin', () => {
    it('reads a password without retaining the trailing line break', async () => {
        await expect(readPasswordFromStdin(Readable.from(['replacement-value\n']))).resolves.toBe('replacement-value')
    })

    it('rejects empty standard input', async () => {
        await expect(readPasswordFromStdin(Readable.from([]))).rejects.toThrow('must be provided through standard input')
    })
})
