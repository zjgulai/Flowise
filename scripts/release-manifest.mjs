import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
    closeSync,
    constants,
    createReadStream,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGunzip, createZstdDecompress } from 'node:zlib'

const EXPECTED_TOOLCHAIN = Object.freeze({ node: 'v24.18.0', pnpm: '10.26.0', package_manager: 'pnpm@10.26.0' })
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const REVISION_PATTERN = /^[0-9a-f]{40}$/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const REPOSITORY_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/
const REGISTRY_HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const INPUT_FILES = Object.freeze([
    '.npmrc',
    '.nvmrc',
    'Dockerfile',
    'docker-compose.prod.yml',
    'docker/apk-build.lock',
    'docker/apk-runtime.lock',
    'docker/seccomp/chromium.json',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/deployment-bundle.mjs',
    'scripts/flowise-production-release.py',
    'scripts/publish-verified-image.sh',
    'scripts/release-manifest.mjs',
    'scripts/verify-chromium-sandbox.sh',
    'scripts/verify-release-candidate.sh',
    'scripts/verify-release-source.sh',
    'scripts/verify-security.sh'
])
const BOUNDARIES = Object.freeze({
    production_unchanged: true,
    production_write: false,
    provider_call: false,
    registry_push: false,
    secrets_read: false
})
const MAX_DOCKER_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
const MAX_DOCKER_ARCHIVE_MEMBERS = 256
const MAX_DOCKER_ARCHIVE_LAYERS = 128
const MAX_DOCKER_MEMBER_BYTES = 4 * 1024 * 1024 * 1024
const MAX_DOCKER_TOTAL_MEMBER_BYTES = 16 * 1024 * 1024 * 1024
const MAX_DOCKER_METADATA_BYTES = 16 * 1024 * 1024
const MAX_DOCKER_TOTAL_METADATA_BYTES = 64 * 1024 * 1024
const MAX_DOCKER_LAYER_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024
const MAX_DOCKER_TOTAL_UNCOMPRESSED_MEMBER_BYTES = 16 * 1024 * 1024 * 1024
const MAX_DOCKER_END_ZERO_BLOCKS = 20
const MAX_DOCKER_TAR_STREAM_BYTES = MAX_DOCKER_TOTAL_MEMBER_BYTES + MAX_DOCKER_ARCHIVE_MEMBERS * 1024 + MAX_DOCKER_END_ZERO_BLOCKS * 512
const CLASSIC_DOCKER_LAYER_PATH_PATTERN = /^(?:([0-9a-f]{64})\/)?layer\.tar$/
const SHA256_BLOB_PATH_PATTERN = /^blobs\/sha256\/([0-9a-f]{64})$/

const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`

const sortCanonical = (value) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('Unsupported canonical JSON value')
        return value
    }
    if (Array.isArray(value)) return value.map((entry) => sortCanonical(entry))
    if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error('Unsupported canonical JSON value')
    }

    const sorted = {}
    for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) throw new Error('Unsupported canonical JSON value')
        sorted[key] = sortCanonical(value[key])
    }
    return sorted
}

export const canonicalStringify = (value) => `${JSON.stringify(sortCanonical(value))}\n`

export const validateRevision = (revision) => {
    if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
        throw new Error('Expected a 40-character lowercase Git revision')
    }
    return revision
}

const validateDigest = (digest, label) => {
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) throw new Error(`Invalid ${label} digest`)
    return digest
}

const digestHex = (digest) => digest.slice('sha256:'.length)

const validateImageRepository = (repository) => {
    if (repository.length === 0 || repository.length > 255 || repository.startsWith('/') || repository.endsWith('/')) {
        throw new Error('Expected an immutable Git-derived tag')
    }

    const components = repository.split('/')
    if (components.some((component) => component.length === 0)) throw new Error('Expected an immutable Git-derived tag')

    if (components[0].includes(':')) {
        if (components.length < 2 || components[0].indexOf(':') !== components[0].lastIndexOf(':')) {
            throw new Error('Expected an immutable Git-derived tag')
        }
        const [host, port] = components.shift().split(':')
        const hostIsValid =
            host === 'localhost' || (host.includes('.') && host.split('.').every((label) => REGISTRY_HOST_LABEL_PATTERN.test(label)))
        if (!hostIsValid || !/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
            throw new Error('Expected an immutable Git-derived tag')
        }
    }

    if (components.some((component) => !REPOSITORY_COMPONENT_PATTERN.test(component))) {
        throw new Error('Expected an immutable Git-derived tag')
    }
}

export const validateImageTag = (imageTag, releaseId) => {
    if (typeof imageTag !== 'string' || typeof releaseId !== 'string' || imageTag.includes('@') || /\s/.test(imageTag)) {
        throw new Error('Expected an immutable Git-derived tag')
    }
    const lastSlash = imageTag.lastIndexOf('/')
    const lastColon = imageTag.lastIndexOf(':')
    if (lastColon <= lastSlash || imageTag.slice(lastColon + 1) !== releaseId || imageTag.slice(0, lastColon).length === 0) {
        throw new Error('Expected an immutable Git-derived tag')
    }
    validateImageRepository(imageTag.slice(0, lastColon))
    if (releaseId === 'latest' || !/^(?:git-[0-9a-f]{40}|dirty-[0-9a-f]{12}-[0-9a-f]{12})$/.test(releaseId)) {
        throw new Error('Expected an immutable Git-derived tag')
    }
    return imageTag
}

export const sanitizeRepositoryUrl = (rawValue) => {
    if (typeof rawValue !== 'string' || rawValue.length === 0 || /[\r\n\0]/.test(rawValue)) {
        throw new Error('Unsupported repository URL')
    }

    let candidate = rawValue
    if (!candidate.includes('://')) {
        const scpMatch = candidate.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
        if (!scpMatch) throw new Error('Unsupported repository URL')
        candidate = `ssh://${scpMatch[1]}/${scpMatch[2]}`
    }

    let parsed
    try {
        parsed = new URL(candidate)
    } catch {
        throw new Error('Unsupported repository URL')
    }
    if (!['https:', 'ssh:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
        throw new Error('Unsupported repository URL')
    }

    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/$/, '')
}

const isSecretLikePath = (relativePath) => {
    const components = relativePath.toLowerCase().split('/')
    return components.some((component, index) => {
        if (/\.(?:pem|key|keys|priv|rsa|p12|pfx)$/.test(component) || component.endsWith('.key.json')) return true
        if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)/.test(component)) return true
        if (component === '.env' || component.startsWith('.env.')) {
            const isAllowedTemplateFile =
                index === components.length - 1 && (component.endsWith('.example') || component.endsWith('.template'))
            return !isAllowedTemplateFile
        }
        return false
    })
}

const validateRelativePath = (relativePath) => {
    if (
        typeof relativePath !== 'string' ||
        relativePath.length === 0 ||
        relativePath.includes('\0') ||
        relativePath.includes('\\') ||
        isAbsolute(relativePath) ||
        normalize(relativePath) !== relativePath ||
        relativePath === '.' ||
        relativePath.split('/').includes('..') ||
        isSecretLikePath(relativePath)
    ) {
        throw new Error('Unsafe release input path')
    }
    return relativePath
}

