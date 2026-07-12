import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
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
    verifyManifest,
    verifyManifestFile,
    writeManifestAtomic
} from './release-manifest.mjs'

const MODULE_PATH = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url))
const EDGE_SCRIPT_PATH = fileURLToPath(new URL('./verify-production-edge.sh', import.meta.url))
const SECURITY_SCRIPT_PATH = fileURLToPath(new URL('./verify-security.sh', import.meta.url))
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
    write(repoRoot, 'scripts/verify-release-source.sh', '#!/usr/bin/env bash\nexit 0\n')
    write(repoRoot, 'scripts/verify-security.sh', '#!/usr/bin/env bash\nexit 0\n')
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
        const incomplete = {
            ...manifest,
            inputs: { ...manifest.inputs, files: manifest.inputs.files.slice(0, -1) }
        }
        assert.throws(() => validateManifest(incomplete), /fixed release input path set/)
    } finally {
        fixture.cleanup()
    }
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
