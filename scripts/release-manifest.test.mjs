import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    canonicalStringify,
    generateManifest,
    inspectSource,
    readEnvTemplateKeys,
    sanitizeRepositoryUrl,
    validateImageTag,
    validateManifest,
    validateRevision,
    verifyDockerArchive,
    verifyManifest,
    verifyManifestFile,
    writeManifestAtomic
} from './release-manifest.mjs'

const MODULE_PATH = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url))
const EDGE_SCRIPT_PATH = fileURLToPath(new URL('./verify-production-edge.sh', import.meta.url))
const SECURITY_SCRIPT_PATH = fileURLToPath(new URL('./verify-security.sh', import.meta.url))
const RELEASE_CANDIDATE_SCRIPT_PATH = fileURLToPath(new URL('./verify-release-candidate.sh', import.meta.url))
const CHROMIUM_SANDBOX_SCRIPT_PATH = fileURLToPath(new URL('./verify-chromium-sandbox.sh', import.meta.url))
const PUBLISH_VERIFIED_IMAGE_SCRIPT_PATH = fileURLToPath(new URL('./publish-verified-image.sh', import.meta.url))
const MAIN_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/main.yml', import.meta.url))
const DOCKER_BUILD_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/test_docker_build.yml', import.meta.url))
const DOCKERHUB_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/docker-image-dockerhub.yml', import.meta.url))
const READONLY_MONITOR_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/production-readonly-monitor.yml', import.meta.url))
const CHROMIUM_SECCOMP_PROFILE_PATH = fileURLToPath(new URL('../docker/seccomp/chromium.json', import.meta.url))
const CHROMIUM_SECCOMP_PROFILE_SHA256 = 'a1a19b1ab248ef5835972e3f867613a9aa838266855a3e7e6f8b3feac2eca8d3'
const EXPECTED_TOOLCHAIN = Object.freeze({ node: 'v24.18.0', pnpm: '10.26.0', package_manager: 'pnpm@10.26.0' })
const CONFIG_DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_CONFIG_DIGEST = `sha256:${'b'.repeat(64)}`
const ENV_VALUE_SENTINEL = 'ENV_VALUE_SENTINEL_DO_NOT_LEAK'
const REMOTE_PASSWORD_SENTINEL = 'REMOTE_PASSWORD_SENTINEL'
const REMOTE_QUERY_SENTINEL = 'REMOTE_QUERY_SENTINEL'
const REMOTE_FRAGMENT_SENTINEL = 'REMOTE_FRAGMENT_SENTINEL'
const FIXED_NOW = '2026-07-12T00:00:00.000Z'

const git = (cwd, args) =>
    execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    }).trim()

const write = (root, relativePath, content) => {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
}

const createFixture = ({ credentialRemote = false } = {}) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowise-release-manifest-test-'))
    const repoRoot = join(fixtureRoot, 'repo')
    const archivePath = join(fixtureRoot, 'flowise-image.tar.gz')
    mkdirSync(repoRoot, { recursive: true })

    write(
        repoRoot,
        'package.json',
        `${JSON.stringify(
            {
                name: 'fixture',
                private: true,
                packageManager: 'pnpm@10.26.0',
                engines: { node: '24.18.0', pnpm: '10.26.0' }
            },
            null,
            4
        )}\n`
    )
    write(repoRoot, '.nvmrc', 'v24.18.0\n')
    write(repoRoot, '.npmrc', 'engine-strict = true\n')
    write(repoRoot, 'pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
    write(repoRoot, 'Dockerfile', 'FROM scratch\n')
    write(repoRoot, 'docker-compose.prod.yml', 'services: {}\n')
    write(repoRoot, 'docker/seccomp/chromium.json', '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}\n')
    write(repoRoot, 'scripts/verify-release-source.sh', '#!/usr/bin/env bash\nexit 0\n')
    write(repoRoot, 'scripts/verify-security.sh', '#!/usr/bin/env bash\nexit 0\n')
    copyFileSync(CHROMIUM_SANDBOX_SCRIPT_PATH, join(repoRoot, 'scripts/verify-chromium-sandbox.sh'))
    copyFileSync(PUBLISH_VERIFIED_IMAGE_SCRIPT_PATH, join(repoRoot, 'scripts/publish-verified-image.sh'))
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true })
    copyFileSync(MODULE_PATH, join(repoRoot, 'scripts/release-manifest.mjs'))
    write(repoRoot, '.env.production.template', `ZETA=one\nSECRET_KEY=${ENV_VALUE_SENTINEL}\nALPHA=two\n# COMMENTED_SECRET=ignored\n`)
    writeFileSync(archivePath, 'deterministic archive fixture\n')

    git(repoRoot, ['init', '-q'])
    git(repoRoot, ['config', 'user.name', 'Release Test'])
    git(repoRoot, ['config', 'user.email', 'release-test@example.invalid'])
    git(repoRoot, ['add', '--', '.'])
    git(repoRoot, ['commit', '-q', '-m', 'fixture'])
    const remote = credentialRemote
        ? `https://user:${REMOTE_PASSWORD_SENTINEL}@example.invalid/org/repo.git?token=${REMOTE_QUERY_SENTINEL}#${REMOTE_FRAGMENT_SENTINEL}`
        : 'https://example.invalid/org/repo.git'
    git(repoRoot, ['remote', 'add', 'origin', remote])

    return {
        fixtureRoot,
        repoRoot,
        archivePath,
        revision: git(repoRoot, ['rev-parse', 'HEAD']),
        cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true })
    }
}