const resolveRepoPath = (repoRoot, relativePath) => {
    validateRelativePath(relativePath)
    const root = resolve(repoRoot)
    const target = resolve(root, relativePath)
    const rel = relative(root, target)
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Unsafe release input path')
    return target
}

const assertRegularFile = (filePath, label) => {
    let stat
    try {
        stat = lstatSync(filePath)
    } catch {
        throw new Error(`${label} is unavailable`)
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`)
    return stat
}

const openRegularFileReadStream = (filePath, label) => {
    if (typeof constants.O_NOFOLLOW !== 'number') throw new Error(`${label} cannot be opened without following symlinks`)
    const absolutePath = resolve(filePath)
    let fileDescriptor
    try {
        fileDescriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch {
        throw new Error(`${label} must be a readable regular non-symlink file`)
    }

    try {
        const stat = fstatSync(fileDescriptor)
        if (!stat.isFile()) throw new Error(`${label} must be a readable regular non-symlink file`)
        return {
            stat,
            stream: createReadStream(absolutePath, { autoClose: true, fd: fileDescriptor })
        }
    } catch (error) {
        try {
            closeSync(fileDescriptor)
        } catch {
            // Preserve the validation/open error; the descriptor is best-effort closed here.
        }
        if (error instanceof Error && error.message.startsWith(label)) throw error
        throw new Error(`${label} must be a readable regular non-symlink file`)
    }
}

const assertDirectory = (directoryPath, label) => {
    let stat
    try {
        stat = lstatSync(directoryPath)
    } catch {
        throw new Error(`${label} is unavailable`)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`)
}

const hashRegularFile = (filePath, label) => {
    const stat = assertRegularFile(filePath, label)
    let contents
    try {
        contents = readFileSync(filePath)
    } catch {
        throw new Error(`${label} is unreadable`)
    }
    return { digest: sha256(contents), bytes: stat.size }
}

const readTextFile = (filePath, label) => {
    assertRegularFile(filePath, label)
    try {
        return readFileSync(filePath, 'utf8')
    } catch {
        throw new Error(`${label} is unreadable`)
    }
}

const parseArchiveJson = (contents, label) => {
    try {
        return JSON.parse(contents.toString('utf8'))
    } catch {
        throw new Error(`${label} is not valid JSON`)
    }
}

const decodeTarField = (field, label) => {
    const terminator = field.indexOf(0)
    const value = terminator === -1 ? field : field.subarray(0, terminator)
    const padding = terminator === -1 ? Buffer.alloc(0) : field.subarray(terminator)
    if (padding.some((byte) => byte !== 0)) throw new Error(`Docker archive ${label} field is invalid`)
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
        throw new Error(`Docker archive ${label} field is invalid`)
    }
}

