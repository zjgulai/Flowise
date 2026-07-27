import { createHash, randomBytes } from 'node:crypto'
import {
    chmodSync,
    closeSync,
    constants as fsConstants,
    copyFileSync,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readSync,
    readdirSync,
    renameSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalStringify, validateManifest } from './release-manifest.mjs'

const REVISION_PATTERN = /^[0-9a-f]{40}$/
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const ROLE_LAYOUT = Object.freeze({
    chromium_seccomp: 'docker/seccomp/chromium.json',
    image_archive: 'image.tar.gz',
    production_compose: 'docker-compose.prod.yml',
    production_wrapper: 'scripts/flowise-production-release.py',
    release_evidence: 'evidence.txt',
    release_manifest: 'release-manifest.json'
})
const BOUNDARIES = Object.freeze({
    production_write: false,
    provider_call: false,
    registry_push: false,
    secrets_read: false
})
const EVIDENCE_KEYS = Object.freeze([
    'source',
    'revision',
    'image_tag',
    'store_identity',
    'image_config_digest',
    'platform',
    'archive_bytes',
    'archive_sha256',
    'manifest_sha256',
    'isolated_smoke',
    'chromium_profile_sha256',
    'production_compose_sha256',
    'production_wrapper_sha256',
    'chromium_sandbox',
    'raw_chromium_sandbox',
    'playwright_sandbox',
    'puppeteer_sandbox',
    'clone3_namespace',
    'unsafe_chromium_flags',
    'registry_push'
])

const assertExactKeys = (value, expectedKeys, scope) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`Invalid ${scope}`)
    }
    if (canonicalStringify(Object.keys(value).sort()) !== canonicalStringify([...expectedKeys].sort())) {
        throw new Error(`Found unknown field in ${scope}`)
    }
}

const assertSafeRelativePath = (value) => {
    if (
        typeof value !== 'string' ||
        value.length === 0 ||
        value.includes('\\') ||
        value.includes('\0') ||
        value.includes('\r') ||
        value.includes('\n') ||
        isAbsolute(value)
    ) {
        throw new Error('Unsafe deployment bundle path')
    }
    const normalized = value
        .split('/')
        .filter((part) => part !== '.')
        .join('/')
    if (normalized !== value || value.split('/').some((part) => part.length === 0 || part === '..')) {
        throw new Error('Unsafe deployment bundle path')
    }
    return value
}

const assertDirectory = (path, label) => {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a regular directory`)
}

const ensureBundleParentDirectories = (bundleDir, relativePath) => {
    const parts = assertSafeRelativePath(relativePath).split('/').slice(0, -1)
    let current = resolve(bundleDir)
    assertDirectory(current, 'Deployment bundle')
    for (const part of parts) {
        current = join(current, part)
        if (existsSync(current)) {
            assertDirectory(current, 'Deployment bundle parent')
        } else {
            mkdirSync(current, { mode: 0o700 })
        }
    }
}

const assertRegularFile = (path, label) => {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${label} must be a regular file`)
    return info
}

const openRegularFile = (path, label) => {
    const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1) {
        closeSync(descriptor)
        throw new Error(`${label} must be a regular file`)
    }
    return { descriptor, info }
}

const assertFileUnchanged = (before, after, bytes, label) => {
    if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes !== before.size
    ) {
        throw new Error(`${label} changed while being read`)
    }
}

const hashFile = (path, label) => {
    const { descriptor, info } = openRegularFile(path, label)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let total = 0
    try {
        for (;;) {
            const count = readSync(descriptor, buffer, 0, buffer.length, null)
            if (count === 0) break
            hash.update(buffer.subarray(0, count))
            total += count
        }
        assertFileUnchanged(info, fstatSync(descriptor), total, label)
        return { bytes: total, digest: `sha256:${hash.digest('hex')}` }
    } finally {
        closeSync(descriptor)
    }
}