const manifestOptions = (fixture, overrides = {}) => ({
    repoRoot: fixture.repoRoot,
    distribution: 'offline_archive',
    imageTag: `flowise-chinese:git-${fixture.revision}`,
    imageConfigDigest: CONFIG_DIGEST,
    archivePath: fixture.archivePath,
    platform: 'linux/amd64',
    allowDirty: false,
    untrackedInputs: [],
    toolchain: EXPECTED_TOOLCHAIN,
    now: FIXED_NOW,
    ...overrides
})

const createDockerArchiveFixture = ({
    revision = '1'.repeat(40),
    tag = `flowise-ci:git-${revision}`,
    source = 'https://github.com/example/flowise',
    version = `git-${revision}`,
    created = '2026-07-12T00:00:00+00:00',
    architecture = 'amd64',
    repoTags,
    labelOverrides = {},
    configPathDigest
} = {}) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowise-docker-archive-test-'))
    const archiveRoot = join(fixtureRoot, 'archive')
    const archivePath = join(fixtureRoot, 'flowise-image.tar.gz')
    mkdirSync(archiveRoot, { recursive: true })

    const config = {
        architecture,
        os: 'linux',
        config: {
            User: 'node',
            WorkingDir: '/usr/src/flowise',
            Cmd: ['node', 'packages/server/bin/run', 'start'],
            Labels: {
                'org.opencontainers.image.source': source,
                'org.opencontainers.image.revision': revision,
                'org.opencontainers.image.version': version,
                'org.opencontainers.image.created': created,
                ...labelOverrides
            }
        }
    }
    const configBytes = Buffer.from(`${JSON.stringify(config)}\n`)
    const actualConfigDigest = createHash('sha256').update(configBytes).digest('hex')
    const configPath = `${configPathDigest ?? actualConfigDigest}.json`
    writeFileSync(join(archiveRoot, configPath), configBytes)
    writeFileSync(join(archiveRoot, 'layer.tar'), 'deterministic layer fixture\n')
    writeFileSync(
        join(archiveRoot, 'manifest.json'),
        `${JSON.stringify([{ Config: configPath, RepoTags: repoTags ?? [tag], Layers: ['layer.tar'] }])}\n`
    )
    execFileSync('tar', ['-czf', archivePath, '-C', archiveRoot, 'manifest.json', configPath, 'layer.tar'])

    return {
        archivePath,
        created,
        revision,
        source,
        tag,
        version,
        actualConfigDigest: `sha256:${actualConfigDigest}`,
        cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true })
    }
}

const assertExternalActionsAreCommitPinned = (workflow, label) => {
    const uses = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+).*$/gm)].map((match) => match[1])
    assert.ok(uses.length > 0, `${label} must use at least one external action`)
    for (const action of uses) {
        if (action.startsWith('./')) continue
        assert.match(action, /^[^@\s]+@[0-9a-f]{40}$/, `${label} action is not commit-pinned: ${action}`)
    }
}

test('action pin validation covers uses beneath named workflow steps', () => {
    assert.throws(
        () => assertExternalActionsAreCommitPinned(`steps:\n  - name: Checkout\n    uses: actions/checkout@v4\n`, 'named-step fixture'),
        /not commit-pinned/
    )
    assert.doesNotThrow(() =>
        assertExternalActionsAreCommitPinned(
            `steps:\n  - name: Checkout\n    uses: actions/checkout@${'a'.repeat(40)}\n`,
            'named-step fixture'
        )
    )
})

test('server startup fails closed when any initialization stage throws', () => {
    const serverSource = readFileSync(fileURLToPath(new URL('../packages/server/src/index.ts', import.meta.url)), 'utf8')
    const initializationCatch = serverSource.match(
        /catch \(error\) \{\s*logger\.error\('❌ \[server\]: Error during Data Source initialization:', error\)([\s\S]*?)\n\s*\}/
    )

    assert.ok(initializationCatch, 'initialization failure handler must remain explicit')
    assert.match(initializationCatch[1], /await this\.stopApp\(\)/)
    assert.match(initializationCatch[1], /await this\.AppDataSource\.destroy\(\)/)
    assert.match(initializationCatch[1], /throw error/)
})

test('canonical JSON recursively sorts object keys and rejects unsupported values', () => {
    assert.equal(
        canonicalStringify({ z: 1, a: { z: 2, a: 1 }, list: [{ z: 2, a: 1 }] }),
        '{"a":{"a":1,"z":2},"list":[{"a":1,"z":2}],"z":1}\n'
    )
    assert.throws(() => canonicalStringify({ value: Number.NaN }), /canonical JSON/)
    assert.throws(() => canonicalStringify({ value: undefined }), /canonical JSON/)
})

test('revision and image tags must be exact immutable Git-derived identities', () => {
    const revision = '1'.repeat(40)
    assert.equal(validateRevision(revision), revision)
    for (const invalid of ['1'.repeat(39), 'A'.repeat(40), 'z'.repeat(40)]) {
        assert.throws(() => validateRevision(invalid), /40-character lowercase Git revision/)
    }

    assert.doesNotThrow(() => validateImageTag(`registry.invalid/flowise:git-${revision}`, `git-${revision}`))
    for (const invalid of [
        'flowise',
        'flowise:latest',
        'flowise:candidate',
        `https://registry.invalid/flowise:git-${revision}`,
        `FLOWISE:git-${revision}`,
        `/absolute/path:git-${revision}`,
        `flowise@sha256:${'2'.repeat(64)}`,
        `flowise:git-${'2'.repeat(40)}`
    ]) {
        assert.throws(() => validateImageTag(invalid, `git-${revision}`), /immutable Git-derived tag/)
    }
})