const parseTarOctal = (field, label) => {
    if ((field[0] & 0x80) !== 0) throw new Error(`Docker archive ${label} field is invalid`)
    const value = field.toString('ascii').replace(/\0.*$/s, '').trim()
    if (value === '') return 0
    if (!/^[0-7]+$/.test(value)) throw new Error(`Docker archive ${label} field is invalid`)
    const parsed = Number.parseInt(value, 8)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Docker archive ${label} field is invalid`)
    return parsed
}

const validateArchiveMemberPath = (memberPath, type) => {
    const comparable = type === 'directory' && memberPath.endsWith('/') ? memberPath.slice(0, -1) : memberPath
    if (
        comparable.length === 0 ||
        comparable.length > 255 ||
        memberPath.includes('\\') ||
        memberPath.startsWith('/') ||
        memberPath.startsWith('./') ||
        memberPath.includes('//') ||
        /[\0-\x1f\x7f]/.test(memberPath) ||
        !/^[A-Za-z0-9._/-]+$/.test(memberPath) ||
        comparable.split('/').some((component) => component === '' || component === '.' || component === '..')
    ) {
        throw new Error('Docker archive member path is unsafe')
    }
    if ((type === 'directory') !== memberPath.endsWith('/')) {
        throw new Error('Docker archive member path/type mismatch')
    }
    return memberPath
}

const parseTarHeader = (header) => {
    if (header.length !== 512) throw new Error('Docker archive header is truncated')
    const checksum = parseTarOctal(header.subarray(148, 156), 'checksum')
    const checksumInput = Buffer.from(header)
    checksumInput.fill(0x20, 148, 156)
    if (checksumInput.reduce((sum, byte) => sum + byte, 0) !== checksum) {
        throw new Error('Docker archive header checksum mismatch')
    }
    if (header.subarray(257, 265).toString('binary') !== 'ustar\x0000') {
        throw new Error('Docker archive must use the bounded ustar format')
    }

    const name = decodeTarField(header.subarray(0, 100), 'name')
    const prefix = decodeTarField(header.subarray(345, 500), 'prefix')
    const memberPath = prefix ? `${prefix}/${name}` : name
    const typeFlag = header[156]
    const type = typeFlag === 0 || typeFlag === 0x30 ? 'file' : typeFlag === 0x35 ? 'directory' : null
    if (!type) throw new Error('Docker archive contains a link, device, FIFO, sparse or unsupported member')
    const size = parseTarOctal(header.subarray(124, 136), 'size')
    if (type === 'directory' && size !== 0) throw new Error('Docker archive directory member has content')
    validateArchiveMemberPath(memberPath, type)
    return { path: memberPath, size, type }
}

class DockerUncompressedBudget {
    constructor(maxBytes) {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DOCKER_TOTAL_UNCOMPRESSED_MEMBER_BYTES) {
            throw new Error('Docker archive total uncompressed byte limit is invalid')
        }
        this.maxBytes = maxBytes
        this.consumedBytes = 0
    }

    consume(bytes) {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.consumedBytes > this.maxBytes - bytes) {
            throw new Error('Docker archive members exceed the total uncompressed size limit')
        }
        this.consumedBytes += bytes
    }
}

class DockerMemberHasher {
    constructor(uncompressedBudget, allowCompression) {
        this.rawHash = createHash('sha256')
        this.payloadHash = createHash('sha256')
        this.uncompressedBudget = uncompressedBudget
        this.allowCompression = allowCompression
        this.prefix = []
        this.prefixBytes = 0
        this.compression = null
        this.decoder = null
        this.decoderDone = null
        this.decoderError = null
        this.payloadBytes = 0
    }

    startDecoder(compression) {
        this.compression = compression
        if (compression === 'none') return
        this.decoder = compression === 'gzip' ? createGunzip() : createZstdDecompress()
        this.decoderDone = new Promise((resolveDone) => {
            this.decoder.on('data', (chunk) => {
                try {
                    if (this.payloadBytes > MAX_DOCKER_LAYER_UNCOMPRESSED_BYTES - chunk.length) {
                        throw new Error('Docker archive member expands beyond the uncompressed size limit')
                    }
                    this.uncompressedBudget.consume(chunk.length)
                } catch (error) {
                    this.decoder.destroy(error)
                    return
                }
                this.payloadBytes += chunk.length
                this.payloadHash.update(chunk)
            })
            this.decoder.once('error', (error) => {
                this.decoderError = error
                resolveDone()
            })
            this.decoder.once('end', resolveDone)
        })
    }

    async feedPayload(chunk) {
        if (this.compression === 'none') {
            if (this.payloadBytes > MAX_DOCKER_LAYER_UNCOMPRESSED_BYTES - chunk.length) {
                throw new Error('Docker archive member exceeds the uncompressed size limit')
            }
            this.uncompressedBudget.consume(chunk.length)
            this.payloadBytes += chunk.length
            this.payloadHash.update(chunk)
            return
        }
        await new Promise((resolveWrite, rejectWrite) => {
            this.decoder.write(chunk, (error) => (error ? rejectWrite(error) : resolveWrite()))
        })
    }

    async selectCompression() {
        if (this.compression !== null) return
        const prefix = Buffer.concat(this.prefix, this.prefixBytes)
        const compression =
            prefix.length >= 2 && prefix[0] === 0x1f && prefix[1] === 0x8b
                ? 'gzip'
                : prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
                ? 'zstd'
                : 'none'
        if (!this.allowCompression && compression !== 'none') {
            throw new Error('Docker archive classic layer.tar must not be compressed')
        }
        this.startDecoder(compression)
        this.prefix = []
        this.prefixBytes = 0
        if (prefix.length > 0) await this.feedPayload(prefix)
    }

    async write(chunk) {
        this.rawHash.update(chunk)
        if (this.compression === null) {
            this.prefix.push(chunk)
            this.prefixBytes += chunk.length
            if (this.prefixBytes < 4) return
            await this.selectCompression()
            return
        }
        await this.feedPayload(chunk)
    }

    async finish() {
        await this.selectCompression()
        if (this.decoder) {
            this.decoder.end()
            await this.decoderDone
            if (this.decoderError) {
                if (this.decoderError.message.startsWith('Docker archive')) throw this.decoderError
                throw new Error('Docker archive compressed member is invalid')
            }
        }
        return {
            compression: this.compression,
            payloadBytes: this.payloadBytes,
            payloadDigest: `sha256:${this.payloadHash.digest('hex')}`,
            rawDigest: `sha256:${this.rawHash.digest('hex')}`
        }
    }
}

const isDockerMetadataCandidate = (memberPath) =>
    ['manifest.json', 'index.json', 'oci-layout', 'repositories'].includes(memberPath) ||
    /^[0-9a-f]{64}\.json$/.test(memberPath) ||
    /^[0-9a-f]{64}\/(?:json|VERSION)$/.test(memberPath) ||
    SHA256_BLOB_PATH_PATTERN.test(memberPath)

const readDockerArchive = async (archivePath, maxTotalUncompressedBytes) => {
    const uncompressedBudget = new DockerUncompressedBudget(maxTotalUncompressedBytes ?? MAX_DOCKER_TOTAL_UNCOMPRESSED_MEMBER_BYTES)
    const { stat, stream: archiveStream } = openRegularFileReadStream(archivePath, 'Docker archive')
    if (stat.size <= 0 || stat.size > MAX_DOCKER_ARCHIVE_BYTES) {
        archiveStream.destroy()
        throw new Error('Docker archive size is outside the allowed range')
    }

    const uncompressedStream = createGunzip()
    archiveStream.on('error', (error) => uncompressedStream.destroy(error))
    archiveStream.pipe(uncompressedStream)

    const members = []
    const seenPaths = new Set()
    let pending = Buffer.alloc(0)
    let current = null
    let paddingBytes = 0
    let totalMemberBytes = 0
    let retainedMetadataBytes = 0
    let zeroBlocks = 0
    let reachedEnd = false
    let totalTarStreamBytes = 0

    const finishCurrent = async () => {
        const hashes = await current.hasher.finish()
        let content = current.content ? Buffer.concat(current.content, current.header.size) : null
        if (
            content &&
            current.header.path.startsWith('blobs/sha256/') &&
            (hashes.compression !== 'none' || !/^\s*(?:\{|\[)/.test(content.subarray(0, 64).toString('utf8')))
        ) {
            retainedMetadataBytes -= current.header.size
            content = null
        }
        members.push({
            ...current.header,
            ...hashes,
            content
        })
        paddingBytes = (512 - (current.header.size % 512)) % 512
        current = null
    }

    try {
        for await (const streamChunk of uncompressedStream) {
            totalTarStreamBytes += streamChunk.length
            if (totalTarStreamBytes > MAX_DOCKER_TAR_STREAM_BYTES) {
                throw new Error('Docker archive uncompressed tar stream exceeds the size limit')
            }
            pending = pending.length === 0 ? streamChunk : Buffer.concat([pending, streamChunk])
            while (pending.length > 0) {
                if (current) {
                    const take = Math.min(current.remaining, pending.length)
                    const payload = pending.subarray(0, take)
                    pending = pending.subarray(take)
                    current.remaining -= take
                    if (current.content) current.content.push(Buffer.from(payload))
                    await current.hasher.write(payload)
                    if (current.remaining === 0) await finishCurrent()
                    continue
                }
                if (paddingBytes > 0) {
                    const take = Math.min(paddingBytes, pending.length)
                    if (pending.subarray(0, take).some((byte) => byte !== 0)) {
                        throw new Error('Docker archive member padding is invalid')
                    }
                    pending = pending.subarray(take)
                    paddingBytes -= take
                    continue
                }
                if (pending.length < 512) break
                const headerBlock = pending.subarray(0, 512)
                pending = pending.subarray(512)
                if (headerBlock.every((byte) => byte === 0)) {
                    zeroBlocks += 1
                    if (zeroBlocks > MAX_DOCKER_END_ZERO_BLOCKS) {
                        throw new Error('Docker archive contains excessive data after the end marker')
                    }
                    if (zeroBlocks >= 2) reachedEnd = true
                    continue
                }
                if (zeroBlocks > 0 || reachedEnd) throw new Error('Docker archive contains data after the end marker')

                const header = parseTarHeader(headerBlock)
                if (seenPaths.has(header.path)) throw new Error('Docker archive contains duplicate members')
                seenPaths.add(header.path)
                if (seenPaths.size > MAX_DOCKER_ARCHIVE_MEMBERS) throw new Error('Docker archive contains too many members')
                if (header.size > MAX_DOCKER_MEMBER_BYTES) throw new Error('Docker archive member exceeds the size limit')
                totalMemberBytes += header.size
                if (totalMemberBytes > MAX_DOCKER_TOTAL_MEMBER_BYTES) throw new Error('Docker archive members exceed the total size limit')

                if (header.type === 'directory') {
                    members.push({ ...header, content: Buffer.alloc(0), compression: 'none', payloadBytes: 0 })
                    continue
                }
                current = {
                    content:
                        isDockerMetadataCandidate(header.path) &&
                        header.size <= MAX_DOCKER_METADATA_BYTES &&
                        retainedMetadataBytes + header.size <= MAX_DOCKER_TOTAL_METADATA_BYTES
                            ? []
                            : null,
                    hasher: new DockerMemberHasher(uncompressedBudget, !CLASSIC_DOCKER_LAYER_PATH_PATTERN.test(header.path)),
                    header,
                    remaining: header.size
                }
                if (current.content) retainedMetadataBytes += header.size
                if (current.remaining === 0) await finishCurrent()
            }
        }
    } catch (error) {
        archiveStream.destroy()
        uncompressedStream.destroy()
        if (error instanceof Error && error.message.startsWith('Docker archive')) throw error
        throw new Error('Docker archive is not a readable gzip-compressed tar file')
    }

    if (current || paddingBytes !== 0 || pending.length !== 0 || !reachedEnd || members.length === 0) {
        throw new Error('Docker archive is truncated or missing its end marker')
    }
    return members
}

const requireArchiveFile = (membersByPath, memberPath, label, requireContent = true) => {
    const member = membersByPath.get(memberPath)
    if (!member || member.type !== 'file') throw new Error(`Docker archive ${label} is unavailable`)
    if (requireContent && !member.content) throw new Error(`Docker archive ${label} exceeds the metadata size limit`)
    return member
}

const archiveParentDirectories = (memberPath) => {
    const components = memberPath.split('/')
    const directories = []
    for (let index = 1; index < components.length; index += 1) {
        directories.push(`${components.slice(0, index).join('/')}/`)
    }
    return directories
}

const validateExactArchiveMembers = (
    members,
    expectedFiles,
    allowedDirectories,
    { allowUnreferencedContentAddressedBlobs = false } = {}
) => {
    for (const member of members) {
        const allowed = member.type === 'file' ? expectedFiles.has(member.path) : allowedDirectories.has(member.path)
        if (allowed) continue
        if (allowUnreferencedContentAddressedBlobs && member.type === 'file') {
            const blobMatch = SHA256_BLOB_PATH_PATTERN.exec(member.path)
            if (blobMatch) {
                if (member.rawDigest !== `sha256:${blobMatch[1]}`) {
                    throw new Error(`Docker archive unreferenced blob digest mismatch: ${member.path}`)
                }
                continue
            }
        }
        throw new Error(`Docker archive contains an unexpected member: ${member.path}`)
    }
    for (const expectedFile of expectedFiles) {
        if (members.filter((member) => member.path === expectedFile && member.type === 'file').length !== 1) {
            throw new Error(`Docker archive expected member is unavailable: ${expectedFile}`)
        }
    }
}

const validateLegacyRepositories = ({ membersByPath, entry, layerMembers }) => {
    const repositoriesMember = membersByPath.get('repositories')
    if (!repositoriesMember) return false
    if (repositoriesMember.type !== 'file' || repositoriesMember.compression !== 'none' || !repositoriesMember.content) {
        throw new Error('Docker archive legacy repositories metadata is unavailable')
    }

    const repositories = parseArchiveJson(repositoriesMember.content, 'Docker archive legacy repositories metadata')
    const imageTag = entry.RepoTags[0]
    const tagSeparator = imageTag.lastIndexOf(':')
    const repositoryName = imageTag.slice(0, tagSeparator)
    const tagName = imageTag.slice(tagSeparator + 1)
    const repositoryNames =
        repositories && typeof repositories === 'object' && !Array.isArray(repositories) ? Object.keys(repositories) : []
    const tags = repositoryNames.length === 1 && repositoryNames[0] === repositoryName ? repositories[repositoryName] : null
    const tagNames = tags && typeof tags === 'object' && !Array.isArray(tags) ? Object.keys(tags) : []
    const expectedTopDiffId = digestHex(layerMembers.at(-1).payloadDigest)

    if (
        repositoryNames.length !== 1 ||
        repositoryNames[0] !== repositoryName ||
        tagNames.length !== 1 ||
        tagNames[0] !== tagName ||
        tags[tagName] !== expectedTopDiffId
    ) {
        throw new Error('Docker archive legacy repositories metadata mismatch')
    }
    return true
}

const validateContainerdLayout = ({ members, membersByPath, entry, configPath, layerMembers }) => {
    const indexMember = requireArchiveFile(membersByPath, 'index.json', 'OCI index')
    const layoutMember = requireArchiveFile(membersByPath, 'oci-layout', 'OCI layout')
    const index = parseArchiveJson(indexMember.content, 'Docker archive OCI index')
    const layout = parseArchiveJson(layoutMember.content, 'Docker archive OCI layout')
    if (
        !layout ||
        typeof layout !== 'object' ||
        Array.isArray(layout) ||
        Object.keys(layout).length !== 1 ||
        layout.imageLayoutVersion !== '1.0.0'
    ) {
        throw new Error('Docker archive OCI layout is invalid')
    }
    if (!index || index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1) {
        throw new Error('Docker archive OCI index is invalid')
    }
    const descriptor = index.manifests[0]
    validateDigest(descriptor?.digest, 'Docker archive OCI manifest')
    if (!Number.isSafeInteger(descriptor.size) || descriptor.size < 0) throw new Error('Docker archive OCI manifest size is invalid')
    if (
        !['application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json'].includes(
            descriptor.mediaType
        )
    ) {
        throw new Error('Docker archive OCI manifest media type is invalid')
    }
    const descriptorPath = `blobs/sha256/${digestHex(descriptor.digest)}`
    const descriptorMember = requireArchiveFile(membersByPath, descriptorPath, 'OCI manifest blob')
    if (descriptorMember.rawDigest !== descriptor.digest || descriptorMember.size !== descriptor.size) {
        throw new Error('Docker archive OCI manifest digest or size mismatch')
    }
    const imageManifest = parseArchiveJson(descriptorMember.content, 'Docker archive OCI manifest blob')
    if (!imageManifest || imageManifest.schemaVersion !== 2 || !imageManifest.config || !Array.isArray(imageManifest.layers)) {
        throw new Error('Docker archive OCI manifest blob is invalid')
    }
    if (
        !['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'].includes(
            imageManifest.config.mediaType
        )
    ) {
        throw new Error('Docker archive OCI config media type is invalid')
    }
    if (
        imageManifest.config.digest !== `sha256:${configPath.slice('blobs/sha256/'.length)}` ||
        imageManifest.config.size !== membersByPath.get(configPath).size
    ) {
        throw new Error('Docker archive OCI config descriptor mismatch')
    }
    if (imageManifest.layers.length !== entry.Layers.length) throw new Error('Docker archive OCI layer descriptor count mismatch')

    const compressionByMediaType = new Map([
        ['application/vnd.docker.image.rootfs.diff.tar', 'none'],
        ['application/vnd.docker.image.rootfs.diff.tar.gzip', 'gzip'],
        ['application/vnd.oci.image.layer.v1.tar', 'none'],
        ['application/vnd.oci.image.layer.v1.tar+gzip', 'gzip'],
        ['application/vnd.oci.image.layer.v1.tar+zstd', 'zstd']
    ])
    for (const [indexValue, layerDescriptor] of imageManifest.layers.entries()) {
        const layerMember = layerMembers[indexValue]
        const expectedDigest = `sha256:${entry.Layers[indexValue].slice('blobs/sha256/'.length)}`
        if (
            layerDescriptor?.digest !== expectedDigest ||
            layerDescriptor.size !== layerMember.size ||
            layerMember.rawDigest !== expectedDigest
        ) {
            throw new Error('Docker archive OCI layer descriptor mismatch')
        }
        const expectedCompression = compressionByMediaType.get(layerDescriptor.mediaType)
        if (!expectedCompression || layerMember.compression !== expectedCompression) {
            throw new Error('Docker archive OCI layer compression mismatch')
        }
    }

    const expectedFiles = new Set(['manifest.json', 'index.json', 'oci-layout', descriptorPath, configPath, ...entry.Layers])
    if (validateLegacyRepositories({ membersByPath, entry, layerMembers })) expectedFiles.add('repositories')
    const allowedDirectories = new Set([...expectedFiles].flatMap((path) => archiveParentDirectories(path)))
    validateExactArchiveMembers(members, expectedFiles, allowedDirectories, {
        allowUnreferencedContentAddressedBlobs: true
    })
}

const validateClassicLayout = ({ members, membersByPath, entry, configPath, layerMembers }) => {
    const layerDirectories = new Set()
    for (const [indexValue, layerPath] of entry.Layers.entries()) {
        const match = CLASSIC_DOCKER_LAYER_PATH_PATTERN.exec(layerPath)
        if (!match) throw new Error('Docker archive classic layer path is invalid')
        if (layerMembers[indexValue].compression !== 'none') {
            throw new Error('Docker archive classic layer.tar must not be compressed')
        }
        if (match[1]) layerDirectories.add(match[1])
    }
    const optionalFiles = new Set(['repositories'])
    for (const directory of layerDirectories) {
        optionalFiles.add(`${directory}/json`)
        optionalFiles.add(`${directory}/VERSION`)
    }
    const expectedFiles = new Set(['manifest.json', configPath, ...entry.Layers])
    for (const member of members) {
        if (member.type === 'file' && optionalFiles.has(member.path)) expectedFiles.add(member.path)
    }
    const allowedDirectories = new Set([...expectedFiles].flatMap((path) => archiveParentDirectories(path)))
    validateExactArchiveMembers(members, expectedFiles, allowedDirectories)

    for (const optionalPath of expectedFiles) {
        if (!optionalFiles.has(optionalPath)) continue
        const optionalMember = requireArchiveFile(membersByPath, optionalPath, 'classic metadata')
        if (optionalPath.endsWith('/VERSION')) {
            if (optionalMember.content.toString('utf8').trim() !== '1.0') throw new Error('Docker archive classic VERSION is invalid')
        } else {
            const metadata = parseArchiveJson(optionalMember.content, 'Docker archive classic metadata')
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
                throw new Error('Docker archive classic metadata is invalid')
            }
        }
    }
}

export const verifyDockerArchive = async ({
    archivePath,
    imageTag,
    revision,
    source,
    version,
    created,
    platform,
    maxTotalUncompressedBytes
}) => {
    validateRevision(revision)
    if (version !== `git-${revision}`) throw new Error('Docker archive version must match the exact Git revision')
    validateImageTag(imageTag, version)
    if (sanitizeRepositoryUrl(source) !== source) throw new Error('Docker archive source must be normalized')
    if (typeof created !== 'string' || created.length > 128 || /[\r\n\0]/.test(created) || Number.isNaN(Date.parse(created))) {
        throw new Error('Docker archive creation time is invalid')
    }
    if (platform !== 'linux/amd64') throw new Error('Docker archive platform must be linux/amd64')

    const members = await readDockerArchive(archivePath, maxTotalUncompressedBytes)
    const membersByPath = new Map(members.map((member) => [member.path, member]))
    const manifestMember = requireArchiveFile(membersByPath, 'manifest.json', 'manifest')
    const archiveManifest = parseArchiveJson(manifestMember.content, 'Docker archive manifest')
    if (!Array.isArray(archiveManifest) || archiveManifest.length !== 1) {
        throw new Error('Docker archive must contain exactly one image')
    }

    const entry = archiveManifest[0]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Docker archive image entry is invalid')
    if (!Array.isArray(entry.RepoTags) || entry.RepoTags.length !== 1 || entry.RepoTags[0] !== imageTag) {
        throw new Error('Docker archive tag mismatch')
    }
    const configMatch = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/.exec(entry.Config)
    if (!configMatch) throw new Error('Docker archive config path is invalid')
    const configPath = entry.Config
    const configDigestHex = configMatch[1] ?? configMatch[2]
    const configMember = requireArchiveFile(membersByPath, configPath, 'image config')
    if (configMember.compression !== 'none') throw new Error('Docker archive image config must not be compressed')
    if (!Array.isArray(entry.Layers) || entry.Layers.length === 0 || entry.Layers.length > MAX_DOCKER_ARCHIVE_LAYERS) {
        throw new Error('Docker archive layer list is invalid')
    }
    if (new Set(entry.Layers).size !== entry.Layers.length) throw new Error('Docker archive layer list is invalid')
    const containerdLayout = configPath.startsWith('blobs/sha256/')
    const layerMembers = []
    for (const layerPath of entry.Layers) {
        validateArchiveMemberPath(layerPath, 'file')
        if (containerdLayout && !/^blobs\/sha256\/[0-9a-f]{64}$/.test(layerPath)) {
            throw new Error('Docker archive OCI layer path is invalid')
        }
        layerMembers.push(requireArchiveFile(membersByPath, layerPath, 'layer', false))
    }

    const configContents = configMember.content
    const actualConfigHex = digestHex(configMember.rawDigest)
    if (actualConfigHex !== configDigestHex) throw new Error('Docker archive config content hash mismatch')
    const imageConfig = parseArchiveJson(configContents, 'Docker archive image config')
    if (!imageConfig || typeof imageConfig !== 'object' || Array.isArray(imageConfig)) {
        throw new Error('Docker archive image config is invalid')
    }
    if (`${imageConfig.os}/${imageConfig.architecture}` !== platform) throw new Error('Docker archive platform mismatch')
    if (
        !imageConfig.rootfs ||
        typeof imageConfig.rootfs !== 'object' ||
        Array.isArray(imageConfig.rootfs) ||
        imageConfig.rootfs.type !== 'layers' ||
        !Array.isArray(imageConfig.rootfs.diff_ids) ||
        imageConfig.rootfs.diff_ids.length !== entry.Layers.length
    ) {
        throw new Error('Docker archive rootfs diff_ids are invalid')
    }
    for (const [indexValue, diffId] of imageConfig.rootfs.diff_ids.entries()) {
        validateDigest(diffId, 'Docker archive layer diff_id')
        if (layerMembers[indexValue].payloadDigest !== diffId) throw new Error('Docker archive layer diff_id mismatch')
    }

    if (containerdLayout) {
        validateContainerdLayout({ members, membersByPath, entry, configPath, layerMembers })
    } else {
        validateClassicLayout({ members, membersByPath, entry, configPath, layerMembers })
    }

    const runtime = imageConfig.config
    if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) throw new Error('Docker archive runtime config is invalid')
    if (runtime.User !== 'node') throw new Error('Docker archive runtime user mismatch')
    if (runtime.WorkingDir !== '/usr/src/flowise') throw new Error('Docker archive working directory mismatch')
    if (canonicalStringify(runtime.Cmd) !== canonicalStringify(['node', 'packages/server/bin/run', 'start'])) {
        throw new Error('Docker archive command mismatch')
    }
    const labels = runtime.Labels
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) throw new Error('Docker archive OCI labels are unavailable')
    const expectedLabels = {
        'org.opencontainers.image.source': source,
        'org.opencontainers.image.revision': revision,
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.created': created
    }
    for (const [key, expectedValue] of Object.entries(expectedLabels)) {
        if (labels[key] !== expectedValue) throw new Error(`Docker archive ${key.slice('org.opencontainers.image.'.length)} label mismatch`)
    }

    return {
        imageConfigDigest: `sha256:${actualConfigHex}`,
        imageTag,
        platform
    }
}

const runGit = (repoRoot, args, binary = false) => {
    try {
        return execFileSync('git', args, {
            cwd: repoRoot,
            encoding: binary ? null : 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch {
        throw new Error('Git command failed')
    }
}

const splitNul = (buffer) => {
    if (buffer.length === 0) return []
    return buffer.toString('utf8').split('\0').filter(Boolean).sort()
}

const normalizeToolchain = (toolchain) => {
    if (
        !toolchain ||
        toolchain.node !== EXPECTED_TOOLCHAIN.node ||
        toolchain.pnpm !== EXPECTED_TOOLCHAIN.pnpm ||
        toolchain.package_manager !== EXPECTED_TOOLCHAIN.package_manager
    ) {
        throw new Error('Release toolchain mismatch')
    }
    return { ...EXPECTED_TOOLCHAIN }
}

const validateRepositoryToolchain = (repoRoot) => {
    let packageManifest
    try {
        packageManifest = JSON.parse(readTextFile(resolveRepoPath(repoRoot, 'package.json'), 'package.json'))
    } catch (error) {
        if (error.message !== 'package.json is unreadable' && error.message !== 'package.json is unavailable') {
            throw new Error('package.json is invalid')
        }
        throw error
    }
    if (
        packageManifest.packageManager !== EXPECTED_TOOLCHAIN.package_manager ||
        packageManifest.engines?.node !== '24.18.0' ||
        packageManifest.engines?.pnpm !== '10.26.0'
    ) {
        throw new Error('Repository toolchain mismatch')
    }
    if (readTextFile(resolveRepoPath(repoRoot, '.nvmrc'), '.nvmrc').trim() !== 'v24.18.0') {
        throw new Error('Repository toolchain mismatch')
    }
    if (!/^engine-strict\s*=\s*true\s*$/m.test(readTextFile(resolveRepoPath(repoRoot, '.npmrc'), '.npmrc'))) {
        throw new Error('Repository toolchain mismatch')
    }
}

const detectToolchain = (repoRoot) => {
    let pnpmVersion
    try {
        pnpmVersion = execFileSync('pnpm', ['--version'], {
            cwd: repoRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
        }).trim()
    } catch {
        throw new Error('Release toolchain mismatch')
    }
    return normalizeToolchain({ node: process.version, pnpm: pnpmVersion, package_manager: 'pnpm@10.26.0' })
}

export const readEnvTemplateKeys = (filePath) => {
    const content = readTextFile(filePath, 'env template')
    const seen = new Set()
    for (const [index, line] of content.split(/\r?\n/).entries()) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const separator = line.indexOf('=')
        const key = separator === -1 ? '' : line.slice(0, separator).trim()
        if (!ENV_KEY_PATTERN.test(key)) throw new Error(`Invalid env template assignment at line ${index + 1}`)
        if (seen.has(key)) throw new Error(`Found duplicate env template key at line ${index + 1}`)
        seen.add(key)
    }
    const keys = [...seen].sort()
    return { keys, keys_digest: sha256(`${keys.join('\n')}\n`) }
}

const collectInputs = (repoRoot) => {
    const files = [...INPUT_FILES].sort().map((path) => ({
        path,
        ...hashRegularFile(resolveRepoPath(repoRoot, path), `release input ${path}`)
    }))
    return {
        env_template: {
            path: '.env.production.template',
            ...readEnvTemplateKeys(resolveRepoPath(repoRoot, '.env.production.template'))
        },
        files
    }
}

const validateExplicitUntrackedInputs = (repoRoot, untrackedInputs) => {
    if (!Array.isArray(untrackedInputs)) throw new Error('Untracked release inputs must be explicit')
    const normalized = [...new Set(untrackedInputs.map((entry) => validateRelativePath(entry)))].sort()
    if (normalized.length !== untrackedInputs.length) throw new Error('Untracked release inputs must be unique')
    for (const path of normalized) assertRegularFile(resolveRepoPath(repoRoot, path), 'Untracked release input')
    return normalized
}

export const inspectSource = ({ repoRoot, allowDirty = false, untrackedInputs = [] }) => {
    const root = resolve(repoRoot)
    const revision = validateRevision(runGit(root, ['rev-parse', 'HEAD']).trim())
    const repositoryUrl = sanitizeRepositoryUrl(runGit(root, ['remote', 'get-url', 'origin']).trim())
    const allowedUntracked = validateExplicitUntrackedInputs(root, untrackedInputs)

    const changedPaths = splitNul(runGit(root, ['diff', '--name-only', '-z', 'HEAD', '--'], true))
    for (const changedPath of changedPaths) validateRelativePath(changedPath)

    const actualUntracked = splitNul(runGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--'], true))
    if (canonicalStringify(actualUntracked) !== canonicalStringify(allowedUntracked)) {
        throw new Error('Unexpected untracked release input')
    }

    const trackedPatch = runGit(root, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], true)
    const untracked = allowedUntracked.map((path) => ({ path, ...hashRegularFile(resolveRepoPath(root, path), 'Untracked release input') }))
    const dirty = trackedPatch.length > 0 || untracked.length > 0
    if (dirty && !allowDirty) throw new Error('Dirty source requires --allow-dirty')

    if (!dirty) {
        return {
            release_id: `git-${revision}`,
            source: {
                dirty_digest: null,
                repository_url: repositoryUrl,
                revision,
                state: 'clean',
                tracked_patch: null,
                untracked: []
            }
        }
    }

    const trackedPatchEntry = { digest: sha256(trackedPatch), bytes: trackedPatch.length }
    const dirtyDigest = sha256(canonicalStringify({ tracked_patch: trackedPatchEntry, untracked }))
    return {
        release_id: `dirty-${revision.slice(0, 12)}-${digestHex(dirtyDigest).slice(0, 12)}`,
        source: {
            dirty_digest: dirtyDigest,
            repository_url: repositoryUrl,
            revision,
            state: 'dirty',
            tracked_patch: trackedPatchEntry,
            untracked
        }
    }
}

const assertExactKeys = (value, expectedKeys, scope) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`Invalid ${scope}`)
    }
    const actual = Object.keys(value).sort()
    const expected = [...expectedKeys].sort()
    if (canonicalStringify(actual) !== canonicalStringify(expected)) throw new Error(`Found unknown manifest field in ${scope}`)
}

const assertInteger = (value, scope) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${scope}`)
}