const readRegularFile = (path, label, encoding = null, maxBytes = 2 * 1024 * 1024) => {
    const { descriptor, info } = openRegularFile(path, label)
    try {
        if (info.size > maxBytes) throw new Error(`${label} is too large`)
        const bytes = readFileSync(descriptor)
        assertFileUnchanged(info, fstatSync(descriptor), bytes.length, label)
        return encoding === null ? bytes : bytes.toString(encoding)
    } finally {
        closeSync(descriptor)
    }
}

const readCanonicalJson = (path, label) => {
    const raw = readRegularFile(path, label, 'utf8')
    let document
    try {
        document = JSON.parse(raw)
    } catch {
        throw new Error(`${label} is not valid JSON`)
    }
    if (raw !== canonicalStringify(document)) throw new Error(`${label} is not canonical JSON`)
    return document
}

const resolveBundlePath = (bundleDir, relativePath) => {
    const root = resolve(bundleDir)
    const target = resolve(root, assertSafeRelativePath(relativePath))
    const rel = relative(root, target)
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new Error('Unsafe deployment bundle path')
    }
    return target
}

const parseEvidence = (path) => {
    const text = readRegularFile(path, 'Release evidence', 'utf8', 64 * 1024)
    const entries = {}
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue
        const separator = line.indexOf('=')
        if (separator <= 0) throw new Error('Release evidence contains an invalid line')
        const key = line.slice(0, separator)
        const value = line.slice(separator + 1)
        if (!/^[a-z][a-z0-9_]*$/.test(key) || Object.hasOwn(entries, key) || /[\r\n\0]/.test(value)) {
            throw new Error('Release evidence contains an invalid entry')
        }
        entries[key] = value
    }
    return entries
}

const manifestInput = (manifest, path) => {
    const matches = manifest.inputs.files.filter((entry) => entry.path === path)
    if (matches.length !== 1) throw new Error(`Release manifest input is unavailable: ${path}`)
    return matches[0]
}

const fileEntry = (role, path, absolutePath) => ({ role, path, ...hashFile(absolutePath, `Deployment payload ${role}`) })

const validateFileEntry = (entry) => {
    assertExactKeys(entry, ['bytes', 'digest', 'path', 'role'], 'deployment file entry')
    if (!Object.hasOwn(ROLE_LAYOUT, entry.role) || ROLE_LAYOUT[entry.role] !== entry.path) {
        throw new Error('Deployment bundle role or path mismatch')
    }
    assertSafeRelativePath(entry.path)
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !DIGEST_PATTERN.test(entry.digest)) {
        throw new Error('Invalid deployment file identity')
    }
}

export const validateDeploymentBundle = (bundle) => {
    assertExactKeys(bundle, ['boundaries', 'created_at', 'files', 'release', 'schema_version'], 'deployment bundle')
    if (bundle.schema_version !== 1) throw new Error('Unsupported deployment bundle schema')
    if (typeof bundle.created_at !== 'string' || new Date(bundle.created_at).toISOString() !== bundle.created_at) {
        throw new Error('Invalid deployment bundle timestamp')
    }
    assertExactKeys(bundle.release, ['image_config_digest', 'image_tag', 'release_id', 'revision'], 'deployment release')
    if (!REVISION_PATTERN.test(bundle.release.revision) || bundle.release.release_id !== `git-${bundle.release.revision}`) {
        throw new Error('Deployment release identity mismatch')
    }
    if (bundle.release.image_tag !== `flowise-chinese:${bundle.release.release_id}`) {
        throw new Error('Deployment image tag must use the immutable production namespace')
    }
    if (!DIGEST_PATTERN.test(bundle.release.image_config_digest)) throw new Error('Invalid deployment image config digest')

    assertExactKeys(bundle.boundaries, Object.keys(BOUNDARIES), 'deployment boundaries')
    for (const [key, expected] of Object.entries(BOUNDARIES)) {
        if (bundle.boundaries[key] !== expected) throw new Error('Deployment boundary invariant failed')
    }

    if (!Array.isArray(bundle.files) || bundle.files.length !== Object.keys(ROLE_LAYOUT).length) {
        throw new Error('Deployment bundle file set mismatch')
    }
    for (const entry of bundle.files) validateFileEntry(entry)
    const roles = bundle.files.map((entry) => entry.role)
    const paths = bundle.files.map((entry) => entry.path)
    if (
        canonicalStringify(roles.slice().sort()) !== canonicalStringify(Object.keys(ROLE_LAYOUT).sort()) ||
        canonicalStringify(paths) !== canonicalStringify(paths.slice().sort()) ||
        new Set(paths).size !== paths.length
    ) {
        throw new Error('Deployment bundle files must be exact, sorted, and unique')
    }
    return bundle
}