test('Docker archive verification derives config identity and binds tag, platform, runtime and OCI labels', () => {
    const fixture = createDockerArchiveFixture()
    try {
        const result = verifyDockerArchive({
            archivePath: fixture.archivePath,
            imageTag: fixture.tag,
            revision: fixture.revision,
            source: fixture.source,
            version: fixture.version,
            created: fixture.created,
            platform: 'linux/amd64'
        })
        assert.equal(result.imageConfigDigest, fixture.actualConfigDigest)
        assert.equal(result.imageTag, fixture.tag)
        assert.equal(result.platform, 'linux/amd64')
    } finally {
        fixture.cleanup()
    }
})

test('Docker archive verification rejects a manifest-supplied tag or revision that is not in the archive', () => {
    const wrongTag = createDockerArchiveFixture({ repoTags: ['flowise-ci:git-2222222222222222222222222222222222222222'] })
    try {
        assert.throws(
            () =>
                verifyDockerArchive({
                    archivePath: wrongTag.archivePath,
                    imageTag: wrongTag.tag,
                    revision: wrongTag.revision,
                    source: wrongTag.source,
                    version: wrongTag.version,
                    created: wrongTag.created,
                    platform: 'linux/amd64'
                }),
            /archive tag mismatch/
        )
    } finally {
        wrongTag.cleanup()
    }

    const wrongRevision = createDockerArchiveFixture({
        labelOverrides: { 'org.opencontainers.image.revision': '2'.repeat(40) }
    })
    try {
        assert.throws(
            () =>
                verifyDockerArchive({
                    archivePath: wrongRevision.archivePath,
                    imageTag: wrongRevision.tag,
                    revision: wrongRevision.revision,
                    source: wrongRevision.source,
                    version: wrongRevision.version,
                    created: wrongRevision.created,
                    platform: 'linux/amd64'
                }),
            /revision label mismatch/
        )
    } finally {
        wrongRevision.cleanup()
    }
})

test('Docker archive verification rejects a mismatched config digest and platform', () => {
    const wrongDigest = createDockerArchiveFixture({ configPathDigest: 'f'.repeat(64) })
    try {
        assert.throws(
            () =>
                verifyDockerArchive({
                    archivePath: wrongDigest.archivePath,
                    imageTag: wrongDigest.tag,
                    revision: wrongDigest.revision,
                    source: wrongDigest.source,
                    version: wrongDigest.version,
                    created: wrongDigest.created,
                    platform: 'linux/amd64'
                }),
            /config content hash mismatch/
        )
    } finally {
        wrongDigest.cleanup()
    }

    const wrongPlatform = createDockerArchiveFixture({ architecture: 'arm64' })
    try {
        assert.throws(
            () =>
                verifyDockerArchive({
                    archivePath: wrongPlatform.archivePath,
                    imageTag: wrongPlatform.tag,
                    revision: wrongPlatform.revision,
                    source: wrongPlatform.source,
                    version: wrongPlatform.version,
                    created: wrongPlatform.created,
                    platform: 'linux/amd64'
                }),
            /platform mismatch/
        )
    } finally {
        wrongPlatform.cleanup()
    }
})

test('verify-archive CLI emits only the independently derived config digest', () => {
    const fixture = createDockerArchiveFixture()
    try {
        const result = spawnSync(
            process.execPath,
            [
                MODULE_PATH,
                'verify-archive',
                '--archive',
                fixture.archivePath,
                '--image-tag',
                fixture.tag,
                '--revision',
                fixture.revision,
                '--source',
                fixture.source,
                '--version',
                fixture.version,
                '--created',
                fixture.created,
                '--platform',
                'linux/amd64'
            ],
            { encoding: 'utf8' }
        )
        assert.equal(result.status, 0, result.stderr)
        assert.equal(result.stdout, `${fixture.actualConfigDigest}\n`)
        assert.equal(result.stderr, '')
    } finally {
        fixture.cleanup()
    }
})

test('clean manifest is stable, canonical, sanitized, key-only and verifiable', () => {
    const fixture = createFixture({ credentialRemote: true })
    try {
        const manifest = generateManifest(manifestOptions(fixture))
        assert.equal(manifest.release_id, `git-${fixture.revision}`)
        assert.deepEqual(manifest.source.tracked_patch, null)
        assert.deepEqual(manifest.source.untracked, [])
        assert.equal(manifest.source.dirty_digest, null)
        assert.equal(manifest.boundaries.stable, true)
        assert.equal(manifest.source.repository_url, 'https://example.invalid/org/repo.git')
        assert.deepEqual(manifest.inputs.env_template.keys, ['ALPHA', 'SECRET_KEY', 'ZETA'])
        assert.equal(canonicalStringify(manifest).includes(ENV_VALUE_SENTINEL), false)
        for (const sentinel of [REMOTE_PASSWORD_SENTINEL, REMOTE_QUERY_SENTINEL, REMOTE_FRAGMENT_SENTINEL]) {
            assert.equal(canonicalStringify(manifest).includes(sentinel), false)
        }
        assert.equal(canonicalStringify(manifest).includes(fixture.fixtureRoot), false)

        assert.doesNotThrow(() =>
            verifyManifest({
                repoRoot: fixture.repoRoot,
                manifest,
                imageTag: manifest.image.tag,
                imageConfigDigest: CONFIG_DIGEST,
                archivePath: fixture.archivePath,
                requireClean: true,
                toolchain: EXPECTED_TOOLCHAIN
            })
        )
    } finally {
        fixture.cleanup()
    }
})