const validateFileEntry = (entry, scope) => {
    assertExactKeys(entry, ['bytes', 'digest', 'path'], scope)
    validateRelativePath(entry.path)
    validateDigest(entry.digest, scope)
    assertInteger(entry.bytes, `${scope} byte count`)
}

export const validateManifest = (manifest) => {
    assertExactKeys(
        manifest,
        ['boundaries', 'created_at', 'image', 'inputs', 'release_id', 'schema_version', 'source', 'toolchain'],
        'root'
    )
    if (manifest.schema_version !== 1) throw new Error('Unsupported manifest schema version')
    if (typeof manifest.created_at !== 'string' || new Date(manifest.created_at).toISOString() !== manifest.created_at) {
        throw new Error('Invalid manifest creation timestamp')
    }

    assertExactKeys(manifest.source, ['dirty_digest', 'repository_url', 'revision', 'state', 'tracked_patch', 'untracked'], 'source')
    validateRevision(manifest.source.revision)
    if (sanitizeRepositoryUrl(manifest.source.repository_url) !== manifest.source.repository_url) {
        throw new Error('Repository URL is not normalized')
    }
    if (!Array.isArray(manifest.source.untracked)) throw new Error('Invalid source untracked inputs')
    for (const entry of manifest.source.untracked) validateFileEntry(entry, 'source untracked entry')
    const sortedUntrackedPaths = manifest.source.untracked.map((entry) => entry.path)
    if (canonicalStringify(sortedUntrackedPaths) !== canonicalStringify([...new Set(sortedUntrackedPaths)].sort())) {
        throw new Error('Source untracked inputs must be sorted and unique')
    }

    assertExactKeys(
        manifest.boundaries,
        ['production_unchanged', 'production_write', 'provider_call', 'registry_push', 'secrets_read', 'stable'],
        'boundaries'
    )
    for (const [key, expected] of Object.entries(BOUNDARIES)) {
        if (manifest.boundaries[key] !== expected) throw new Error('Release boundary invariant failed')
    }

    if (manifest.source.state === 'clean') {
        if (
            manifest.source.tracked_patch !== null ||
            manifest.source.untracked.length !== 0 ||
            manifest.source.dirty_digest !== null ||
            manifest.release_id !== `git-${manifest.source.revision}` ||
            manifest.boundaries.stable !== true
        ) {
            throw new Error('clean source invariant failed')
        }
    } else if (manifest.source.state === 'dirty') {
        validateFileEntry({ path: 'tracked.patch', ...manifest.source.tracked_patch }, 'tracked patch')
        validateDigest(manifest.source.dirty_digest, 'dirty source')
        const expectedDirtyDigest = sha256(
            canonicalStringify({ tracked_patch: manifest.source.tracked_patch, untracked: manifest.source.untracked })
        )
        if (manifest.source.dirty_digest !== expectedDirtyDigest) throw new Error('dirty source digest mismatch')
        const expectedReleaseId = `dirty-${manifest.source.revision.slice(0, 12)}-${digestHex(manifest.source.dirty_digest).slice(0, 12)}`
        if (
            (manifest.source.tracked_patch.bytes === 0 && manifest.source.untracked.length === 0) ||
            manifest.release_id !== expectedReleaseId ||
            manifest.boundaries.stable !== false
        ) {
            throw new Error('Dirty source invariant failed')
        }
    } else {
        throw new Error('Invalid source state')
    }

    assertExactKeys(manifest.toolchain, ['node', 'package_manager', 'pnpm'], 'toolchain')
    normalizeToolchain(manifest.toolchain)

    assertExactKeys(manifest.inputs, ['env_template', 'files'], 'inputs')
    if (!Array.isArray(manifest.inputs.files)) throw new Error('Invalid manifest input files')
    for (const entry of manifest.inputs.files) validateFileEntry(entry, 'manifest input file')
    const filePaths = manifest.inputs.files.map((entry) => entry.path)
    if (canonicalStringify(filePaths) !== canonicalStringify([...new Set(filePaths)].sort())) {
        throw new Error('Manifest input files must be sorted and unique')
    }
    if (canonicalStringify(filePaths) !== canonicalStringify([...INPUT_FILES].sort())) {
        throw new Error('Manifest must contain the fixed release input path set')
    }
    assertExactKeys(manifest.inputs.env_template, ['keys', 'keys_digest', 'path'], 'env template input')
    if (manifest.inputs.env_template.path !== '.env.production.template' || !Array.isArray(manifest.inputs.env_template.keys)) {
        throw new Error('Invalid env template input')
    }
    const envKeys = manifest.inputs.env_template.keys
    if (
        envKeys.some((key) => !ENV_KEY_PATTERN.test(key)) ||
        canonicalStringify(envKeys) !== canonicalStringify([...new Set(envKeys)].sort())
    ) {
        throw new Error('Env template keys must be sorted and unique')
    }
    if (manifest.inputs.env_template.keys_digest !== sha256(`${envKeys.join('\n')}\n`)) {
        throw new Error('Env template key digest mismatch')
    }

    assertExactKeys(manifest.image, ['archive', 'config_digest', 'distribution', 'platform', 'tag'], 'image')
    if (manifest.image.distribution !== 'offline_archive' || manifest.image.platform !== 'linux/amd64') {
        throw new Error('Invalid offline image contract')
    }
    validateImageTag(manifest.image.tag, manifest.release_id)
    validateDigest(manifest.image.config_digest, 'image config')
    assertExactKeys(manifest.image.archive, ['bytes', 'digest'], 'archive')
    validateDigest(manifest.image.archive.digest, 'archive')
    assertInteger(manifest.image.archive.bytes, 'archive byte count')
    return manifest
}