const verifyManifestAndEvidence = (bundleDir, bundle) => {
    const files = Object.fromEntries(bundle.files.map((entry) => [entry.role, entry]))
    const manifestPath = resolveBundlePath(bundleDir, files.release_manifest.path)
    const manifest = readCanonicalJson(manifestPath, 'Release manifest')
    validateManifest(manifest)
    if (
        manifest.source.state !== 'clean' ||
        manifest.boundaries.stable !== true ||
        manifest.release_id !== bundle.release.release_id ||
        manifest.source.revision !== bundle.release.revision ||
        manifest.image.tag !== bundle.release.image_tag ||
        manifest.image.config_digest !== bundle.release.image_config_digest
    ) {
        throw new Error('Deployment bundle and release manifest identity mismatch')
    }
    const archive = files.image_archive
    if (manifest.image.archive.bytes !== archive.bytes || manifest.image.archive.digest !== archive.digest) {
        throw new Error('Deployment archive is not bound by the release manifest')
    }

    for (const role of ['production_compose', 'chromium_seccomp', 'production_wrapper']) {
        const payload = files[role]
        const input = manifestInput(manifest, payload.path)
        if (input.bytes !== payload.bytes || input.digest !== payload.digest) {
            throw new Error(`Deployment payload is not bound by the source manifest: ${role}`)
        }
    }

    const evidence = parseEvidence(resolveBundlePath(bundleDir, files.release_evidence.path))
    if (canonicalStringify(Object.keys(evidence).sort()) !== canonicalStringify([...EVIDENCE_KEYS].sort())) {
        throw new Error('Release evidence field set mismatch')
    }
    const requiredEvidence = {
        source: manifest.source.repository_url,
        revision: bundle.release.revision,
        image_tag: bundle.release.image_tag,
        archive_bytes: String(archive.bytes),
        archive_sha256: archive.digest.slice('sha256:'.length),
        chromium_profile_sha256: files.chromium_seccomp.digest.slice('sha256:'.length),
        image_config_digest: bundle.release.image_config_digest,
        platform: manifest.image.platform,
        manifest_sha256: files.release_manifest.digest.slice('sha256:'.length),
        production_compose_sha256: files.production_compose.digest.slice('sha256:'.length),
        production_wrapper_sha256: files.production_wrapper.digest.slice('sha256:'.length),
        clone3_namespace: 'blocked_enosys',
        unsafe_chromium_flags: 'false',
        registry_push: 'false',
        isolated_smoke: 'passed',
        chromium_sandbox: 'passed',
        raw_chromium_sandbox: 'passed',
        playwright_sandbox: 'passed',
        puppeteer_sandbox: 'passed'
    }
    for (const [key, expected] of Object.entries(requiredEvidence)) {
        if (evidence[key] !== expected) throw new Error(`Release evidence mismatch: ${key}`)
    }
    if (!DIGEST_PATTERN.test(evidence.store_identity)) {
        throw new Error('Release evidence contains an invalid local Docker store identity')
    }
    return manifest
}

