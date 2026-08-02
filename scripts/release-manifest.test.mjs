import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync, zstdCompressSync } from 'node:zlib'
import { load as loadYaml } from 'js-yaml'

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
const DEPLOYMENT_BUNDLE_MODULE_PATH = fileURLToPath(new URL('./deployment-bundle.mjs', import.meta.url))
const EDGE_SCRIPT_PATH = fileURLToPath(new URL('./verify-production-edge.sh', import.meta.url))
const SECURITY_SCRIPT_PATH = fileURLToPath(new URL('./verify-security.sh', import.meta.url))
const RELEASE_CANDIDATE_SCRIPT_PATH = fileURLToPath(new URL('./verify-release-candidate.sh', import.meta.url))
const CHROMIUM_SANDBOX_SCRIPT_PATH = fileURLToPath(new URL('./verify-chromium-sandbox.sh', import.meta.url))
const PUBLISH_VERIFIED_IMAGE_SCRIPT_PATH = fileURLToPath(new URL('./publish-verified-image.sh', import.meta.url))
const MAIN_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/main.yml', import.meta.url))
const DOCKER_BUILD_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/test_docker_build.yml', import.meta.url))
const DOCKERHUB_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/docker-image-dockerhub.yml', import.meta.url))
const ECR_WORKFLOW_PATH = fileURLToPath(new URL('../.github/workflows/docker-image-ecr.yml', import.meta.url))
const ROOT_DOCKERFILE_PATH = fileURLToPath(new URL('../Dockerfile', import.meta.url))
const APK_BUILD_LOCK_PATH = fileURLToPath(new URL('../docker/apk-build.lock', import.meta.url))
const APK_RUNTIME_LOCK_PATH = fileURLToPath(new URL('../docker/apk-runtime.lock', import.meta.url))
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
const BUILD_PUSH_ACTION = 'docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8'
const SETUP_BUILDX_ACTION = 'docker/setup-buildx-action@4d04d5d9486b7bd6fa91e7baf45bbb4f8b9deedd'
const BUILDX_VERSION = 'v0.34.1'
const BUILDKIT_IMAGE = 'moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f'
const PINNED_BUILDX_STEP_NAME = 'Set up the pinned Docker Buildx and BuildKit toolchain'
const PRIMARY_CONTRACT_STEP_NAME = 'Verify source and release contracts'
const PRIMARY_BUILD_STEP_NAME = 'Build root Dockerfile without pushing'
const READINESS_REBUILD_STEP_NAME = 'Independently rebuild and bind the candidate config identity'
const DOCKERHUB_CONTRACT_STEP_NAME = 'Verify source, dependencies and release contracts'
const DOCKERHUB_BUILD_STEP_NAME = 'Build the canonical current-source candidate without pushing'

const writeTarOctal = (header, offset, length, value) => {
    const octal = value.toString(8)
    assert.ok(octal.length <= length - 1, 'tar fixture octal field overflow')
    header.write(`${octal.padStart(length - 1, '0')}\0`, offset, length, 'ascii')
}

