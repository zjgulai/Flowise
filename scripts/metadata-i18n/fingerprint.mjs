import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const EXCLUDED_COMPONENT_DIRECTORIES = new Set(['coverage', 'dist', 'node_modules', '.turbo'])
const INCLUDED_SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.ts', '.tsx'])
const ROOT_BUILD_INPUTS = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']

const walkSourceFiles = (directory, root, files) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && EXCLUDED_COMPONENT_DIRECTORIES.has(entry.name)) continue
        const absolutePath = path.join(directory, entry.name)
        if (entry.isDirectory()) walkSourceFiles(absolutePath, root, files)
        else if (entry.isFile() && INCLUDED_SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
            files.push({ absolutePath, relativePath: path.relative(root, absolutePath) })
        }
    }
}

export const metadataBuildReceiptPath = (root) => path.join(root, 'packages/components/dist/.metadata-i18n-source.json')

export const componentSourceFingerprint = (root) => {
    const files = []
    walkSourceFiles(path.join(root, 'packages/components'), root, files)
    for (const relativePath of ROOT_BUILD_INPUTS) {
        const absolutePath = path.join(root, relativePath)
        if (!existsSync(absolutePath)) throw new Error(`Metadata build input is missing: ${relativePath}`)
        files.push({ absolutePath, relativePath })
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))

    const hash = createHash('sha256')
    for (const { absolutePath, relativePath } of files) {
        const content = readFileSync(absolutePath)
        hash.update(`${Buffer.byteLength(relativePath)}:${relativePath}:${content.byteLength}:`)
        hash.update(content)
    }
    return { algorithm: 'sha256', sourceSha256: hash.digest('hex'), fileCount: files.length }
}

export const assertCurrentComponentBuild = (root) => {
    const receiptPath = metadataBuildReceiptPath(root)
    if (!existsSync(receiptPath)) {
        throw new Error('Compiled component metadata receipt is missing; run pnpm --filter flowise-components build')
    }

    let receipt
    try {
        receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
    } catch {
        throw new Error('Compiled component metadata receipt is invalid; rebuild flowise-components')
    }
    const current = componentSourceFingerprint(root)
    if (
        receipt?.schemaVersion !== 1 ||
        receipt?.algorithm !== current.algorithm ||
        receipt?.sourceSha256 !== current.sourceSha256 ||
        receipt?.fileCount !== current.fileCount
    ) {
        throw new Error('Compiled component metadata is stale; rebuild flowise-components')
    }
    return current
}