export const generateManifest = ({
    repoRoot,
    distribution,
    imageTag,
    imageConfigDigest,
    archivePath,
    platform,
    allowDirty = false,
    untrackedInputs = [],
    toolchain,
    now
}) => {
    if (distribution !== 'offline_archive' || platform !== 'linux/amd64') throw new Error('Invalid offline image contract')
    validateDigest(imageConfigDigest, 'image config')
    validateRepositoryToolchain(repoRoot)
    const normalizedToolchain = normalizeToolchain(toolchain)
    const { release_id: releaseId, source } = inspectSource({ repoRoot, allowDirty, untrackedInputs })
    validateImageTag(imageTag, releaseId)
    const archive = hashRegularFile(archivePath, 'Image archive')
    const createdAt = now ?? new Date().toISOString()

    const manifest = {
        schema_version: 1,
        release_id: releaseId,
        created_at: createdAt,
        source,
        toolchain: normalizedToolchain,
        inputs: collectInputs(repoRoot),
        image: {
            archive,
            config_digest: imageConfigDigest,
            distribution,
            platform,
            tag: imageTag
        },
        boundaries: { ...BOUNDARIES, stable: source.state === 'clean' }
    }
    return validateManifest(manifest)
}

export const verifyManifest = ({ repoRoot, manifest, imageTag, imageConfigDigest, archivePath, requireClean = false, toolchain }) => {
    validateManifest(manifest)
    if (requireClean && manifest.source.state !== 'clean') throw new Error('A clean source is required')
    if (manifest.image.tag !== imageTag) throw new Error('Image tag mismatch')
    validateDigest(imageConfigDigest, 'image config')
    if (manifest.image.config_digest !== imageConfigDigest) throw new Error('image config digest mismatch')
    const archive = hashRegularFile(archivePath, 'Image archive')
    if (canonicalStringify(archive) !== canonicalStringify(manifest.image.archive)) throw new Error('Image archive mismatch')

    validateRepositoryToolchain(repoRoot)
    const normalizedToolchain = normalizeToolchain(toolchain)
    if (canonicalStringify(normalizedToolchain) !== canonicalStringify(manifest.toolchain)) throw new Error('Release toolchain mismatch')

    const currentSource = inspectSource({
        repoRoot,
        allowDirty: manifest.source.state === 'dirty',
        untrackedInputs: manifest.source.untracked.map((entry) => entry.path)
    })
    if (
        currentSource.release_id !== manifest.release_id ||
        canonicalStringify(currentSource.source) !== canonicalStringify(manifest.source)
    ) {
        throw new Error('Release source state mismatch')
    }
    if (canonicalStringify(collectInputs(repoRoot)) !== canonicalStringify(manifest.inputs)) {
        throw new Error('Release input mismatch')
    }
    return true
}