test('env template hash is sorted, key-only and independent of RHS values', () => {
    const fixture = createFixture()
    try {
        const first = readEnvTemplateKeys(join(fixture.repoRoot, '.env.production.template'))
        write(fixture.repoRoot, '.env.production.template', 'ALPHA=replaced\nZETA=changed\nSECRET_KEY=SECOND_VALUE_SENTINEL\n')
        const second = readEnvTemplateKeys(join(fixture.repoRoot, '.env.production.template'))
        assert.deepEqual(second.keys, first.keys)
        assert.equal(second.keys_digest, first.keys_digest)
        assert.equal(canonicalStringify(second).includes('SECOND_VALUE_SENTINEL'), false)

        write(fixture.repoRoot, '.env.production.template', 'DUPLICATE=one\nDUPLICATE=two\n')
        assert.throws(() => readEnvTemplateKeys(join(fixture.repoRoot, '.env.production.template')), /duplicate env template key/)
    } finally {
        fixture.cleanup()
    }
})

test('dirty state is denied by default and tracked changes use explicit non-stable identity', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# tracked change\n')
        assert.throws(() => inspectSource({ repoRoot: fixture.repoRoot, allowDirty: false, untrackedInputs: [] }), /--allow-dirty/)

        const inspected = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: [] })
        assert.match(inspected.release_id, new RegExp(`^dirty-${fixture.revision.slice(0, 12)}-[0-9a-f]{12}$`))
        assert.equal(inspected.source.state, 'dirty')
        assert.equal(inspected.source.tracked_patch.bytes > 0, true)
        assert.deepEqual(inspected.source.untracked, [])

        const manifest = generateManifest(
            manifestOptions(fixture, {
                imageTag: `flowise-chinese:${inspected.release_id}`,
                allowDirty: true
            })
        )
        assert.equal(manifest.boundaries.stable, false)
        assert.equal(manifest.release_id, inspected.release_id)
    } finally {
        fixture.cleanup()
    }
})

test('untracked-only and mixed dirty sources require an exact explicit allow-list', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'release-input.txt', 'first\n')
        assert.throws(
            () => inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: [] }),
            /Unexpected untracked release input/
        )

        const first = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['release-input.txt'] })
        assert.equal(first.source.tracked_patch.bytes, 0)
        assert.deepEqual(
            first.source.untracked.map((entry) => entry.path),
            ['release-input.txt']
        )

        write(fixture.repoRoot, 'release-input.txt', 'second\n')
        const second = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['release-input.txt'] })
        assert.notEqual(second.release_id, first.release_id)

        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# mixed\n')
        const mixed = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['release-input.txt'] })
        assert.equal(mixed.source.tracked_patch.bytes > 0, true)
        assert.equal(mixed.source.untracked.length, 1)
        assert.notEqual(mixed.release_id, second.release_id)
    } finally {
        fixture.cleanup()
    }
})

test('secret-like, traversal, symlink and directory untracked inputs fail closed', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, '.env.production', 'SECRET=UNREAD_SECRET_SENTINEL\n')
        let error
        try {
            inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['.env.production'] })
        } catch (caught) {
            error = caught
        }
        assert.match(error.message, /Unsafe release input path/)
        assert.equal(error.message.includes('UNREAD_SECRET_SENTINEL'), false)

        write(fixture.repoRoot, '.env.secrets/payload.txt', 'NESTED_UNREAD_SECRET_SENTINEL\n')
        assert.throws(
            () =>
                inspectSource({
                    repoRoot: fixture.repoRoot,
                    allowDirty: true,
                    untrackedInputs: ['.env.secrets/payload.txt']
                }),
            /Unsafe release input path/
        )

        assert.throws(
            () => inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['../outside'] }),
            /Unsafe release input path/
        )

        write(fixture.repoRoot, 'target.txt', 'target\n')
        symlinkSync('target.txt', join(fixture.repoRoot, 'link.txt'))
        assert.throws(
            () => inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['link.txt', 'target.txt'] }),
            /regular non-symlink file/
        )

        mkdirSync(join(fixture.repoRoot, 'release-directory'))
        assert.throws(
            () => inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['release-directory'] }),
            /regular non-symlink file/
        )
    } finally {
        fixture.cleanup()
    }
})

test('verification detects patch, archive, image config and toolchain mismatches', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# first change\n')
        const inspected = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: [] })
        const manifest = generateManifest(
            manifestOptions(fixture, { imageTag: `flowise-chinese:${inspected.release_id}`, allowDirty: true })
        )

        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# second change\n')
        assert.throws(
            () =>
                verifyManifest({
                    repoRoot: fixture.repoRoot,
                    manifest,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    toolchain: EXPECTED_TOOLCHAIN
                }),
            /source state mismatch/
        )

        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# first change\n')
        writeFileSync(fixture.archivePath, 'mutated archive\n')
        assert.throws(
            () =>
                verifyManifest({
                    repoRoot: fixture.repoRoot,
                    manifest,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    toolchain: EXPECTED_TOOLCHAIN
                }),
            /archive mismatch/
        )

        writeFileSync(fixture.archivePath, 'deterministic archive fixture\n')
        assert.throws(
            () =>
                verifyManifest({
                    repoRoot: fixture.repoRoot,
                    manifest,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: OTHER_CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    toolchain: EXPECTED_TOOLCHAIN
                }),
            /image config digest mismatch/
        )
        assert.throws(
            () =>
                verifyManifest({
                    repoRoot: fixture.repoRoot,
                    manifest,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    toolchain: { ...EXPECTED_TOOLCHAIN, node: 'v24.17.0' }
                }),
            /toolchain mismatch/
        )
    } finally {
        fixture.cleanup()
    }
})