const listPayloadFiles = (directory, root = directory) => {
    const paths = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name)
        const info = lstatSync(absolute)
        if (info.isSymbolicLink()) throw new Error('Deployment bundle must not contain symlinks')
        if (info.isDirectory()) {
            paths.push(...listPayloadFiles(absolute, root))
        } else if (info.isFile() && info.nlink === 1) {
            paths.push(relative(root, absolute).split(sep).join('/'))
        } else {
            throw new Error('Deployment bundle contains an unsafe filesystem entry')
        }
    }
    return paths.sort()
}

export const verifyDeploymentBundle = ({ bundleDir, expectedRevision, expectedImageTag, expectedImageConfigDigest }) => {
    const root = resolve(bundleDir)
    assertDirectory(root, 'Deployment bundle')
    const bundlePath = join(root, 'deployment-bundle.json')
    const bundle = validateDeploymentBundle(readCanonicalJson(bundlePath, 'Deployment bundle manifest'))
    if (
        bundle.release.revision !== expectedRevision ||
        bundle.release.image_tag !== expectedImageTag ||
        bundle.release.image_config_digest !== expectedImageConfigDigest
    ) {
        throw new Error('Deployment bundle expected identity mismatch')
    }

    const expectedPaths = [...bundle.files.map((entry) => entry.path), 'deployment-bundle.json'].sort()
    if (canonicalStringify(listPayloadFiles(root)) !== canonicalStringify(expectedPaths)) {
        throw new Error('Deployment bundle contains an unexpected or missing payload')
    }
    for (const entry of bundle.files) {
        const actual = hashFile(resolveBundlePath(root, entry.path), `Deployment payload ${entry.role}`)
        if (actual.bytes !== entry.bytes || actual.digest !== entry.digest) {
            throw new Error(`Deployment payload identity mismatch: ${entry.role}`)
        }
    }
    verifyManifestAndEvidence(root, bundle)
    return bundle
}

const copyPayload = (source, destination, bundleDir, relativePath) => {
    assertRegularFile(source, 'Deployment source')
    if (existsSync(destination)) throw new Error('Deployment payload destination already exists')
    ensureBundleParentDirectories(bundleDir, relativePath)
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL)
    chmodSync(destination, 0o600)
}