export const writeManifestAtomic = (manifestPath, manifest) => {
    validateManifest(manifest)
    const target = resolve(manifestPath)
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error('Manifest output must not be a symlink')
    assertDirectory(dirname(target), 'Manifest output directory')
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
    try {
        writeFileSync(temporary, canonicalStringify(manifest), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        renameSync(temporary, target)
    } catch {
        try {
            if (existsSync(temporary)) unlinkSync(temporary)
        } catch {
            // Best-effort cleanup of a file created by this process only.
        }
        throw new Error('Manifest output could not be written atomically')
    }
}

export const verifyManifestFile = ({ manifestPath, ...options }) => {
    const raw = readTextFile(manifestPath, 'Manifest file')
    let manifest
    try {
        manifest = JSON.parse(raw)
    } catch {
        throw new Error('Manifest file is not valid JSON')
    }
    validateManifest(manifest)
    if (raw !== canonicalStringify(manifest)) throw new Error('Manifest file is not canonical JSON')
    return verifyManifest({ ...options, manifest })
}

const parseCommandArgs = (argv, command) => {
    const booleanFlags =
        command === 'generate' ? new Set(['--allow-dirty']) : command === 'verify' ? new Set(['--require-clean']) : new Set()
    const repeatableFlags = command === 'generate' ? new Set(['--untracked-input']) : new Set()
    const allowedValueFlags =
        command === 'generate'
            ? new Set(['--distribution', '--image-tag', '--image-config-digest', '--archive', '--platform', '--out', '--untracked-input'])
            : command === 'verify'
            ? new Set(['--manifest', '--image-tag', '--image-config-digest', '--archive'])
            : new Set(['--archive', '--image-tag', '--revision', '--source', '--version', '--created', '--platform'])
    const parsed = { untrackedInputs: [] }

    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index]
        if (booleanFlags.has(flag)) {
            if (parsed[flag]) throw new Error(`Duplicate CLI flag ${flag}`)
            parsed[flag] = true
            continue
        }
        if (!allowedValueFlags.has(flag)) throw new Error('Unknown CLI flag')
        if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`Missing value for ${flag}`)
        const value = argv[++index]
        if (repeatableFlags.has(flag)) {
            parsed.untrackedInputs.push(value)
        } else {
            if (parsed[flag] !== undefined) throw new Error(`Duplicate CLI flag ${flag}`)
            parsed[flag] = value
        }
    }
    return parsed
}