test('schema rejects unknown and contradictory clean/dirty or side-effect fields', () => {
    const fixture = createFixture()
    try {
        const manifest = generateManifest(manifestOptions(fixture))
        assert.throws(() => validateManifest({ ...manifest, unknown: true }), /unknown manifest field/)
        assert.throws(
            () =>
                validateManifest({
                    ...manifest,
                    source: { ...manifest.source, tracked_patch: { digest: `sha256:${'c'.repeat(64)}`, bytes: 1 } }
                }),
            /clean source invariant/
        )
        assert.throws(
            () => validateManifest({ ...manifest, boundaries: { ...manifest.boundaries, provider_call: true } }),
            /boundary invariant/
        )
    } finally {
        fixture.cleanup()
    }
})

test('schema recomputes dirty digest from the tracked patch and untracked envelope', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# dirty digest\n')
        const inspected = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: [] })
        const manifest = generateManifest(
            manifestOptions(fixture, { imageTag: `flowise-chinese:${inspected.release_id}`, allowDirty: true })
        )
        const forgedDigest = `sha256:${'c'.repeat(64)}`
        const forgedReleaseId = `dirty-${fixture.revision.slice(0, 12)}-${'c'.repeat(12)}`
        const forged = {
            ...manifest,
            release_id: forgedReleaseId,
            source: { ...manifest.source, dirty_digest: forgedDigest },
            image: { ...manifest.image, tag: `flowise-chinese:${forgedReleaseId}` }
        }
        assert.throws(() => validateManifest(forged), /dirty source digest mismatch/)
    } finally {
        fixture.cleanup()
    }
})

test('schema rejects duplicate untracked source entries', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'release-input.txt', 'explicit\n')
        const inspected = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: ['release-input.txt'] })
        const manifest = generateManifest(
            manifestOptions(fixture, {
                imageTag: `flowise-chinese:${inspected.release_id}`,
                allowDirty: true,
                untrackedInputs: ['release-input.txt']
            })
        )
        const duplicate = {
            ...manifest,
            source: { ...manifest.source, untracked: [...manifest.source.untracked, manifest.source.untracked[0]] }
        }
        assert.throws(() => validateManifest(duplicate), /sorted and unique/)
    } finally {
        fixture.cleanup()
    }
})

test('schema requires the exact fixed release input path set', () => {
    const fixture = createFixture()
    try {
        const manifest = generateManifest(manifestOptions(fixture))
        assert.equal(
            manifest.inputs.files.some((entry) => entry.path === 'docker/seccomp/chromium.json'),
            true
        )
        assert.equal(
            manifest.inputs.files.some((entry) => entry.path === 'scripts/verify-chromium-sandbox.sh'),
            true
        )
        const incomplete = {
            ...manifest,
            inputs: { ...manifest.inputs, files: manifest.inputs.files.slice(0, -1) }
        }
        assert.throws(() => validateManifest(incomplete), /fixed release input path set/)
    } finally {
        fixture.cleanup()
    }
})

test('Chromium seccomp profile pins the reviewed sandbox operations and keeps clone3 on the filterable clone fallback', () => {
    const profileBytes = readFileSync(CHROMIUM_SECCOMP_PROFILE_PATH)
    assert.equal(createHash('sha256').update(profileBytes).digest('hex'), CHROMIUM_SECCOMP_PROFILE_SHA256)
    const profile = JSON.parse(profileBytes)
    assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO')
    assert.equal(profile.defaultErrnoRet, 1)

    const sandboxRules = profile.syscalls.slice(-5)
    assert.deepEqual(sandboxRules, [
        {
            names: ['clone'],
            action: 'SCMP_ACT_ALLOW',
            args: [{ index: 0, value: 2114060288, valueTwo: 268435456, op: 'SCMP_CMP_MASKED_EQ' }],
            excludes: { arches: ['s390', 's390x'] }
        },
        {
            names: ['clone'],
            action: 'SCMP_ACT_ALLOW',
            args: [{ index: 0, value: 2114060288, valueTwo: 536870912, op: 'SCMP_CMP_MASKED_EQ' }],
            excludes: { arches: ['s390', 's390x'] }
        },
        {
            names: ['clone'],
            action: 'SCMP_ACT_ALLOW',
            args: [{ index: 0, value: 2114060288, valueTwo: 1879048192, op: 'SCMP_CMP_MASKED_EQ' }],
            excludes: { arches: ['s390', 's390x'] }
        },
        {
            names: ['unshare'],
            action: 'SCMP_ACT_ALLOW',
            args: [{ index: 0, value: 2114060288, valueTwo: 268435456, op: 'SCMP_CMP_MASKED_EQ' }]
        },
        {
            names: ['chroot'],
            action: 'SCMP_ACT_ALLOW'
        }
    ])

    const socketcallRule = profile.syscalls.find((rule) => rule.names?.length === 1 && rule.names[0] === 'socketcall')
    assert.equal(socketcallRule?.action, 'SCMP_ACT_ERRNO')
    assert.equal(socketcallRule?.errnoRet, 38)
    const clone3Rule = profile.syscalls.find((rule) => rule.names?.length === 1 && rule.names[0] === 'clone3')
    assert.deepEqual(clone3Rule, {
        names: ['clone3'],
        action: 'SCMP_ACT_ERRNO',
        errnoRet: 38,
        excludes: { caps: ['CAP_SYS_ADMIN'] }
    })
})