const writeCanonicalAtomic = (path, document) => {
    if (existsSync(path)) throw new Error('Deployment bundle manifest already exists')
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
    try {
        writeFileSync(temporary, canonicalStringify(document), { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        renameSync(temporary, path)
    } catch {
        try {
            if (existsSync(temporary)) unlinkSync(temporary)
        } catch {
            // Best-effort cleanup of a file created by this process only.
        }
        throw new Error('Deployment bundle manifest could not be written atomically')
    }
}

export const generateDeploymentBundle = ({
    bundleDir,
    archivePath,
    manifestPath,
    evidencePath,
    composePath,
    seccompPath,
    wrapperPath,
    now
}) => {
    const root = resolve(bundleDir)
    assertDirectory(root, 'Deployment bundle')
    const fixedExisting = {
        image_archive: resolveBundlePath(root, ROLE_LAYOUT.image_archive),
        release_evidence: resolveBundlePath(root, ROLE_LAYOUT.release_evidence),
        release_manifest: resolveBundlePath(root, ROLE_LAYOUT.release_manifest)
    }
    if (
        resolve(archivePath) !== fixedExisting.image_archive ||
        resolve(manifestPath) !== fixedExisting.release_manifest ||
        resolve(evidencePath) !== fixedExisting.release_evidence
    ) {
        throw new Error('Release outputs must use the fixed deployment bundle layout')
    }
    for (const [role, path] of Object.entries(fixedExisting)) assertRegularFile(path, `Deployment payload ${role}`)

    const manifest = readCanonicalJson(fixedExisting.release_manifest, 'Release manifest')
    validateManifest(manifest)
    if (
        manifest.source.state !== 'clean' ||
        manifest.boundaries.stable !== true ||
        manifest.image.tag !== `flowise-chinese:${manifest.release_id}`
    ) {
        throw new Error('Only a clean immutable production release may form a deployment bundle')
    }

    const sources = {
        chromium_seccomp: resolve(seccompPath),
        production_compose: resolve(composePath),
        production_wrapper: resolve(wrapperPath)
    }
    for (const [role, source] of Object.entries(sources)) {
        const relativePath = ROLE_LAYOUT[role]
        const destination = resolveBundlePath(root, relativePath)
        copyPayload(source, destination, root, relativePath)
    }

    const absoluteByRole = {
        ...fixedExisting,
        chromium_seccomp: resolveBundlePath(root, ROLE_LAYOUT.chromium_seccomp),
        production_compose: resolveBundlePath(root, ROLE_LAYOUT.production_compose),
        production_wrapper: resolveBundlePath(root, ROLE_LAYOUT.production_wrapper)
    }
    const files = Object.entries(ROLE_LAYOUT)
        .map(([role, path]) => fileEntry(role, path, absoluteByRole[role]))
        .sort((left, right) => left.path.localeCompare(right.path))

    const bundle = validateDeploymentBundle({
        schema_version: 1,
        created_at: now ?? manifest.created_at,
        release: {
            release_id: manifest.release_id,
            revision: manifest.source.revision,
            image_tag: manifest.image.tag,
            image_config_digest: manifest.image.config_digest
        },
        files,
        boundaries: { ...BOUNDARIES }
    })
    const bundlePath = join(root, 'deployment-bundle.json')
    writeCanonicalAtomic(bundlePath, bundle)
    verifyDeploymentBundle({
        bundleDir: root,
        expectedRevision: bundle.release.revision,
        expectedImageTag: bundle.release.image_tag,
        expectedImageConfigDigest: bundle.release.image_config_digest
    })
    return bundle
}

const parseArgs = (argv, command) => {
    const allowed =
        command === 'generate'
            ? new Set(['--bundle-dir', '--archive', '--manifest', '--evidence', '--compose', '--seccomp', '--wrapper'])
            : new Set(['--bundle-dir', '--expected-revision', '--expected-image-tag', '--expected-image-config-digest'])
    const parsed = {}
    for (let index = 0; index < argv.length; index += 2) {
        const flag = argv[index]
        const value = argv[index + 1]
        if (!allowed.has(flag) || typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
            throw new Error('Invalid deployment bundle CLI arguments')
        }
        if (Object.hasOwn(parsed, flag)) throw new Error(`Duplicate CLI flag ${flag}`)
        parsed[flag] = value
    }
    if (Object.keys(parsed).length !== allowed.size) throw new Error('Missing deployment bundle CLI argument')
    return parsed
}

const runCli = (argv) => {
    const [command, ...rest] = argv
    if (!['generate', 'verify'].includes(command)) throw new Error('Expected generate or verify command')
    const parsed = parseArgs(rest, command)
    if (command === 'generate') {
        generateDeploymentBundle({
            bundleDir: parsed['--bundle-dir'],
            archivePath: parsed['--archive'],
            manifestPath: parsed['--manifest'],
            evidencePath: parsed['--evidence'],
            composePath: parsed['--compose'],
            seccompPath: parsed['--seccomp'],
            wrapperPath: parsed['--wrapper']
        })
        process.stdout.write('Deployment bundle generated and verified.\n')
        return
    }
    verifyDeploymentBundle({
        bundleDir: parsed['--bundle-dir'],
        expectedRevision: parsed['--expected-revision'],
        expectedImageTag: parsed['--expected-image-tag'],
        expectedImageConfigDigest: parsed['--expected-image-config-digest']
    })
    process.stdout.write('Deployment bundle verified.\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runCli(process.argv.slice(2))
    } catch (error) {
        process.stderr.write(`Deployment bundle error: ${error.message}\n`)
        process.exitCode = 1
    }
}
