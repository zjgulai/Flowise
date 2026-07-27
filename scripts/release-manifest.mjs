import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    'docker/seccomp/chromium.json',
    'package.json',
    'pnpm-lock.yaml',
    'scripts/publish-verified-image.sh',
    'scripts/release-manifest.mjs',
    'scripts/verify-chromium-sandbox.sh',
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

const readDockerArchiveMember = (archivePath, memberPath) => {
    try {
        return execFileSync('tar', ['-xOzf', resolve(archivePath), memberPath], {
            encoding: null,
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch {
        throw new Error(`Docker archive member is unavailable: ${memberPath}`)
    }
}

const listDockerArchiveMembers = (archivePath) => {
    assertRegularFile(archivePath, 'Docker archive')
    let listing
    try {
        listing = execFileSync('tar', ['-tzf', resolve(archivePath)], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        })
    } catch {
        throw new Error('Docker archive is not a readable gzip-compressed tar file')
    }
    const members = listing.split('\n').filter(Boolean)
    if (members.length === 0 || members.some((member) => /[\r\0]/.test(member))) {
        throw new Error('Docker archive member list is invalid')
    }
    return members
}

const parseArchiveJson = (contents, label) => {
    try {
        return JSON.parse(contents.toString('utf8'))
    } catch {
        throw new Error(`${label} is not valid JSON`)
    }
}

export const verifyDockerArchive = ({ archivePath, imageTag, revision, source, version, created, platform }) => {
    validateRevision(revision)
    if (version !== `git-${revision}`) throw new Error('Docker archive version must match the exact Git revision')
    validateImageTag(imageTag, version)
    if (sanitizeRepositoryUrl(source) !== source) throw new Error('Docker archive source must be normalized')
    if (typeof created !== 'string' || created.length > 128 || /[\r\n\0]/.test(created) || Number.isNaN(Date.parse(created))) {
        throw new Error('Docker archive creation time is invalid')
    }
    if (platform !== 'linux/amd64') throw new Error('Docker archive platform must be linux/amd64')

    const members = listDockerArchiveMembers(archivePath)
    if (members.filter((member) => member === 'manifest.json').length !== 1) {
        throw new Error('Docker archive must contain exactly one manifest.json')
    }
    const archiveManifest = parseArchiveJson(readDockerArchiveMember(archivePath, 'manifest.json'), 'Docker archive manifest')
    if (!Array.isArray(archiveManifest) || archiveManifest.length !== 1) {
        throw new Error('Docker archive must contain exactly one image')
    }

    const entry = archiveManifest[0]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Docker archive image entry is invalid')
    if (!Array.isArray(entry.RepoTags) || entry.RepoTags.length !== 1 || entry.RepoTags[0] !== imageTag) {
        throw new Error('Docker archive tag mismatch')
    }
    const configMatch = /^(?:blobs\/sha256\/)?([0-9a-f]{64})(?:\.json)?$/.exec(entry.Config)
    if (!configMatch) throw new Error('Docker archive config path is invalid')
    const configPath = entry.Config
    validateRelativePath(configPath)
    if (members.filter((member) => member === configPath).length !== 1) {
        throw new Error('Docker archive must contain exactly one image config')
    }
    if (!Array.isArray(entry.Layers) || entry.Layers.length === 0 || new Set(entry.Layers).size !== entry.Layers.length) {
        throw new Error('Docker archive layer list is invalid')
    }
    for (const layerPath of entry.Layers) {
        validateRelativePath(layerPath)
        if (members.filter((member) => member === layerPath).length !== 1) {
            throw new Error('Docker archive layer is unavailable')
        }
    }

    const configContents = readDockerArchiveMember(archivePath, configPath)
    const actualConfigHex = createHash('sha256').update(configContents).digest('hex')
    if (actualConfigHex !== configMatch[1]) throw new Error('Docker archive config content hash mismatch')
    const imageConfig = parseArchiveJson(configContents, 'Docker archive image config')
    if (!imageConfig || typeof imageConfig !== 'object' || Array.isArray(imageConfig)) {
        throw new Error('Docker archive image config is invalid')
    }
    if (`${imageConfig.os}/${imageConfig.architecture}` !== platform) throw new Error('Docker archive platform mismatch')

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

const runCli = (argv) => {
    const [command, ...rest] = argv
    if (!['generate', 'verify', 'verify-archive'].includes(command)) {
        throw new Error('Expected generate, verify or verify-archive command')
    }
    const parsed = parseCommandArgs(rest, command)
    const repoRoot = process.cwd()

    if (command === 'verify-archive') {
        requireFlags(parsed, ['--archive', '--image-tag', '--revision', '--source', '--version', '--created', '--platform'])
        const result = verifyDockerArchive({
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
    try {
        runCli(process.argv.slice(2))
    } catch (error) {
        process.stderr.write(`Release manifest error: ${error.message}\n`)
        process.exitCode = 1
    }
}