test('manifest files are atomically canonical and non-canonical bytes are rejected', () => {
    const fixture = createFixture()
    try {
        const manifest = generateManifest(manifestOptions(fixture))
        const manifestPath = join(fixture.fixtureRoot, 'release-manifest.json')
        writeManifestAtomic(manifestPath, manifest)
        assert.equal(readFileSync(manifestPath, 'utf8'), canonicalStringify(manifest))
        assert.equal(
            readdirSync(fixture.fixtureRoot).some((name) => name.includes('.tmp')),
            false
        )
        assert.doesNotThrow(() =>
            verifyManifestFile({
                repoRoot: fixture.repoRoot,
                manifestPath,
                imageTag: manifest.image.tag,
                imageConfigDigest: CONFIG_DIGEST,
                archivePath: fixture.archivePath,
                requireClean: true,
                toolchain: EXPECTED_TOOLCHAIN
            })
        )

        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
        assert.throws(
            () =>
                verifyManifestFile({
                    repoRoot: fixture.repoRoot,
                    manifestPath,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    requireClean: true,
                    toolchain: EXPECTED_TOOLCHAIN
                }),
            /canonical JSON/
        )
    } finally {
        fixture.cleanup()
    }
})

test('CLI output never leaks env RHS or remote credentials', () => {
    const fixture = createFixture({ credentialRemote: true })
    try {
        const outPath = join(fixture.fixtureRoot, 'cli-manifest.json')
        const result = spawnSync(
            process.execPath,
            [
                MODULE_PATH,
                'generate',
                '--distribution',
                'offline_archive',
                '--image-tag',
                `flowise-chinese:git-${fixture.revision}`,
                '--image-config-digest',
                CONFIG_DIGEST,
                '--archive',
                fixture.archivePath,
                '--platform',
                'linux/amd64',
                '--out',
                outPath
            ],
            { cwd: fixture.repoRoot, encoding: 'utf8' }
        )
        assert.equal(result.status, 0, result.stderr)
        const combined = `${result.stdout}\n${result.stderr}\n${readFileSync(outPath, 'utf8')}`
        for (const sentinel of [
            ENV_VALUE_SENTINEL,
            REMOTE_PASSWORD_SENTINEL,
            REMOTE_QUERY_SENTINEL,
            REMOTE_FRAGMENT_SENTINEL,
            fixture.fixtureRoot
        ]) {
            assert.equal(combined.includes(sentinel), false)
        }
    } finally {
        fixture.cleanup()
    }
})

test('production edge rejects credential-bearing URLs without logging submitted values', () => {
    const sentinels = ['EDGE_PASSWORD_SENTINEL', 'EDGE_QUERY_SENTINEL', 'EDGE_FRAGMENT_SENTINEL']
    const result = spawnSync(
        'bash',
        [EDGE_SCRIPT_PATH, `https://review:${sentinels[0]}@127.0.0.1:1/base?token=${sentinels[1]}#${sentinels[2]}`],
        { encoding: 'utf8' }
    )
    assert.equal(result.status, 2)
    const combined = `${result.stdout}\n${result.stderr}`
    for (const sentinel of sentinels) assert.equal(combined.includes(sentinel), false)
})

test('production env preflight rejects an all-zero dirty image identity', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowise-release-env-preflight-test-'))
    const envPath = join(fixtureRoot, '.env.production')
    try {
        writeFileSync(envPath, 'FLOWISE_IMAGE=flowise-chinese:dirty-000000000000-000000000000\n')
        const result = spawnSync('bash', [SECURITY_SCRIPT_PATH, envPath], { encoding: 'utf8' })
        assert.equal(result.status, 1)
        assert.match(result.stdout, /FAIL FLOWISE_IMAGE must replace the all-zero dirty identity/)
        assert.doesNotMatch(result.stdout, /PASS FLOWISE_IMAGE uses an explicit non-stable dirty identity/)
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
    }
})

test('production env preflight rejects unreviewed Tool Function dependencies', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowise-release-tool-deps-preflight-test-'))
    const envPath = join(fixtureRoot, '.env.production')
    const strongSecret = 'a'.repeat(64)
    const validEnv = [
        `FLOWISE_IMAGE=flowise-chinese:git-${'a'.repeat(40)}`,
        'POSTGRES_IMAGE=postgres:16-alpine',
        'NODE_ENV=production',
        'SECURE_COOKIES=true',
        'TRUST_PROXY=1',
        'APP_URL=https://flowise.example.invalid',
        `POSTGRES_PASSWORD=${strongSecret}`,
        `JWT_AUTH_TOKEN_SECRET=${strongSecret}`,
        `JWT_REFRESH_TOKEN_SECRET=${strongSecret}`,
        `EXPRESS_SESSION_SECRET=${strongSecret}`,
        `TOKEN_HASH_SECRET=${strongSecret}`,
        `FLOWISE_SECRETKEY_OVERWRITE=${strongSecret}`,
        'CORS_ORIGINS=https://flowise.example.invalid',
        'IFRAME_ORIGINS="\'self\'"',
        'CSP_ENFORCEMENT_MODE=compat',
        'CSP_REPORT_ONLY_MODE=off',
        'HTTP_SECURITY_CHECK=true',
        'PATH_TRAVERSAL_SAFETY=true',
        'CUSTOM_MCP_SECURITY_CHECK=true',
        'CUSTOM_MCP_ALLOWED_COMMANDS=',
        'OAUTH2_SECURITY_CHECK=true',
        'DATABASE_REJECT_UNAUTHORIZED=true',
        'CORS_ALLOW_CREDENTIALS=false',
        'ALLOW_BUILTIN_DEP=false',
        'LOG_SANITIZE_BODY_FIELDS=password,secret,token',
        'TOOL_FUNCTION_BUILTIN_DEP=',
        'TOOL_FUNCTION_EXTERNAL_DEP=pg,puppeteer,playwright',
        'LOG_LEVEL=warn'
    ].join('\n')

    try {
        writeFileSync(envPath, `${validEnv}\n`)
        const result = spawnSync('bash', [SECURITY_SCRIPT_PATH, envPath], { encoding: 'utf8' })
        assert.equal(result.status, 1)
        assert.match(result.stdout, /FAIL TOOL_FUNCTION_EXTERNAL_DEP must remain empty until separately reviewed and authorized/)
        assert.doesNotMatch(result.stdout, /PASS TOOL_FUNCTION_EXTERNAL_DEP is empty/)
    } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
    }
})