const requireFlags = (parsed, flags) => {
    for (const flag of flags) {
        if (typeof parsed[flag] !== 'string' || parsed[flag].length === 0) throw new Error(`Missing required CLI flag ${flag}`)
    }
}

const runCli = async (argv) => {
    const [command, ...rest] = argv
    if (!['generate', 'verify', 'verify-archive'].includes(command)) {
        throw new Error('Expected generate, verify or verify-archive command')
    }
    const parsed = parseCommandArgs(rest, command)
    const repoRoot = process.cwd()

    if (command === 'verify-archive') {
        requireFlags(parsed, ['--archive', '--image-tag', '--revision', '--source', '--version', '--created', '--platform'])
        const result = await verifyDockerArchive({
            archivePath: parsed['--archive'],
            imageTag: parsed['--image-tag'],
            revision: parsed['--revision'],
            source: parsed['--source'],
            version: parsed['--version'],
            created: parsed['--created'],
            platform: parsed['--platform']
        })
        process.stdout.write(`${result.imageConfigDigest}\n`)
        return
    }

    const toolchain = detectToolchain(repoRoot)

    if (command === 'generate') {
        requireFlags(parsed, ['--distribution', '--image-tag', '--image-config-digest', '--archive', '--platform', '--out'])
        const manifest = generateManifest({
            repoRoot,
            distribution: parsed['--distribution'],
            imageTag: parsed['--image-tag'],
            imageConfigDigest: parsed['--image-config-digest'],
            archivePath: parsed['--archive'],
            platform: parsed['--platform'],
            allowDirty: parsed['--allow-dirty'] === true,
            untrackedInputs: parsed.untrackedInputs,
            toolchain
        })
        writeManifestAtomic(parsed['--out'], manifest)
        process.stdout.write('Release manifest generated.\n')
        return
    }

    requireFlags(parsed, ['--manifest', '--image-tag', '--image-config-digest', '--archive'])
    verifyManifestFile({
        repoRoot,
        manifestPath: parsed['--manifest'],
        imageTag: parsed['--image-tag'],
        imageConfigDigest: parsed['--image-config-digest'],
        archivePath: parsed['--archive'],
        requireClean: parsed['--require-clean'] === true,
        toolchain
    })
    process.stdout.write('Release manifest verified.\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runCli(process.argv.slice(2)).catch((error) => {
        process.stderr.write(`Release manifest error: ${error.message}\n`)
        process.exitCode = 1
    })
}
