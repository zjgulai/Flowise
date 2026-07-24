import { Readable } from 'stream'

export async function readPasswordFromStdin(input: Readable = process.stdin): Promise<string> {
    if ((input as NodeJS.ReadStream).isTTY) {
        throw new Error('A new password must be provided through standard input')
    }

    const chunks: Buffer[] = []
    for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
    const password = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\r?\n$/, '')
    if (!password) throw new Error('A new password must be provided through standard input')
    return password
}