test('URL sanitizer removes credentials, query and fragment and rejects unsafe protocols', () => {
    assert.equal(
        sanitizeRepositoryUrl(
            `https://user:${REMOTE_PASSWORD_SENTINEL}@example.invalid/org/repo.git?token=${REMOTE_QUERY_SENTINEL}#${REMOTE_FRAGMENT_SENTINEL}`
        ),
        'https://example.invalid/org/repo.git'
    )
    assert.equal(sanitizeRepositoryUrl('git@example.invalid:org/repo.git'), 'ssh://example.invalid/org/repo.git')
    assert.throws(() => sanitizeRepositoryUrl('http://example.invalid/org/repo.git'), /Unsupported repository URL/)
    assert.throws(() => sanitizeRepositoryUrl('file:///tmp/repo'), /Unsupported repository URL/)
})

test('dirty manifest is rejected by require-clean verification', () => {
    const fixture = createFixture()
    try {
        write(fixture.repoRoot, 'Dockerfile', 'FROM scratch\n# dirty\n')
        const inspected = inspectSource({ repoRoot: fixture.repoRoot, allowDirty: true, untrackedInputs: [] })
        const manifest = generateManifest(
            manifestOptions(fixture, { imageTag: `flowise-chinese:${inspected.release_id}`, allowDirty: true })
        )
        assert.throws(
            () =>
                verifyManifest({
                    repoRoot: fixture.repoRoot,
                    manifest,
                    imageTag: manifest.image.tag,
                    imageConfigDigest: CONFIG_DIGEST,
                    archivePath: fixture.archivePath,
                    requireClean: true,
                    toolchain: EXPECTED_TOOLCHAIN
                }),
            /clean source is required/
        )
    } finally {
        fixture.cleanup()
    }
})

test('main CI retains full coverage while bounding workspace and Jest concurrency for hosted-runner memory safety', () => {
    const workflow = readFileSync(MAIN_WORKFLOW_PATH, 'utf8')

    assert.match(workflow, /^\s*run:\s*pnpm exec turbo run test:coverage --concurrency=1 -- --runInBand\s*$/m)
    assert.doesNotMatch(workflow, /^\s*run:\s*pnpm test:coverage\s*$/m)
    const cypressStep = workflow.match(/^ {12}- name: Cypress test\n(?:^ {14,}.*(?:\n|$))+/m)?.[0]
    assert.ok(cypressStep, 'main CI must retain the Cypress test step')
    assert.match(cypressStep, /^ {18}ADMIN_ONLY_MODE: 'false'\s*$/m)
    assert.equal(workflow.match(/^\s+ADMIN_ONLY_MODE: 'false'\s*$/gm)?.length, 1)

    for (const workspace of ['agentflow', 'observe', 'components', 'server']) {
        const packageJsonPath = fileURLToPath(new URL(`../packages/${workspace}/package.json`, import.meta.url))
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        assert.equal(packageJson.scripts?.['test:coverage'], 'jest --coverage', `${workspace} must retain full coverage`)
    }
})