const createTarBytes = (entries, { gzip = false, endZeroBlocks = 2 } = {}) => {
    const chunks = []
    for (const entry of entries) {
        const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '')
        const header = Buffer.alloc(512)
        assert.ok(Buffer.byteLength(entry.path) <= 100, 'tar fixture path exceeds ustar name field')
        header.write(entry.path, 0, 100, 'utf8')
        writeTarOctal(header, 100, 8, entry.mode ?? (entry.type === '5' ? 0o755 : 0o644))
        writeTarOctal(header, 108, 8, 0)
        writeTarOctal(header, 116, 8, 0)
        writeTarOctal(header, 124, 12, entry.type === '5' ? 0 : content.length)
        writeTarOctal(header, 136, 12, 0)
        header.fill(0x20, 148, 156)
        header[156] = (entry.type ?? '0').charCodeAt(0)
        if (entry.linkPath) header.write(entry.linkPath, 157, 100, 'utf8')
        header.write('ustar\0', 257, 6, 'binary')
        header.write('00', 263, 2, 'ascii')
        const checksum = header.reduce((sum, byte) => sum + byte, 0)
        header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
        chunks.push(header)
        if (entry.type !== '5' && content.length > 0) {
            chunks.push(content)
            const padding = (512 - (content.length % 512)) % 512
            if (padding > 0) chunks.push(Buffer.alloc(padding))
        }
    }
    assert.ok(Number.isSafeInteger(endZeroBlocks) && endZeroBlocks >= 2, 'tar fixture end block count is invalid')
    chunks.push(Buffer.alloc(endZeroBlocks * 512))
    const tarBytes = Buffer.concat(chunks)
    return gzip ? gzipSync(tarBytes, { level: 1, mtime: 0 }) : tarBytes
}

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
    write(repoRoot, 'docker/apk-build.lock', 'build-package=1-r0\n')
    write(repoRoot, 'docker/apk-runtime.lock', 'runtime-package=1-r0\n')
    write(repoRoot, 'docker/seccomp/chromium.json', '{"defaultAction":"SCMP_ACT_ERRNO","syscalls":[]}\n')
    write(repoRoot, 'scripts/verify-release-source.sh', '#!/usr/bin/env bash\nexit 0\n')
    write(repoRoot, 'scripts/verify-security.sh', '#!/usr/bin/env bash\nexit 0\n')
    copyFileSync(CHROMIUM_SANDBOX_SCRIPT_PATH, join(repoRoot, 'scripts/verify-chromium-sandbox.sh'))
    copyFileSync(DEPLOYMENT_BUNDLE_MODULE_PATH, join(repoRoot, 'scripts/deployment-bundle.mjs'))
    copyFileSync(PUBLISH_VERIFIED_IMAGE_SCRIPT_PATH, join(repoRoot, 'scripts/publish-verified-image.sh'))
    copyFileSync(RELEASE_CANDIDATE_SCRIPT_PATH, join(repoRoot, 'scripts/verify-release-candidate.sh'))
    mkdirSync(join(repoRoot, 'scripts'), { recursive: true })
    copyFileSync(MODULE_PATH, join(repoRoot, 'scripts/release-manifest.mjs'))
    write(repoRoot, 'scripts/flowise-production-release.py', '#!/usr/bin/env python3\nraise SystemExit(0)\n')
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
    tag = `flowise-chinese:git-${revision}`,
    source = 'https://github.com/example/flowise',
    version = `git-${revision}`,
    created = '2026-07-12T00:00:00+00:00',
    architecture = 'amd64',
    repoTags,
    labelOverrides = {},
    configPathDigest,
    diffIdOverride,
    rootfsDiffIds,
    extraEntries = [],
    configMediaType = 'application/vnd.oci.image.config.v1+json',
    layerCompression = 'none',
    layerPayloads = [Buffer.from('deterministic layer fixture\n')],
    layout = 'classic',
    legacyRepositories = null,
    omitLayer = false,
    omitRootfs = false,
    alterLayer = false,
    endZeroBlocks = 2
} = {}) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'flowise-docker-archive-test-'))
    const archivePath = join(fixtureRoot, 'flowise-image.tar.gz')

    assert.ok(Array.isArray(layerPayloads) && layerPayloads.length > 0, 'layer fixture payloads are invalid')
    const layers = layerPayloads.map((payload, indexValue) => {
        const memberPath = indexValue === 0 ? 'app.txt' : `app-${indexValue}.txt`
        const originalTar = createTarBytes([{ path: memberPath, content: payload }])
        const actualTar =
            alterLayer && indexValue === 0 ? createTarBytes([{ path: memberPath, content: 'altered layer fixture\n' }]) : originalTar
        const bytes =
            layerCompression === 'gzip'
                ? gzipSync(actualTar, { level: 1, mtime: 0 })
                : layerCompression === 'zstd'
                ? zstdCompressSync(actualTar)
                : actualTar
        return {
            bytes,
            blobDigest: createHash('sha256').update(bytes).digest('hex'),
            diffId: `sha256:${createHash('sha256').update(originalTar).digest('hex')}`,
            uncompressedBytes: actualTar.length
        }
    })
    const layerDiffIds = layers.map((layer, indexValue) => (indexValue === 0 && diffIdOverride ? diffIdOverride : layer.diffId))

    const config = {
        architecture,
        os: 'linux',
        ...(omitRootfs ? {} : { rootfs: { type: 'layers', diff_ids: rootfsDiffIds ?? layerDiffIds } }),
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
    const effectiveConfigDigest = configPathDigest ?? actualConfigDigest
    const configPath = layout === 'containerd' ? `blobs/sha256/${effectiveConfigDigest}` : `${effectiveConfigDigest}.json`
    const layerPaths = layers.map((layer) =>
        layout === 'containerd' ? `blobs/sha256/${layer.blobDigest}` : layers.length === 1 ? 'layer.tar' : `${layer.blobDigest}/layer.tar`
    )
    const archiveManifestBytes = Buffer.from(
        `${JSON.stringify([{ Config: configPath, RepoTags: repoTags ?? [tag], Layers: layerPaths }])}\n`
    )
    const entries = []

    if (layout === 'containerd') {
        const mediaTypeByCompression = {
            gzip: 'application/vnd.oci.image.layer.v1.tar+gzip',
            none: 'application/vnd.oci.image.layer.v1.tar',
            zstd: 'application/vnd.oci.image.layer.v1.tar+zstd'
        }
        const imageManifestBytes = Buffer.from(
            `${JSON.stringify({
                schemaVersion: 2,
                mediaType: 'application/vnd.oci.image.manifest.v1+json',
                config: {
                    mediaType: configMediaType,
                    digest: `sha256:${effectiveConfigDigest}`,
                    size: configBytes.length
                },
                layers: layers.map((layer) => ({
                    mediaType: mediaTypeByCompression[layerCompression],
                    digest: `sha256:${layer.blobDigest}`,
                    size: layer.bytes.length
                }))
            })}\n`
        )
        const imageManifestDigest = createHash('sha256').update(imageManifestBytes).digest('hex')
        const indexBytes = Buffer.from(
            `${JSON.stringify({
                schemaVersion: 2,
                mediaType: 'application/vnd.oci.image.index.v1+json',
                manifests: [
                    {
                        mediaType: 'application/vnd.oci.image.manifest.v1+json',
                        digest: `sha256:${imageManifestDigest}`,
                        size: imageManifestBytes.length
                    }
                ]
            })}\n`
        )
        entries.push(
            { path: 'blobs/', type: '5' },
            { path: 'blobs/sha256/', type: '5' },
            { path: configPath, content: configBytes },
            { path: `blobs/sha256/${imageManifestDigest}`, content: imageManifestBytes },
            ...(!omitLayer ? layerPaths.map((path, indexValue) => ({ path, content: layers[indexValue].bytes })) : []),
            { path: 'index.json', content: indexBytes },
            { path: 'manifest.json', content: archiveManifestBytes },
            { path: 'oci-layout', content: '{"imageLayoutVersion":"1.0.0"}\n' }
        )
        if (legacyRepositories !== null) {
            const repositoryTag = (repoTags ?? [tag])[0]
            const tagSeparator = repositoryTag.lastIndexOf(':')
            const repositoryName = repositoryTag.slice(0, tagSeparator)
            const tagName = repositoryTag.slice(tagSeparator + 1)
            const repositories =
                legacyRepositories === true
                    ? { [repositoryName]: { [tagName]: layerDiffIds.at(-1).slice('sha256:'.length) } }
                    : legacyRepositories
            entries.push({ path: 'repositories', content: `${JSON.stringify(repositories)}\n` })
        }
    } else {
        entries.push(
            { path: 'manifest.json', content: archiveManifestBytes },
            { path: configPath, content: configBytes },
            ...(!omitLayer ? layerPaths.map((path, indexValue) => ({ path, content: layers[indexValue].bytes })) : [])
        )
    }
    entries.push(...extraEntries)
    writeFileSync(archivePath, createTarBytes(entries, { gzip: true, endZeroBlocks }))

    return {
        archivePath,
        created,
        revision,
        source,
        tag,
        version,
        layerDiffId: layerDiffIds[0],
        layerUncompressedBytes: layers.map((layer) => layer.uncompressedBytes),
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

const parseWorkflowDocument = (workflowSource, label) => {
    assert.equal(typeof workflowSource, 'string', `${label} source must be text`)
    const workflow = loadYaml(workflowSource)
    assert.ok(workflow && typeof workflow === 'object' && !Array.isArray(workflow), `${label} must be a YAML object`)
    assert.ok(workflow.jobs && typeof workflow.jobs === 'object' && !Array.isArray(workflow.jobs), `${label} jobs are missing`)
    return workflow
}

const requireNamedWorkflowStep = (workflow, jobId, stepName, label) => {
    const steps = workflow.jobs?.[jobId]?.steps
    assert.ok(Array.isArray(steps), `${label} job ${jobId} steps are missing`)
    const matches = steps.filter((step) => step && typeof step === 'object' && !Array.isArray(step) && step.name === stepName)
    assert.equal(matches.length, 1, `${label} must contain exactly one ${jobId}/${stepName} step`)
    return matches[0]
}

const parseActiveBuildArgs = (value, label) => {
    assert.equal(typeof value, 'string', `${label} build-args must be an active YAML scalar`)
    const entries = {}
    for (const rawLine of value.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        assert.doesNotMatch(line, /^#/, `${label} build-args must not use commented contract text`)
        const separator = line.indexOf('=')
        assert.ok(separator > 0, `${label} build-arg is malformed: ${line}`)
        const key = line.slice(0, separator)
        assert.match(key, /^[A-Z][A-Z0-9_]*$/, `${label} build-arg key is malformed: ${key}`)
        assert.equal(Object.hasOwn(entries, key), false, `${label} build-arg is duplicated: ${key}`)
        entries[key] = line.slice(separator + 1)
    }
    return entries
}

const activeShellLines = (run, label) => {
    assert.equal(typeof run, 'string', `${label} run must be an active YAML scalar`)
    return run
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
}

const requireSingleActiveLine = (lines, expected, label) => {
    const indexes = lines.flatMap((line, indexValue) => (line === expected ? [indexValue] : []))
    assert.equal(indexes.length, 1, `${label} must be one active command in the named step`)
    return indexes[0]
}

const validatePinnedBuildxStep = (workflow, jobId, stepName = PINNED_BUILDX_STEP_NAME) => {
    const step = requireNamedWorkflowStep(workflow, jobId, stepName, `${jobId} Buildx setup`)
    assert.equal(step.uses, SETUP_BUILDX_ACTION)
    assert.deepEqual(step.with, {
        version: BUILDX_VERSION,
        driver: 'docker-container',
        'driver-opts': `image=${BUILDKIT_IMAGE}`
    })
    return step
}

const validateCanonicalContextReset = (workflow, jobId, stepName, label) => {
    const step = requireNamedWorkflowStep(workflow, jobId, stepName, label)
    const lines = activeShellLines(step.run, label)
    const cleanStatusLine = 'test -z "$(git status --porcelain --untracked-files=all)"'
    const cleanStatusIndexes = lines.flatMap((line, indexValue) => (line === cleanStatusLine ? [indexValue] : []))
    assert.equal(cleanStatusIndexes.length, 2, `${label} must prove a clean tree before and after ignored-file removal`)
    const resetIndex = requireSingleActiveLine(lines, 'git clean -dffqx', `${label} ignored-file reset`)
    const dryRunIndex = requireSingleActiveLine(lines, 'test -z "$(git clean -ndffx)"', `${label} empty cleanup dry-run`)
    assert.equal(cleanStatusIndexes[0] + 1, resetIndex, `${label} reset must immediately follow the pre-reset clean-tree proof`)
    assert.equal(resetIndex + 1, cleanStatusIndexes[1], `${label} must immediately re-prove the clean tree after reset`)
    assert.equal(cleanStatusIndexes[1] + 1, dryRunIndex, `${label} dry-run proof must immediately follow the post-reset proof`)
    assert.equal(dryRunIndex, lines.length - 1, `${label} canonical context proof must remain at the executed step tail`)
    return step
}

const validatePrimaryBuildStep = (workflowSource) => {
    const workflow = parseWorkflowDocument(workflowSource, 'build-only workflow')
    validateCanonicalContextReset(workflow, 'build', PRIMARY_CONTRACT_STEP_NAME, 'primary canonical build context')
    validatePinnedBuildxStep(workflow, 'build')
    const metadata = requireNamedWorkflowStep(workflow, 'build', 'Resolve immutable build metadata', 'primary build metadata')
    requireSingleActiveLine(
        activeShellLines(metadata.run, 'primary build metadata'),
        'echo "source_date_epoch=$(git show -s --format=%ct "$CANDIDATE_SHA")" >> "$GITHUB_OUTPUT"',
        'primary SOURCE_DATE_EPOCH producer'
    )
    const step = requireNamedWorkflowStep(workflow, 'build', PRIMARY_BUILD_STEP_NAME, 'primary build')
    assert.equal(step.uses, BUILD_PUSH_ACTION)
    assert.equal(step.env?.SOURCE_DATE_EPOCH, '${{ steps.metadata.outputs.source_date_epoch }}')
    assert.equal(step.with?.context, '.')
    assert.equal(step.with?.file, 'Dockerfile')
    assert.equal(step.with?.platforms, 'linux/amd64')
    assert.equal(step.with?.outputs, 'type=docker,name=flowise-chinese:${{ steps.metadata.outputs.version }},rewrite-timestamp=true')
    assert.equal(step.with?.load, undefined)
    assert.equal(step.with?.push, false)
    assert.equal(step.with?.provenance, false)
    assert.deepEqual(parseActiveBuildArgs(step.with?.['build-args'], 'primary build'), {
        SOURCE_DATE_EPOCH: '${{ steps.metadata.outputs.source_date_epoch }}',
        BUILD_SOURCE: '${{ steps.metadata.outputs.source }}',
        BUILD_REVISION: '${{ steps.metadata.outputs.revision }}',
        BUILD_VERSION: '${{ steps.metadata.outputs.version }}',
        BUILD_CREATED: '${{ steps.metadata.outputs.created }}'
    })
    return step
}

const validateReadinessRebuildStep = (workflowSource) => {
    const workflow = parseWorkflowDocument(workflowSource, 'build-only workflow')
    assert.equal(workflow.jobs?.release_readiness?.env?.REBUILD_TAG, 'flowise-chinese:git-${{ github.sha }}')
    validatePinnedBuildxStep(workflow, 'release_readiness')
    const step = requireNamedWorkflowStep(workflow, 'release_readiness', READINESS_REBUILD_STEP_NAME, 'readiness rebuild')
    assert.equal(step.uses, undefined)
    assert.equal(step.env?.INDEPENDENT_ARCHIVE_PATH, '${{ runner.temp }}/flowise-release-readiness-independent.tar.gz')
    const lines = activeShellLines(step.run, 'readiness rebuild')
    const exactShaIndex = requireSingleActiveLine(lines, 'test "$GITHUB_SHA" = "$(git rev-parse HEAD)"', 'readiness exact SHA proof')
    const cleanStatusIndex = requireSingleActiveLine(
        lines,
        'test -z "$(git status --porcelain --untracked-files=all)"',
        'readiness clean-tree proof'
    )
    const dryRunIndex = requireSingleActiveLine(lines, 'test -z "$(git clean -ndffx)"', 'readiness empty cleanup dry-run')
    requireSingleActiveLine(lines, 'source_date_epoch="$(git show -s --format=%ct "$GITHUB_SHA")"', 'readiness SOURCE_DATE_EPOCH producer')
    const buildIndex = requireSingleActiveLine(
        lines,
        'SOURCE_DATE_EPOCH="$source_date_epoch" docker buildx build \\',
        'readiness build invocation'
    )
    const fileIndex = requireSingleActiveLine(lines, '--file Dockerfile \\', 'readiness canonical Dockerfile')
    const platformIndex = requireSingleActiveLine(lines, '--platform linux/amd64 \\', 'readiness canonical platform')
    const outputIndex = requireSingleActiveLine(
        lines,
        '--output "type=docker,name=$REBUILD_TAG,rewrite-timestamp=true" \\',
        'readiness Docker exporter'
    )
    const epochIndex = requireSingleActiveLine(
        lines,
        '--build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \\',
        'readiness SOURCE_DATE_EPOCH build argument'
    )
    const independentDigestIndex = requireSingleActiveLine(
        lines,
        'independent_config_digest="$(node scripts/release-manifest.mjs verify-archive \\',
        'readiness independently derived config digest'
    )
    const expectedDigestIndex = lines.findIndex((line) => line.startsWith('expected_config_digest="$(jq -er '))
    assert.notEqual(expectedDigestIndex, -1, 'readiness expected config digest assignment must be active')
    const equalityIndex = requireSingleActiveLine(
        lines,
        'test "$independent_config_digest" = "$expected_config_digest"',
        'readiness raw config digest equality'
    )
    const mismatchIndex = requireSingleActiveLine(
        lines,
        'if [ "$independent_config_digest" != "$expected_config_digest" ]; then',
        'readiness digest mismatch guard'
    )
    const mismatchSummaryIndex = requireSingleActiveLine(
        lines,
        "printf 'release_readiness_config_mismatch expected=%s actual=%s\\n' \\",
        'readiness safe digest mismatch summary'
    )
    const mismatchArgumentsIndex = requireSingleActiveLine(
        lines,
        '"$expected_config_digest" "$independent_config_digest"',
        'readiness mismatch digest arguments'
    )
    const mismatchEndIndex = requireSingleActiveLine(lines, 'fi', 'readiness digest mismatch guard terminator')
    assert.equal(exactShaIndex + 1, cleanStatusIndex)
    assert.equal(cleanStatusIndex + 1, dryRunIndex)
    assert.ok(dryRunIndex < buildIndex)
    assert.ok(buildIndex < fileIndex)
    assert.ok(fileIndex < platformIndex)
    assert.ok(platformIndex < outputIndex)
    assert.ok(outputIndex < epochIndex)
    assert.ok(epochIndex < independentDigestIndex)
    assert.ok(independentDigestIndex < expectedDigestIndex)
    assert.ok(expectedDigestIndex < mismatchIndex)
    assert.equal(mismatchIndex + 1, mismatchSummaryIndex)
    assert.equal(mismatchSummaryIndex + 1, mismatchArgumentsIndex)
    assert.equal(mismatchArgumentsIndex + 1, mismatchEndIndex)
    assert.equal(mismatchEndIndex + 1, equalityIndex)
    assert.equal(lines[equalityIndex + 1], 'cleanup_independent_rebuild')
    assert.equal(lines[equalityIndex + 2], 'trap - EXIT')
    assert.equal(equalityIndex + 2, lines.length - 1, 'readiness digest equality must remain on the executed top-level tail')
    assert.equal(
        lines.some((line) => line === '--load \\' || line === '--load'),
        false
    )
    return step
}

const validateDockerHubBuildStep = (workflowSource) => {
    const workflow = parseWorkflowDocument(workflowSource, 'Docker Hub workflow')
    validateCanonicalContextReset(workflow, 'publish', DOCKERHUB_CONTRACT_STEP_NAME, 'Docker Hub canonical build context')
    validatePinnedBuildxStep(workflow, 'publish', 'Set up Docker Buildx')
    const checkout = requireNamedWorkflowStep(workflow, 'publish', 'Checkout the exact source revision', 'Docker Hub checkout')
    assert.equal(checkout.with?.['persist-credentials'], false)
    const metadata = requireNamedWorkflowStep(workflow, 'publish', 'Resolve immutable OCI metadata', 'Docker Hub metadata')
    requireSingleActiveLine(
        activeShellLines(metadata.run, 'Docker Hub metadata'),
        `printf 'source_date_epoch=%s\\n' "$(git show -s --format=%ct "$GITHUB_SHA")" >> "$GITHUB_OUTPUT"`,
        'Docker Hub SOURCE_DATE_EPOCH producer'
    )
    const step = requireNamedWorkflowStep(workflow, 'publish', DOCKERHUB_BUILD_STEP_NAME, 'Docker Hub build')
    assert.equal(step.uses, BUILD_PUSH_ACTION)
    assert.equal(step.env?.SOURCE_DATE_EPOCH, '${{ steps.metadata.outputs.source_date_epoch }}')
    assert.equal(step.with?.context, '.')
    assert.equal(step.with?.file, 'Dockerfile')
    assert.equal(step.with?.platforms, 'linux/amd64')
    assert.equal(step.with?.outputs, 'type=docker,name=flowise-chinese:git-${{ github.sha }},rewrite-timestamp=true')
    assert.equal(step.with?.load, undefined)
    assert.equal(step.with?.push, false)
    assert.equal(step.with?.provenance, false)
    assert.deepEqual(parseActiveBuildArgs(step.with?.['build-args'], 'Docker Hub build'), {
        SOURCE_DATE_EPOCH: '${{ steps.metadata.outputs.source_date_epoch }}',
        BUILD_SOURCE: '${{ steps.metadata.outputs.source }}',
        BUILD_REVISION: '${{ github.sha }}',
        BUILD_VERSION: 'git-${{ github.sha }}',
        BUILD_CREATED: '${{ steps.metadata.outputs.created }}'
    })
    return step
}

const validateRootDockerfileReproducibility = (dockerfile) => {
    const cleanup = dockerfile.match(/RUN pnpm build:docker[\s\S]*?(?=\n\n# ==========================================)/)?.[0]
    assert.ok(cleanup, 'Dockerfile must clean build-only output before the runtime copy')
    assert.equal(dockerfile.match(/^\s*\/var\/log\/apk\.log$/gm)?.length, 2, 'both APK install layers must remove the timestamped APK log')
    assert.match(
        cleanup,
        /rm -f \\\n\s+\.npmrc \\\n\s+node_modules\/\.modules\.yaml \\\n\s+node_modules\/\.pnpm-workspace-state-v1\.json && \\\n\s+rm -rf \\\n\s+\.turbo \\\n\s+node_modules\/\.cache\/turbo \\\n\s+packages\/api-documentation\/\.turbo \\\n\s+packages\/components\/\.turbo \\\n\s+packages\/server\/\.turbo \\\n\s+packages\/ui\/\.turbo/
    )
    assert.doesNotMatch(cleanup, /node_modules\/\.cache\/\*|packages\/\*\/\.turbo|rm -rf\s+node_modules/)
    return cleanup
}

const validateApkClosureContracts = (dockerfile, closures) => {
    const parseClosure = (entries, label) => {
        const packages = new Map()
        for (const entry of entries) {
            const match = /^([A-Za-z0-9+_.-]+)=([A-Za-z0-9+_.~-]+)$/.exec(entry)
            assert.ok(match, `${label} APK lock entry must contain an exact version: ${entry}`)
            assert.equal(packages.has(match[1]), false, `${label} APK lock must not repeat ${match[1]}`)
            packages.set(match[1], match[2])
        }
        return packages
    }

    const parseDirectPins = (lockName, label) => {
        const escapedLockName = lockName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const layer = new RegExp(
            `COPY docker\\/${escapedLockName} \\/tmp\\/${escapedLockName}\\nRUN [\\s\\S]*?cmp -s \\/tmp\\/${escapedLockName} \\/tmp\\/apk-actual\\.lock`
        ).exec(dockerfile)?.[0]
        assert.ok(layer, `${label} APK install layer must retain its fail-closed lock comparison`)
        const install = /apk add --no-cache \\\n([\s\S]*?) && \\\n\s+awk -F:/.exec(layer)?.[1]
        assert.ok(install, `${label} APK install layer must contain exact direct pins`)

        const pins = new Map()
        for (const line of install.trim().split('\n')) {
            const match = /^([A-Za-z0-9+_.-]+)=([A-Za-z0-9+_.~-]+)(?: \\)?$/.exec(line.trim())
            assert.ok(match, `${label} direct APK dependency must be exactly pinned: ${line.trim()}`)
            assert.equal(pins.has(match[1]), false, `${label} direct APK dependency must not repeat ${match[1]}`)
            pins.set(match[1], match[2])
        }
        return pins
    }

    const parsedClosures = new Map()
    for (const { label, lockName, entries } of closures) {
        const closure = parseClosure(entries, label)
        const directPins = parseDirectPins(lockName, label)
        for (const [packageName, version] of directPins) {
            assert.equal(
                closure.get(packageName),
                version,
                `${label} direct APK pin ${packageName}=${version} must exist unchanged in its complete closure`
            )
        }
        parsedClosures.set(label, closure)
    }

    const runtimeClosure = parsedClosures.get('runtime')
    assert.ok(runtimeClosure, 'runtime APK closure must be validated')
    const chromiumPackages = ['chromium', 'chromium-angle', 'chromium-common']
    const chromiumVersions = chromiumPackages.map((packageName) => {
        const version = runtimeClosure.get(packageName)
        assert.ok(version, `runtime APK closure must contain ${packageName}`)
        return version
    })
    assert.equal(new Set(chromiumVersions).size, 1, 'Chromium runtime packages must use one identical version')
}

const replaceWorkflowTextOnce = (workflowSource, expected, replacement, label) => {
    const firstIndex = workflowSource.indexOf(expected)
    assert.notEqual(firstIndex, -1, `${label} mutation target is missing`)
    assert.equal(workflowSource.indexOf(expected, firstIndex + expected.length), -1, `${label} mutation target is ambiguous`)
    return `${workflowSource.slice(0, firstIndex)}${replacement}${workflowSource.slice(firstIndex + expected.length)}`
}

const replaceNamedWorkflowStepText = (
    workflowSource,
    stepName,
    expected,
    replacement,
    label,
    { occurrence = 0, expectedCount = 1 } = {}
) => {
    const escapedStepName = stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const marker = new RegExp(`^(\\s*)- name: ${escapedStepName}\\s*$`, 'm').exec(workflowSource)
    assert.ok(marker, `${label} named step is missing`)
    const stepStart = marker.index
    const nextStep = new RegExp(`^${marker[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}- `, 'gm')
    nextStep.lastIndex = stepStart + marker[0].length
    const nextMarker = nextStep.exec(workflowSource)
    const stepEnd = nextMarker?.index ?? workflowSource.length
    const stepSource = workflowSource.slice(stepStart, stepEnd)
    const indexes = []
    let searchFrom = 0
    let indexValue = stepSource.indexOf(expected, searchFrom)
    while (indexValue !== -1) {
        indexes.push(indexValue)
        searchFrom = indexValue + expected.length
        indexValue = stepSource.indexOf(expected, searchFrom)
    }
    assert.equal(indexes.length, expectedCount, `${label} mutation target count is not exact in the named step`)
    assert.ok(occurrence >= 0 && occurrence < indexes.length, `${label} mutation occurrence is out of range`)
    const target = stepStart + indexes[occurrence]
    return `${workflowSource.slice(0, target)}${replacement}${workflowSource.slice(target + expected.length)}`
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

test('Docker archive verification derives config identity and binds tag, platform, runtime and OCI labels', async () => {
    const fixture = createDockerArchiveFixture()
    try {
        const result = await verifyDockerArchive({
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

test('Docker archive verification rejects a manifest-supplied tag or revision that is not in the archive', async () => {
    const wrongTag = createDockerArchiveFixture({ repoTags: ['flowise-chinese:git-2222222222222222222222222222222222222222'] })
    try {
        await assert.rejects(
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
        await assert.rejects(
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

test('Docker archive verification rejects a mismatched config digest and platform', async () => {
    const wrongDigest = createDockerArchiveFixture({ configPathDigest: 'f'.repeat(64) })
    try {
        await assert.rejects(
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
        await assert.rejects(
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

test('Docker archive verification supports classic and containerd save layouts with streamed layer compression', async () => {
    for (const options of [
        { layout: 'classic', layerCompression: 'none' },
        { layout: 'containerd', layerCompression: 'gzip' },
        { layout: 'containerd', layerCompression: 'zstd' },
        {
            layout: 'containerd',
            layerCompression: 'none',
            configMediaType: 'application/vnd.docker.container.image.v1+json'
        }
    ]) {
        const fixture = createDockerArchiveFixture(options)
        try {
            const result = await verifyDockerArchive({
                archivePath: fixture.archivePath,
                imageTag: fixture.tag,
                revision: fixture.revision,
                source: fixture.source,
                version: fixture.version,
                created: fixture.created,
                platform: 'linux/amd64'
            })
            assert.equal(result.imageConfigDigest, fixture.actualConfigDigest)
        } finally {
            fixture.cleanup()
        }
    }
})

test('Docker archive verification accepts only digest-bound unreferenced blobs in containerd layouts', async () => {
    const orphanContent = Buffer.from('unreferenced content-addressed Docker blob\n')
    const orphanDigest = createHash('sha256').update(orphanContent).digest('hex')
    const validFixture = createDockerArchiveFixture({
        layout: 'containerd',
        extraEntries: [{ path: `blobs/sha256/${orphanDigest}`, content: orphanContent }]
    })
    try {
        const result = await verifyDockerArchive({
            archivePath: validFixture.archivePath,
            imageTag: validFixture.tag,
            revision: validFixture.revision,
            source: validFixture.source,
            version: validFixture.version,
            created: validFixture.created,
            platform: 'linux/amd64'
        })
        assert.equal(result.imageConfigDigest, validFixture.actualConfigDigest)
    } finally {
        validFixture.cleanup()
    }

    const mismatchedFixture = createDockerArchiveFixture({
        layout: 'containerd',
        extraEntries: [{ path: `blobs/sha256/${'f'.repeat(64)}`, content: orphanContent }]
    })
    try {
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: mismatchedFixture.archivePath,
                    imageTag: mismatchedFixture.tag,
                    revision: mismatchedFixture.revision,
                    source: mismatchedFixture.source,
                    version: mismatchedFixture.version,
                    created: mismatchedFixture.created,
                    platform: 'linux/amd64'
                }),
            /unreferenced blob digest mismatch/
        )
    } finally {
        mismatchedFixture.cleanup()
    }

    const classicFixture = createDockerArchiveFixture({
        extraEntries: [{ path: `blobs/sha256/${orphanDigest}`, content: orphanContent }]
    })
    try {
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: classicFixture.archivePath,
                    imageTag: classicFixture.tag,
                    revision: classicFixture.revision,
                    source: classicFixture.source,
                    version: classicFixture.version,
                    created: classicFixture.created,
                    platform: 'linux/amd64'
                }),
            /unexpected member/
        )
    } finally {
        classicFixture.cleanup()
    }
})

test('Docker archive verification strictly binds optional legacy repositories metadata', async () => {
    const revision = '1'.repeat(40)
    for (const tag of [`flowise-chinese:git-${revision}`, `registry.example.invalid:5443/team/flowise:git-${revision}`]) {
        const legacyBlob = Buffer.from(`Docker 28 legacy compatibility blob for ${tag}\n`)
        const legacyBlobDigest = createHash('sha256').update(legacyBlob).digest('hex')
        const fixture = createDockerArchiveFixture({
            layout: 'containerd',
            tag,
            legacyRepositories: true,
            extraEntries: [{ path: `blobs/sha256/${legacyBlobDigest}`, content: legacyBlob }]
        })
        try {
            const result = await verifyDockerArchive({
                archivePath: fixture.archivePath,
                imageTag: fixture.tag,
                revision: fixture.revision,
                source: fixture.source,
                version: fixture.version,
                created: fixture.created,
                platform: 'linux/amd64'
            })
            assert.equal(result.imageConfigDigest, fixture.actualConfigDigest)
        } finally {
            fixture.cleanup()
        }
    }

    const tagName = `git-${revision}`
    for (const legacyRepositories of [
        { unexpected: { [tagName]: 'f'.repeat(64) } },
        { 'flowise-chinese': { unexpected: 'f'.repeat(64) } },
        { 'flowise-chinese': { [tagName]: 'f'.repeat(64) } },
        { 'flowise-chinese': { [tagName]: 'f'.repeat(64), unexpected: 'f'.repeat(64) } },
        { 'flowise-chinese': { [tagName]: 'f'.repeat(64) }, unexpected: {} }
    ]) {
        const fixture = createDockerArchiveFixture({ layout: 'containerd', legacyRepositories })
        try {
            await assert.rejects(
                () =>
                    verifyDockerArchive({
                        archivePath: fixture.archivePath,
                        imageTag: fixture.tag,
                        revision: fixture.revision,
                        source: fixture.source,
                        version: fixture.version,
                        created: fixture.created,
                        platform: 'linux/amd64'
                    }),
                /legacy repositories metadata mismatch/
            )
        } finally {
            fixture.cleanup()
        }
    }

    const malformedFixture = createDockerArchiveFixture({
        layout: 'containerd',
        extraEntries: [{ path: 'repositories', content: 'not-json\n' }]
    })
    try {
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: malformedFixture.archivePath,
                    imageTag: malformedFixture.tag,
                    revision: malformedFixture.revision,
                    source: malformedFixture.source,
                    version: malformedFixture.version,
                    created: malformedFixture.created,
                    platform: 'linux/amd64'
                }),
            /legacy repositories metadata is not valid JSON/
        )
    } finally {
        malformedFixture.cleanup()
    }
})

test('Docker archive verification rejects unsupported config media types and compressed classic layer.tar members', async () => {
    for (const [options, expectedError] of [
        [{ layout: 'containerd', configMediaType: 'application/octet-stream' }, /OCI config media type/],
        [{ layout: 'classic', layerCompression: 'gzip' }, /classic layer\.tar must not be compressed/]
    ]) {
        const fixture = createDockerArchiveFixture(options)
        try {
            await assert.rejects(
                () =>
                    verifyDockerArchive({
                        archivePath: fixture.archivePath,
                        imageTag: fixture.tag,
                        revision: fixture.revision,
                        source: fixture.source,
                        version: fixture.version,
                        created: fixture.created,
                        platform: 'linux/amd64'
                    }),
                expectedError
            )
        } finally {
            fixture.cleanup()
        }
    }
})

test('Docker archive verification enforces one live cumulative decoder budget across compressed layers', async () => {
    const maxTotalUncompressedBytes = 150 * 1024
    const fixture = createDockerArchiveFixture({
        layout: 'containerd',
        layerCompression: 'gzip',
        layerPayloads: [Buffer.alloc(96 * 1024, 0x41), Buffer.alloc(96 * 1024, 0x42)]
    })
    try {
        assert.equal(
            fixture.layerUncompressedBytes.every((bytes) => bytes < maxTotalUncompressedBytes),
            true
        )
        assert.ok(fixture.layerUncompressedBytes.reduce((total, bytes) => total + bytes, 0) > maxTotalUncompressedBytes)
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: fixture.archivePath,
                    imageTag: fixture.tag,
                    revision: fixture.revision,
                    source: fixture.source,
                    version: fixture.version,
                    created: fixture.created,
                    platform: 'linux/amd64',
                    maxTotalUncompressedBytes
                }),
            /members exceed the total uncompressed size limit/
        )
    } finally {
        fixture.cleanup()
    }
})

test('Docker archive verification opens the archive itself without following a symlink', async () => {
    const fixture = createDockerArchiveFixture()
    const symlinkPath = join(dirname(fixture.archivePath), 'flowise-image-symlink.tar.gz')
    symlinkSync(fixture.archivePath, symlinkPath)
    try {
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: symlinkPath,
                    imageTag: fixture.tag,
                    revision: fixture.revision,
                    source: fixture.source,
                    version: fixture.version,
                    created: fixture.created,
                    platform: 'linux/amd64'
                }),
            /regular non-symlink file/
        )
    } finally {
        fixture.cleanup()
    }
})

test('Docker archive verification binds rootfs diff_ids to exact uncompressed layer payloads', async () => {
    for (const [options, expectedError] of [
        [{ omitRootfs: true }, /rootfs diff_ids/],
        [{ rootfsDiffIds: [] }, /rootfs diff_ids/],
        [{ alterLayer: true }, /layer diff_id mismatch/],
        [{ diffIdOverride: `sha256:${'f'.repeat(64)}` }, /layer diff_id mismatch/]
    ]) {
        const fixture = createDockerArchiveFixture(options)
        try {
            await assert.rejects(
                () =>
                    verifyDockerArchive({
                        archivePath: fixture.archivePath,
                        imageTag: fixture.tag,
                        revision: fixture.revision,
                        source: fixture.source,
                        version: fixture.version,
                        created: fixture.created,
                        platform: 'linux/amd64'
                    }),
                expectedError
            )
        } finally {
            fixture.cleanup()
        }
    }
})

test('Docker archive verification rejects missing, extra and traversal members', async () => {
    for (const [options, expectedError] of [
        [{ omitLayer: true }, /layer is unavailable/],
        [{ extraEntries: [{ path: 'unexpected.txt', content: 'unexpected\n' }] }, /unexpected member/],
        [{ extraEntries: [{ path: '../escape', content: 'escape\n' }] }, /member path is unsafe/]
    ]) {
        const fixture = createDockerArchiveFixture(options)
        try {
            await assert.rejects(
                () =>
                    verifyDockerArchive({
                        archivePath: fixture.archivePath,
                        imageTag: fixture.tag,
                        revision: fixture.revision,
                        source: fixture.source,
                        version: fixture.version,
                        created: fixture.created,
                        platform: 'linux/amd64'
                    }),
                expectedError
            )
        } finally {
            fixture.cleanup()
        }
    }
})

test('Docker archive verification bounds zero-filled data after the tar end marker', async () => {
    const fixture = createDockerArchiveFixture({ endZeroBlocks: 21 })
    try {
        await assert.rejects(
            () =>
                verifyDockerArchive({
                    archivePath: fixture.archivePath,
                    imageTag: fixture.tag,
                    revision: fixture.revision,
                    source: fixture.source,
                    version: fixture.version,
                    created: fixture.created,
                    platform: 'linux/amd64'
                }),
            /excessive data after the end marker/
        )
    } finally {
        fixture.cleanup()
    }
})

test('Docker archive verification rejects link, device, FIFO and sparse tar member types', async () => {
    for (const entry of [
        { path: 'symbolic-link', type: '2', linkPath: 'manifest.json' },
        { path: 'hard-link', type: '1', linkPath: 'manifest.json' },
        { path: 'character-device', type: '3' },
        { path: 'block-device', type: '4' },
        { path: 'fifo', type: '6' },
        { path: 'sparse', type: 'S' }
    ]) {
        const fixture = createDockerArchiveFixture({ extraEntries: [entry] })
        try {
            await assert.rejects(
                () =>
                    verifyDockerArchive({
                        archivePath: fixture.archivePath,
                        imageTag: fixture.tag,
                        revision: fixture.revision,
                        source: fixture.source,
                        version: fixture.version,
                        created: fixture.created,
                        platform: 'linux/amd64'
                    }),
                /link, device, FIFO, sparse or unsupported member/
            )
        } finally {
            fixture.cleanup()
        }
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
        assert.equal(
            manifest.inputs.files.some((entry) => entry.path === 'scripts/flowise-production-release.py'),
            true
        )
        assert.equal(
            manifest.inputs.files.some((entry) => entry.path === 'scripts/deployment-bundle.mjs'),
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
    assert.equal(workflow.match(/^\s+run:\s*pnpm metadata:i18n:validate:built\s*$/gm)?.length, 1)
    assert.ok(workflow.indexOf('run: pnpm build') < workflow.indexOf('run: pnpm metadata:i18n:validate:built'))

    for (const workspace of ['agentflow', 'observe', 'components', 'server']) {
        const packageJsonPath = fileURLToPath(new URL(`../packages/${workspace}/package.json`, import.meta.url))
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
        assert.equal(packageJson.scripts?.['test:coverage'], 'jest --coverage', `${workspace} must retain full coverage`)
    }
})

test('root Dockerfile removes dynamic Turbo output and supplies a validated epoch to fontconfig', () => {
    const dockerfile = readFileSync(ROOT_DOCKERFILE_PATH, 'utf8')
    const buildLock = readFileSync(APK_BUILD_LOCK_PATH, 'utf8').trim().split('\n')
    const runtimeLock = readFileSync(APK_RUNTIME_LOCK_PATH, 'utf8').trim().split('\n')
    const cleanup = validateRootDockerfileReproducibility(dockerfile)

    validateApkClosureContracts(dockerfile, [
        { label: 'build', lockName: 'apk-build.lock', entries: buildLock },
        { label: 'runtime', lockName: 'apk-runtime.lock', entries: runtimeLock }
    ])

    for (const [label, entries] of [
        ['build', buildLock],
        ['runtime', runtimeLock]
    ]) {
        assert.ok(entries.length > 100, `${label} APK lock must bind the complete transitive closure`)
        assert.deepEqual(entries, [...new Set(entries)].sort(), `${label} APK lock must be sorted and unique`)
        assert.equal(
            entries.every((entry) => /^[A-Za-z0-9+_.-]+=[A-Za-z0-9+_.~-]+$/.test(entry)),
            true,
            `${label} APK lock entries must contain exact versions`
        )
    }
    assert.doesNotMatch(dockerfile, /\bapk update\b/)
    assert.match(dockerfile, /COPY docker\/apk-build\.lock \/tmp\/apk-build\.lock/)
    assert.match(dockerfile, /COPY docker\/apk-runtime\.lock \/tmp\/apk-runtime\.lock/)
    assert.equal(dockerfile.match(/comm -13 \/tmp\/apk-before\.lock \/tmp\/apk-after\.lock/g)?.length, 2)
    assert.match(dockerfile, /cmp -s \/tmp\/apk-build\.lock \/tmp\/apk-actual\.lock/)
    assert.match(dockerfile, /cmp -s \/tmp\/apk-runtime\.lock \/tmp\/apk-actual\.lock/)
    assert.equal(dockerfile.match(/^ARG SOURCE_DATE_EPOCH=0$/gm)?.length, 1)
    assert.equal(dockerfile.match(/^ARG SOURCE_DATE_EPOCH$/gm)?.length, 2)
    assert.equal(dockerfile.match(/SOURCE_DATE_EPOCH must be a non-negative integer/g)?.length, 2)
    assert.equal(dockerfile.match(/SOURCE_DATE_EPOCH="\$SOURCE_DATE_EPOCH" fc-cache -fv/g)?.length, 2)
    assert.doesNotMatch(cleanup, /node_modules\/\.cache\/\*|packages\/\*\/\.turbo/)
})

test('APK closure contracts reject isolated direct-pin and Chromium closure mutations', () => {
    const dockerfile = readFileSync(ROOT_DOCKERFILE_PATH, 'utf8')
    const buildLock = readFileSync(APK_BUILD_LOCK_PATH, 'utf8').trim().split('\n')
    const runtimeLock = readFileSync(APK_RUNTIME_LOCK_PATH, 'utf8').trim().split('\n')
    const validate = (dockerfileSource, runtimeEntries) =>
        validateApkClosureContracts(dockerfileSource, [
            { label: 'build', lockName: 'apk-build.lock', entries: buildLock },
            { label: 'runtime', lockName: 'apk-runtime.lock', entries: runtimeEntries }
        ])

    const chromiumEntry = runtimeLock.find((entry) => entry.startsWith('chromium='))
    assert.ok(chromiumEntry, 'Chromium closure mutation source must exist')
    const chromiumVersion = chromiumEntry.slice('chromium='.length)
    const revision = /^(.*-r)(\d+)$/.exec(chromiumVersion)
    assert.ok(revision, 'Chromium closure mutation source must use an APK revision')
    const alternateVersion = `${revision[1]}${Number(revision[2]) + 1}`

    const directPinOnly = replaceWorkflowTextOnce(
        dockerfile,
        `chromium=${chromiumVersion}`,
        `chromium=${alternateVersion}`,
        'Dockerfile Chromium direct pin'
    )
    assert.throws(() => validate(directPinOnly, runtimeLock), /must exist unchanged in its complete closure/)

    const singleClosureOnly = runtimeLock.map((entry) =>
        entry === `chromium-common=${chromiumVersion}` ? `chromium-common=${alternateVersion}` : entry
    )
    assert.notDeepEqual(singleClosureOnly, runtimeLock, 'Chromium closure mutation target must exist')
    assert.throws(() => validate(dockerfile, singleClosureOnly), /Chromium runtime packages must use one identical version/)
})

test('root Dockerfile reproducibility cleanup rejects timestamped APK, pnpm state and root Turbo regressions', () => {
    const dockerfile = readFileSync(ROOT_DOCKERFILE_PATH, 'utf8')
    const mutations = [
        dockerfile.replace('/var/log/apk.log', '/var/log/apk-timestamp.log'),
        replaceWorkflowTextOnce(dockerfile, '        node_modules/.modules.yaml \\\n', '', 'Dockerfile pnpm modules metadata cleanup'),
        replaceWorkflowTextOnce(
            dockerfile,
            '        node_modules/.pnpm-workspace-state-v1.json && \\\n',
            '',
            'Dockerfile pnpm workspace state cleanup'
        ),
        replaceWorkflowTextOnce(dockerfile, '        .turbo \\\n', '', 'Dockerfile root Turbo cleanup')
    ]

    for (const mutated of mutations) {
        assert.throws(() => validateRootDockerfileReproducibility(mutated))
    }
})

test('build-only Docker CI produces and reconsumes a canonical offline release artifact without registry side effects', () => {
    const workflow = readFileSync(DOCKER_BUILD_WORKFLOW_PATH, 'utf8')
    const candidateScript = readFileSync(RELEASE_CANDIDATE_SCRIPT_PATH, 'utf8')
    validatePrimaryBuildStep(workflow)

    for (const required of [
        'permissions:',
        'contents: read',
        'concurrency:',
        'timeout-minutes:',
        'runs-on: ubuntu-24.04',
        'test "$(uname -m)" = x86_64',
        'CANDIDATE_SHA: ${{ github.event.pull_request.head.sha || github.sha }}',
        'ref: ${{ env.CANDIDATE_SHA }}',
        'persist-credentials: false',
        'git ls-files --error-unmatch',
        'pnpm audit --prod --audit-level high',
        'pnpm metadata:i18n:validate',
        'scripts/metadata-i18n/extract.mjs',
        'scripts/metadata-i18n/fingerprint.mjs',
        'scripts/metadata-i18n/fingerprint.test.mjs',
        'scripts/metadata-i18n/validate.mjs',
        'scripts/metadata-i18n/write-build-fingerprint.mjs',
        'bash scripts/verify-release-candidate.sh',
        'scripts/deployment-bundle.mjs',
        'scripts/flowise-production-release.py',
        'BUNDLE_DIR:',
        'path: ${{ env.BUNDLE_DIR }}',
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
        'flowise-chinese:git-',
        'node scripts/release-manifest.mjs generate',
        'node scripts/release-manifest.mjs verify',
        'node scripts/release-manifest.mjs verify-archive',
        'node "$REPO_ROOT/scripts/deployment-bundle.mjs" generate',
        'node "$REPO_ROOT/scripts/deployment-bundle.mjs" verify',
        'production_compose_sha256=',
        'production_wrapper_sha256=',
        "EXPECTED_BUILDX_VERSION='v0.34.1'",
        "EXPECTED_BUILDKIT_VERSION='v0.30.0'",
        '[[ "$store_identity" == "$image_config_digest" ]]',
        'buildx_version=',
        'buildkit_version=',
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
    validateReadinessRebuildStep(workflow)

    for (const required of [
        "github.event_name == 'workflow_dispatch'",
        "github.ref == 'refs/heads/main'",
        'name: release-readiness',
        'timeout-minutes: 120',
        'actions/download-artifact@',
        'expected_tag="flowise-chinese:git-${GITHUB_SHA}"',
        'expected_source="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"',
        'expected_version="git-${GITHUB_SHA}"',
        'expected_created="$(git show -s --format=%cI "$GITHUB_SHA")"',
        'node scripts/release-manifest.mjs verify-archive',
        'node scripts/release-manifest.mjs verify',
        'node scripts/deployment-bundle.mjs verify',
        'test -s "$BUNDLE_DIR/deployment-bundle.json"',
        'docker image load --input "$ARCHIVE_PATH"',
        'docker image rm "$expected_tag"',
        '--require-clean'
    ]) {
        assert.equal(workflow.includes(required), true, `missing release-readiness contract: ${required}`)
    }

    assert.doesNotMatch(workflow, /\bssh\b|\bscp\b|docker\/login-action|push:\s*true|secrets\./i)
    assert.doesNotMatch(workflow, /manifest\.image\.(?:tag|config_digest)/)
    assert.doesNotMatch(workflow, /^\s+load:\s*true\s*$|--load\b/m)
})

test('Docker Hub publishing validates a reviewed alias before credentials and builds only the canonical root Dockerfile', () => {
    const workflow = readFileSync(DOCKERHUB_WORKFLOW_PATH, 'utf8')
    validateDockerHubBuildStep(workflow)

    for (const required of [
        'type: string',
        'expected_image_config_digest:',
        'environment:',
        'name: dockerhub-release',
        'PUBLISH_ENABLED: ${{ vars.DOCKERHUB_RELEASE_ENABLED }}',
        'PUBLISH_IMAGE: ${{ vars.DOCKERHUB_IMAGE }}',
        'test "$PUBLISH_ENABLED" = \'true\'',
        'TAG_VERSION: ${{ inputs.tag_version }}',
        "if: github.ref == 'refs/heads/main'",
        '[[ ${#TAG_VERSION} -le 128 ]]',
        '[[ "$TAG_VERSION" =~',
        'pnpm audit --prod --audit-level high',
        'pnpm metadata:i18n:validate',
        'scripts/metadata-i18n/extract.mjs',
        'scripts/metadata-i18n/fingerprint.mjs',
        'scripts/metadata-i18n/fingerprint.test.mjs',
        'scripts/metadata-i18n/validate.mjs',
        'scripts/metadata-i18n/write-build-fingerprint.mjs',
        'git ls-files --error-unmatch',
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
        'test "$actual_config_digest" = "$EXPECTED_IMAGE_CONFIG_DIGEST"',
        '--archive "$ARCHIVE_PATH"',
        '--manifest "$MANIFEST_PATH"',
        '--immutability-settings "$IMMUTABILITY_SETTINGS_PATH"'
    ]) {
        assert.equal(workflow.includes(required), true, `missing hardened Docker Hub contract: ${required}`)
    }

    assert.doesNotMatch(
        workflow,
        /default:\s*['"]?latest|docker\/Dockerfile|docker\/worker\/Dockerfile|npm install -g flowise|push:\s*true/
    )
    assert.doesNotMatch(workflow, /^\s+load:\s*true\s*$|--load\b/m)
    assert.doesNotMatch(workflow, /PUBLISH_IMAGE:\s*flowiseai\/flowise/)
    assert.doesNotMatch(workflow, /\/v2\/users\/login\//)
    assert.match(workflow, /\[\[ "\$PUBLISH_IMAGE" != flowiseai\/\* \]\]/)
    assert.match(workflow, /test "\$\{PUBLISH_IMAGE%%\/\*\}" = "\$registry_username"/)
    assert.doesNotMatch(workflow, /docker push/)
    assert.doesNotMatch(workflow, /pnpm audit[^\n]*(?:\|\||;\s*true)/)
    assert.doesNotMatch(workflow, /^ {12}[A-Z_]+:\s*\$\{\{\s*runner\.temp\b/gm)
    assert.equal((workflow.match(/\$\{\{ inputs\.tag_version \}\}/g) ?? []).length, 1)
    assert.equal((workflow.match(/\$\{\{ inputs\.expected_image_config_digest \}\}/g) ?? []).length, 1)
    assert.equal(
        (
            workflow.match(
                /\$\{\{ runner\.temp \}\}\/flowise-dockerhub-git-\$\{\{ github\.sha \}\}-linux-amd64\/release-manifest\.json/g
            ) ?? []
        ).length,
        3
    )
    assert.doesNotMatch(workflow, /flowise-dockerhub-git-\$\{\{ github\.sha \}\}-manifest\.json/)
    assert.ok(workflow.indexOf('bash scripts/verify-release-candidate.sh') < workflow.indexOf('docker/login-action@'))
    assert.ok(workflow.indexOf('test "$actual_config_digest" = "$EXPECTED_IMAGE_CONFIG_DIGEST"') < workflow.indexOf('docker/login-action@'))
    assert.ok(workflow.indexOf('node scripts/verify-dockerhub-immutability.mjs') < workflow.indexOf('docker/login-action@'))
    assertExternalActionsAreCommitPinned(workflow, 'Docker Hub publishing workflow')
})

test('every build and publication workflow enforces the current component metadata receipt', () => {
    const contracts = [
        ['main CI', MAIN_WORKFLOW_PATH, 'pnpm metadata:i18n:validate:built', 'pnpm build'],
        ['build-only Docker CI', DOCKER_BUILD_WORKFLOW_PATH, 'pnpm metadata:i18n:validate', 'pnpm install --frozen-lockfile'],
        ['Docker Hub publishing', DOCKERHUB_WORKFLOW_PATH, 'pnpm metadata:i18n:validate', 'pnpm install --frozen-lockfile'],
        ['ECR build-only CI', ECR_WORKFLOW_PATH, 'pnpm metadata:i18n:validate', 'pnpm install --frozen-lockfile']
    ]

    for (const [label, workflowPath, metadataGate, prerequisite] of contracts) {
        const workflow = readFileSync(workflowPath, 'utf8')
        assert.equal(workflow.split(metadataGate).length - 1, 1, `${label} must run exactly one metadata gate`)
        assert.ok(
            workflow.indexOf(prerequisite) < workflow.indexOf(metadataGate),
            `${label} must prepare the build before metadata validation`
        )
        assert.doesNotMatch(workflow, /metadata:i18n:validate[^\n]*(?:\|\||;\s*true)/)
    }
})

test('workflow reproducibility contracts reject commented or removed active fields in their named build steps', () => {
    const buildWorkflow = readFileSync(DOCKER_BUILD_WORKFLOW_PATH, 'utf8')
    const dockerHubWorkflow = readFileSync(DOCKERHUB_WORKFLOW_PATH, 'utf8')
    const contracts = [
        {
            label: 'primary pre-reset clean-tree proof',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            stepName: PRIMARY_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git status --porcelain --untracked-files=all)"',
            mutationOptions: { occurrence: 0, expectedCount: 2 }
        },
        {
            label: 'primary ignored-file context reset',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            stepName: PRIMARY_CONTRACT_STEP_NAME,
            activeText: 'git clean -dffqx'
        },
        {
            label: 'primary post-reset clean-tree proof',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            stepName: PRIMARY_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git status --porcelain --untracked-files=all)"',
            mutationOptions: { occurrence: 1, expectedCount: 2 }
        },
        {
            label: 'primary empty cleanup dry-run proof',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            stepName: PRIMARY_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git clean -ndffx)"'
        },
        {
            label: 'primary SOURCE_DATE_EPOCH producer',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            activeText: 'echo "source_date_epoch=$(git show -s --format=%ct "$CANDIDATE_SHA")" >> "$GITHUB_OUTPUT"'
        },
        {
            label: 'primary SOURCE_DATE_EPOCH environment',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            activeText: 'SOURCE_DATE_EPOCH: ${{ steps.metadata.outputs.source_date_epoch }}'
        },
        {
            label: 'primary outputs',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            activeText: 'outputs: type=docker,name=flowise-chinese:${{ steps.metadata.outputs.version }},rewrite-timestamp=true'
        },
        {
            label: 'primary SOURCE_DATE_EPOCH build argument',
            validate: validatePrimaryBuildStep,
            source: buildWorkflow,
            activeText: 'SOURCE_DATE_EPOCH=${{ steps.metadata.outputs.source_date_epoch }}'
        },
        {
            label: 'readiness canonical rebuild tag',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: 'REBUILD_TAG: flowise-chinese:git-${{ github.sha }}'
        },
        {
            label: 'readiness exact SHA proof',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            stepName: READINESS_REBUILD_STEP_NAME,
            activeText: 'test "$GITHUB_SHA" = "$(git rev-parse HEAD)"'
        },
        {
            label: 'readiness clean-tree proof',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            stepName: READINESS_REBUILD_STEP_NAME,
            activeText: 'test -z "$(git status --porcelain --untracked-files=all)"'
        },
        {
            label: 'readiness empty cleanup dry-run proof',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            stepName: READINESS_REBUILD_STEP_NAME,
            activeText: 'test -z "$(git clean -ndffx)"'
        },
        {
            label: 'readiness SOURCE_DATE_EPOCH producer',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: 'source_date_epoch="$(git show -s --format=%ct "$GITHUB_SHA")"'
        },
        {
            label: 'readiness independent archive environment',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: 'INDEPENDENT_ARCHIVE_PATH: ${{ runner.temp }}/flowise-release-readiness-independent.tar.gz'
        },
        {
            label: 'readiness canonical Dockerfile',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: '--file Dockerfile \\'
        },
        {
            label: 'readiness Docker exporter',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: '--output "type=docker,name=$REBUILD_TAG,rewrite-timestamp=true" \\'
        },
        {
            label: 'readiness SOURCE_DATE_EPOCH build argument',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: '--build-arg "SOURCE_DATE_EPOCH=$source_date_epoch" \\'
        },
        {
            label: 'readiness safe digest mismatch summary',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: "printf 'release_readiness_config_mismatch expected=%s actual=%s\\n' \\"
        },
        {
            label: 'readiness raw digest equality',
            validate: validateReadinessRebuildStep,
            source: buildWorkflow,
            activeText: 'test "$independent_config_digest" = "$expected_config_digest"'
        },
        {
            label: 'Docker Hub pre-reset clean-tree proof',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            stepName: DOCKERHUB_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git status --porcelain --untracked-files=all)"',
            mutationOptions: { occurrence: 0, expectedCount: 2 }
        },
        {
            label: 'Docker Hub ignored-file context reset',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            stepName: DOCKERHUB_CONTRACT_STEP_NAME,
            activeText: 'git clean -dffqx'
        },
        {
            label: 'Docker Hub post-reset clean-tree proof',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            stepName: DOCKERHUB_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git status --porcelain --untracked-files=all)"',
            mutationOptions: { occurrence: 1, expectedCount: 2 }
        },
        {
            label: 'Docker Hub empty cleanup dry-run proof',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            stepName: DOCKERHUB_CONTRACT_STEP_NAME,
            activeText: 'test -z "$(git clean -ndffx)"'
        },
        {
            label: 'Docker Hub SOURCE_DATE_EPOCH producer',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            activeText: `printf 'source_date_epoch=%s\\n' "$(git show -s --format=%ct "$GITHUB_SHA")" >> "$GITHUB_OUTPUT"`
        },
        {
            label: 'Docker Hub SOURCE_DATE_EPOCH environment',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            activeText: 'SOURCE_DATE_EPOCH: ${{ steps.metadata.outputs.source_date_epoch }}'
        },
        {
            label: 'Docker Hub outputs',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            activeText: 'outputs: type=docker,name=flowise-chinese:git-${{ github.sha }},rewrite-timestamp=true'
        },
        {
            label: 'Docker Hub SOURCE_DATE_EPOCH build argument',
            validate: validateDockerHubBuildStep,
            source: dockerHubWorkflow,
            activeText: 'SOURCE_DATE_EPOCH=${{ steps.metadata.outputs.source_date_epoch }}'
        }
    ]

    for (const contract of contracts) {
        for (const mutation of ['commented', 'removed']) {
            const label = `${contract.label} ${mutation}`
            const replacement = mutation === 'commented' ? `# ${contract.activeText}` : ''
            const mutated = contract.stepName
                ? replaceNamedWorkflowStepText(
                      contract.source,
                      contract.stepName,
                      contract.activeText,
                      replacement,
                      label,
                      contract.mutationOptions
                  )
                : replaceWorkflowTextOnce(contract.source, contract.activeText, replacement, label)
            assert.throws(() => contract.validate(mutated), `${label} must invalidate the named-step contract`)
        }
    }

    assert.throws(() =>
        validatePrimaryBuildStep(
            replaceWorkflowTextOnce(
                buildWorkflow,
                'git show -s --format=%ct "$CANDIDATE_SHA"',
                'date +%s',
                'primary SOURCE_DATE_EPOCH wrong producer'
            )
        )
    )
    assert.throws(() =>
        validateReadinessRebuildStep(
            replaceWorkflowTextOnce(
                buildWorkflow,
                'git show -s --format=%ct "$GITHUB_SHA"',
                'date +%s',
                'readiness SOURCE_DATE_EPOCH wrong producer'
            )
        )
    )
    assert.throws(() =>
        validateDockerHubBuildStep(
            replaceWorkflowTextOnce(
                dockerHubWorkflow,
                'git show -s --format=%ct "$GITHUB_SHA"',
                'date +%s',
                'Docker Hub SOURCE_DATE_EPOCH wrong producer'
            )
        )
    )
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
