import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { generateDeploymentBundle, verifyDeploymentBundle } from './deployment-bundle.mjs'
import { canonicalStringify, generateManifest, writeManifestAtomic } from './release-manifest.mjs'

const DEPLOYMENT_MODULE_PATH = fileURLToPath(new URL('./deployment-bundle.mjs', import.meta.url))
const MANIFEST_MODULE_PATH = fileURLToPath(new URL('./release-manifest.mjs', import.meta.url))
const PUBLISH_SCRIPT_PATH = fileURLToPath(new URL('./publish-verified-image.sh', import.meta.url))
const CHROMIUM_SCRIPT_PATH = fileURLToPath(new URL('./verify-chromium-sandbox.sh', import.meta.url))
const CANDIDATE_SCRIPT_PATH = fileURLToPath(new URL('./verify-release-candidate.sh', import.meta.url))
const CONFIG_DIGEST = `sha256:${'a'.repeat(64)}`
const TOOLCHAIN = Object.freeze({ node: 'v24.18.0', pnpm: '10.26.0', package_manager: 'pnpm@10.26.0' })
const FIXED_NOW = '2026-07-27T00:00:00.000Z'

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')

const write = (root, relativePath, contents) => {
    const target = join(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
    return target
}

const runGit = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const createFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'flowise-deployment-bundle-test-'))
    const repoRoot = join(root, 'repo')
    const bundleDir = join(root, 'bundle')
    mkdirSync(repoRoot, { recursive: true })
    mkdirSync(bundleDir, { mode: 0o700 })

    write(
        repoRoot,
        'package.json',
        `${JSON.stringify(
            {
                name: 'bundle-fixture',
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
    const composePath = write(repoRoot, 'docker-compose.prod.yml', 'services:\n    flowise:\n        image: ${FLOWISE_IMAGE}\n')
    const seccompPath = write(repoRoot, 'docker/seccomp/chromium.json', '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}\n')
    const wrapperPath = write(repoRoot, 'scripts/flowise-production-release.py', '#!/usr/bin/env python3\nraise SystemExit(0)\n')
    write(repoRoot, 'scripts/verify-release-source.sh', '#!/usr/bin/env bash\nexit 0\n')
    write(repoRoot, 'scripts/verify-security.sh', '#!/usr/bin/env bash\nexit 0\n')
    copyFileSync(DEPLOYMENT_MODULE_PATH, join(repoRoot, 'scripts/deployment-bundle.mjs'))
    copyFileSync(MANIFEST_MODULE_PATH, join(repoRoot, 'scripts/release-manifest.mjs'))
    copyFileSync(PUBLISH_SCRIPT_PATH, join(repoRoot, 'scripts/publish-verified-image.sh'))
    copyFileSync(CHROMIUM_SCRIPT_PATH, join(repoRoot, 'scripts/verify-chromium-sandbox.sh'))
    copyFileSync(CANDIDATE_SCRIPT_PATH, join(repoRoot, 'scripts/verify-release-candidate.sh'))
    write(repoRoot, '.env.production.template', 'FLOWISE_IMAGE=\nPOSTGRES_PASSWORD=\n')

    runGit(repoRoot, ['init', '-q'])
    runGit(repoRoot, ['config', 'user.name', 'Bundle Test'])
    runGit(repoRoot, ['config', 'user.email', 'bundle-test@example.invalid'])
    runGit(repoRoot, ['add', '--', '.'])
    runGit(repoRoot, ['commit', '-q', '-m', 'fixture'])
    runGit(repoRoot, ['remote', 'add', 'origin', 'https://example.invalid/org/repo.git'])
    const revision = runGit(repoRoot, ['rev-parse', 'HEAD'])

    const archivePath = write(bundleDir, 'image.tar.gz', 'deterministic image archive\n')
    const manifestPath = join(bundleDir, 'release-manifest.json')
    const evidencePath = join(bundleDir, 'evidence.txt')
    const manifest = generateManifest({
        repoRoot,
        distribution: 'offline_archive',
        imageTag: `flowise-chinese:git-${revision}`,
        imageConfigDigest: CONFIG_DIGEST,
        archivePath,
        platform: 'linux/amd64',
        toolchain: TOOLCHAIN,
        now: FIXED_NOW
    })
    writeManifestAtomic(manifestPath, manifest)

    const archiveBytes = readFileSync(archivePath)
    const composeBytes = readFileSync(composePath)
    const seccompBytes = readFileSync(seccompPath)
    const wrapperBytes = readFileSync(wrapperPath)
    writeFileSync(
        evidencePath,
        [
            'source=https://example.invalid/org/repo.git',
            `revision=${revision}`,
            `image_tag=flowise-chinese:git-${revision}`,
            `store_identity=sha256:${'b'.repeat(64)}`,
            `image_config_digest=${CONFIG_DIGEST}`,
            'platform=linux/amd64',
            `archive_bytes=${archiveBytes.length}`,
            `archive_sha256=${sha256Hex(archiveBytes)}`,
            `manifest_sha256=${sha256Hex(readFileSync(manifestPath))}`,
            'isolated_smoke=passed',
            `chromium_profile_sha256=${sha256Hex(seccompBytes)}`,
            'chromium_sandbox=passed',
            'raw_chromium_sandbox=passed',
            'playwright_sandbox=passed',
            'puppeteer_sandbox=passed',
            'clone3_namespace=blocked_enosys',
            'unsafe_chromium_flags=false',
            `production_compose_sha256=${sha256Hex(composeBytes)}`,
            `production_wrapper_sha256=${sha256Hex(wrapperBytes)}`,
            'registry_push=false',
            ''
        ].join('\n')
    )

    return {
        root,
        repoRoot,
        bundleDir,
        revision,
        archivePath,
        manifestPath,
        evidencePath,
        composePath,
        seccompPath,
        wrapperPath,
        generate: () =>
            generateDeploymentBundle({
                bundleDir,
                archivePath,
                manifestPath,
                evidencePath,
                composePath,
                seccompPath,
                wrapperPath
            }),
        verify: () =>
            verifyDeploymentBundle({
                bundleDir,
                expectedRevision: revision,
                expectedImageTag: `flowise-chinese:git-${revision}`,
                expectedImageConfigDigest: CONFIG_DIGEST
            }),
        cleanup: () => rmSync(root, { recursive: true, force: true })
    }
}

test('deployment bundle binds every production payload and verifies the fixed layout', () => {
    const fixture = createFixture()
    try {
        const generated = fixture.generate()
        assert.equal(generated.release.revision, fixture.revision)
        assert.deepEqual(
            generated.files.map((entry) => entry.path),
            [
                'docker-compose.prod.yml',
                'docker/seccomp/chromium.json',
                'evidence.txt',
                'image.tar.gz',
                'release-manifest.json',
                'scripts/flowise-production-release.py'
            ]
        )
        assert.equal(fixture.verify().release.image_tag, `flowise-chinese:git-${fixture.revision}`)
        assert.equal(readFileSync(join(fixture.bundleDir, 'deployment-bundle.json'), 'utf8'), canonicalStringify(generated))
    } finally {
        fixture.cleanup()
    }
})

test('deployment bundle rejects a tampered Compose payload', () => {
    const fixture = createFixture()
    try {
        fixture.generate()
        writeFileSync(join(fixture.bundleDir, 'docker-compose.prod.yml'), 'services: {}\n')
        assert.throws(() => fixture.verify(), /payload identity mismatch: production_compose/)
    } finally {
        fixture.cleanup()
    }
})

test('deployment bundle rejects unexpected files and symlinks', () => {
    const fixture = createFixture()
    try {
        fixture.generate()
        writeFileSync(join(fixture.bundleDir, 'unexpected.txt'), 'unexpected\n')
        assert.throws(() => fixture.verify(), /unexpected or missing payload/)
        rmSync(join(fixture.bundleDir, 'unexpected.txt'))
        symlinkSync('release-manifest.json', join(fixture.bundleDir, 'manifest-link.json'))
        assert.throws(() => fixture.verify(), /must not contain symlinks/)
    } finally {
        fixture.cleanup()
    }
})

test('deployment bundle refuses to traverse a pre-existing symlinked payload directory', () => {
    const fixture = createFixture()
    const outside = join(fixture.root, 'outside')
    try {
        mkdirSync(outside)
        symlinkSync(outside, join(fixture.bundleDir, 'docker'))
        assert.throws(() => fixture.generate(), /parent must be a regular directory/)
        assert.equal(existsSync(join(outside, 'seccomp', 'chromium.json')), false)
    } finally {
        fixture.cleanup()
    }
})

test('deployment bundle rejects evidence that is not bound to the same candidate', () => {
    const fixture = createFixture()
    try {
        writeFileSync(
            fixture.evidencePath,
            readFileSync(fixture.evidencePath, 'utf8').replace(
                `image_config_digest=${CONFIG_DIGEST}`,
                `image_config_digest=sha256:${'b'.repeat(64)}`
            )
        )
        assert.throws(() => fixture.generate(), /Release evidence mismatch: image_config_digest/)
    } finally {
        fixture.cleanup()
    }
})

test('deployment bundle rejects omitted, extra, or contradictory security evidence', () => {
    for (const mutate of [
        (text) => text.replace('clone3_namespace=blocked_enosys\n', ''),
        (text) => `${text}unreviewed_claim=true\n`,
        (text) => text.replace('unsafe_chromium_flags=false', 'unsafe_chromium_flags=true'),
        (text) => text.replace(/store_identity=sha256:[0-9a-f]{64}/, 'store_identity=local-image'),
        () => `source=${'a'.repeat(65 * 1024)}\n`
    ]) {
        const fixture = createFixture()
        try {
            writeFileSync(fixture.evidencePath, mutate(readFileSync(fixture.evidencePath, 'utf8')))
            assert.throws(
                () => fixture.generate(),
                /Release evidence (?:field set mismatch|mismatch: unsafe_chromium_flags|contains an invalid local Docker store identity|is too large)/
            )
        } finally {
            fixture.cleanup()
        }
    }
})

test('deployment bundle rejects an expected identity supplied from another release', () => {
    const fixture = createFixture()
    try {
        fixture.generate()
        assert.throws(
            () =>
                verifyDeploymentBundle({
                    bundleDir: fixture.bundleDir,
                    expectedRevision: 'f'.repeat(40),
                    expectedImageTag: `flowise-chinese:git-${'f'.repeat(40)}`,
                    expectedImageConfigDigest: CONFIG_DIGEST
                }),
            /expected identity mismatch/
        )
    } finally {
        fixture.cleanup()
    }
})