test('build-only Docker CI produces and reconsumes a canonical offline release artifact without registry side effects', () => {
    const workflow = readFileSync(DOCKER_BUILD_WORKFLOW_PATH, 'utf8')
    const candidateScript = readFileSync(RELEASE_CANDIDATE_SCRIPT_PATH, 'utf8')

    for (const required of [
        'permissions:',
        'contents: read',
        'concurrency:',
        'timeout-minutes:',
        'runs-on: ubuntu-24.04',
        'test "$(uname -m)" = x86_64',
        'platforms: linux/amd64',
        'load: true',
        'push: false',
        'provenance: false',
        'CANDIDATE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
        'ref: ${{ env.CANDIDATE_SHA }}',
        'persist-credentials: false',
        'git ls-files --error-unmatch',
        'pnpm audit --prod --audit-level critical',
        'bash scripts/verify-release-candidate.sh',
        'actions/upload-artifact@',
        "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
        '${{ github.run_id }}',
        '${{ github.run_attempt }}',
        'retention-days: 3',
        'if-no-files-found: error'
    ]) {
        assert.equal(workflow.includes(required), true, `missing build-only workflow contract: ${required}`)
    }

    for (const required of [
        'flowise-ci:git-',
        'node scripts/release-manifest.mjs generate',
        'node scripts/release-manifest.mjs verify',
        'node scripts/release-manifest.mjs verify-archive',
        '--require-clean',
        'docker image rm',
        '--network none',
        '--init',
        '--read-only',
        '--cap-drop ALL',
        'no-new-privileges',
        '--user 1000:1000',
        '--pids-limit 512',
        '/api/v1/ping',
        'scripts/verify-chromium-sandbox.sh',
        'chromium_sandbox=passed',
        'clone3_namespace=blocked_enosys',
        'unsafe_chromium_flags=false'
    ]) {
        assert.equal(candidateScript.includes(required), true, `missing release candidate script contract: ${required}`)
    }

    const chromiumScript = readFileSync(CHROMIUM_SANDBOX_SCRIPT_PATH, 'utf8')
    const combined = `${workflow}\n${candidateScript}\n${chromiumScript}`
    assert.doesNotMatch(combined, /docker\/login-action|push:\s*true|secrets\./)
    assert.doesNotMatch(chromiumScript, /--no-sandbox|--disable-setuid-sandbox|seccomp=unconfined|--cap-add|--privileged/)
    assert.doesNotMatch(candidateScript, /config_digest=.*docker image inspect --format '\{\{\.Id\}\}'/)
    assert.doesNotMatch(workflow, /pnpm audit[^\n]*(?:\|\||;\s*true)/)
    assert.doesNotMatch(workflow, /^ {12}[A-Z_]+:\s*\$\{\{\s*runner\.temp\b/gm)
    assertExternalActionsAreCommitPinned(workflow, 'build-only release workflow')
})

test('manual release-readiness verification is main-only, environment-gated and read-only', () => {
    const workflow = readFileSync(DOCKER_BUILD_WORKFLOW_PATH, 'utf8')

    for (const required of [
        "github.event_name == 'workflow_dispatch'",
        "github.ref == 'refs/heads/main'",
        'name: release-readiness',
        'actions/download-artifact@',
        'expected_tag="flowise-ci:git-${GITHUB_SHA}"',
        'expected_source="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"',
        'expected_version="git-${GITHUB_SHA}"',
        'expected_created="$(git show -s --format=%cI "$GITHUB_SHA")"',
        'node scripts/release-manifest.mjs verify-archive',
        'node scripts/release-manifest.mjs verify',
        'docker image load --input "$ARCHIVE_PATH"',
        'docker image rm "$expected_tag"',
        '--require-clean'
    ]) {
        assert.equal(workflow.includes(required), true, `missing release-readiness contract: ${required}`)
    }

    assert.doesNotMatch(workflow, /deploy|docker\/login-action|push:\s*true|secrets\./i)
    assert.doesNotMatch(workflow, /manifest\.image\.(?:tag|config_digest)/)
})

test('Docker Hub publishing validates a reviewed alias before credentials and builds only the canonical root Dockerfile', () => {
    const workflow = readFileSync(DOCKERHUB_WORKFLOW_PATH, 'utf8')

    for (const required of [
        'type: string',
        'environment:',
        'name: dockerhub-release',
        'PUBLISH_ENABLED: ${{ vars.DOCKERHUB_RELEASE_ENABLED }}',
        'PUBLISH_IMAGE: ${{ vars.DOCKERHUB_IMAGE }}',
        'test "$PUBLISH_ENABLED" = \'true\'',
        'TAG_VERSION: ${{ inputs.tag_version }}',
        "if: github.ref == 'refs/heads/main'",
        '[[ ${#TAG_VERSION} -le 128 ]]',
        '[[ "$TAG_VERSION" =~',
        'file: Dockerfile',
        'platforms: linux/amd64',
        'pnpm audit --prod --audit-level high',
        'git ls-files --error-unmatch',
        'load: true',
        'push: false',
        'bash scripts/verify-release-candidate.sh',
        'git tag --format=',
        'BUILD_REVISION=${{ github.sha }}',
        'BUILD_VERSION=git-${{ github.sha }}',
        'docker/login-action@',
        'https://hub.docker.com/v2/auth/token',
        "jq -er '.access_token'",
        'node scripts/verify-dockerhub-immutability.mjs',
        'https://hub.docker.com/v2/namespaces/${namespace}/repositories/${repository}',
        'bash scripts/publish-verified-image.sh',
        '--manifest "$MANIFEST_PATH"',
        '--immutability-settings "$IMMUTABILITY_SETTINGS_PATH"'
    ]) {
        assert.equal(workflow.includes(required), true, `missing hardened Docker Hub contract: ${required}`)
    }

    assert.doesNotMatch(
        workflow,
        /default:\s*['"]?latest|docker\/Dockerfile|docker\/worker\/Dockerfile|npm install -g flowise|push:\s*true/
    )
    assert.doesNotMatch(workflow, /PUBLISH_IMAGE:\s*flowiseai\/flowise/)
    assert.doesNotMatch(workflow, /\/v2\/users\/login\//)
    assert.match(workflow, /\[\[ "\$PUBLISH_IMAGE" != flowiseai\/\* \]\]/)
    assert.match(workflow, /test "\$\{PUBLISH_IMAGE%%\/\*\}" = "\$registry_username"/)
    assert.doesNotMatch(workflow, /docker push/)
    assert.doesNotMatch(workflow, /pnpm audit[^\n]*(?:\|\||;\s*true)/)
    assert.doesNotMatch(workflow, /^ {12}[A-Z_]+:\s*\$\{\{\s*runner\.temp\b/gm)
    assert.equal((workflow.match(/\$\{\{ inputs\.tag_version \}\}/g) ?? []).length, 1)
    assert.ok(workflow.indexOf('bash scripts/verify-release-candidate.sh') < workflow.indexOf('docker/login-action@'))
    assert.ok(workflow.indexOf('node scripts/verify-dockerhub-immutability.mjs') < workflow.indexOf('docker/login-action@'))
    assertExternalActionsAreCommitPinned(workflow, 'Docker Hub publishing workflow')
})

test('scheduled production monitor performs only public edge and TLS expiry checks', () => {
    const workflow = readFileSync(READONLY_MONITOR_WORKFLOW_PATH, 'utf8')

    for (const required of [
        'schedule:',
        'workflow_dispatch:',
        'permissions:',
        'contents: read',
        'concurrency:',
        'timeout-minutes:',
        'bash scripts/verify-production-edge.sh https://flowise.lute-tlz-dddd.top',
        'openssl s_client',
        'openssl x509',
        '-checkend'
    ]) {
        assert.equal(workflow.includes(required), true, `missing public monitor contract: ${required}`)
    }

    assert.doesNotMatch(workflow, /secrets\.|\bssh\b|provider|smtp|\/prediction/i)
    assertExternalActionsAreCommitPinned(workflow, 'production read-only monitor')
})
