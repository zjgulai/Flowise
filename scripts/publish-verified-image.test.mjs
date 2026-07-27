import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(new URL('./publish-verified-image.sh', import.meta.url))
const SHA = '1'.repeat(40)
const CONFIG_DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_CONFIG_DIGEST = `sha256:${'b'.repeat(64)}`
const STORE_IDENTITY = `sha256:${'c'.repeat(64)}`
const REPOSITORY_URL = 'https://example.invalid/owner/flowise.git'
const IMAGE_CREATED = '2026-07-27T00:00:00.000Z'
const RAW_MANIFEST = JSON.stringify({ schemaVersion: 2, config: { digest: CONFIG_DIGEST }, layers: [] })
const OTHER_RAW_MANIFEST = JSON.stringify({ schemaVersion: 2, config: { digest: OTHER_CONFIG_DIGEST }, layers: [] })

const createFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'flowise-publisher-test-'))
    const bin = join(root, 'bin')
    const state = join(root, 'state')
    const manifest = join(root, 'manifest.json')
    const archive = join(root, 'image.tar.gz')
    const log = join(root, 'docker.log')
    const immutabilitySettings = join(root, 'dockerhub-repository.json')
    mkdirSync(bin)
    mkdirSync(state)
    writeFileSync(log, '')
    writeFileSync(archive, 'fixture archive\n')
    writeFileSync(
        manifest,
        `${JSON.stringify({
            release_id: `git-${SHA}`,
            source: { repository_url: REPOSITORY_URL, revision: SHA },
            image: { tag: `flowise-chinese:git-${SHA}`, config_digest: CONFIG_DIGEST, platform: 'linux/amd64' }
        })}\n`
    )
    writeFileSync(
        immutabilitySettings,
        `${JSON.stringify({ namespace: 'owner', name: 'flowise', immutable_tags_settings: { enabled: true, rules: [] } })}\n`
    )
    const docker = join(bin, 'docker')
    writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
key_for_ref() {
    if [[ "$1" == *:git-* ]]; then printf 'git'; else printf 'release'; fi
}
if [[ "\${1:-}" == buildx && "\${2:-}" == imagetools && "\${3:-}" == inspect && "\${5:-}" == --raw ]]; then
    key=$(key_for_ref "$4")
    path="$FAKE_DOCKER_STATE/$key.raw"
    if [[ ! -f "$path" ]]; then
        error_message="\${FAKE_INSPECT_ERROR_MESSAGE:-manifest unknown: manifest not found}"
        error_message="\${error_message//__REF__/$4}"
        printf '%s\\n' "$error_message" >&2
        exit 1
    fi
    command cat "$path"
    exit 0
fi
if [[ "\${1:-}" == load && "\${2:-}" == --input ]]; then
    if [[ "\${FAKE_LOAD_ERROR:-}" == true ]]; then
        printf 'archive load failed\\n' >&2
        exit 1
    fi
    exit 0
fi
if [[ "\${1:-}" == image && "\${2:-}" == inspect ]]; then
    if [[ "\${FAKE_LOCAL_IMAGE_MISSING:-}" == true ]]; then
        printf 'Error response from daemon: No such image: %s\\n' "\${3:-}" >&2
        exit 1
    fi
    printf '[{"Id":"%s","Os":"%s","Architecture":"%s","Config":{"User":"%s","Cmd":["node","packages/server/bin/run","start"],"Labels":{"org.opencontainers.image.source":"%s","org.opencontainers.image.revision":"%s","org.opencontainers.image.version":"%s","org.opencontainers.image.created":"%s"}}}]\\n' \
        "$FAKE_LOCAL_STORE_IDENTITY" \
        "\${FAKE_LOCAL_OS:-linux}" \
        "\${FAKE_LOCAL_ARCHITECTURE:-amd64}" \
        "\${FAKE_LOCAL_USER:-node}" \
        "$FAKE_LOCAL_SOURCE" \
        "$FAKE_LOCAL_REVISION" \
        "$FAKE_LOCAL_VERSION" \
        "$FAKE_LOCAL_CREATED"
    exit 0
fi
if [[ "\${1:-}" == tag ]]; then exit 0; fi
if [[ "\${1:-}" == push ]]; then
    key=$(key_for_ref "$2")
    printf '%s' "$FAKE_LOCAL_MANIFEST" > "$FAKE_DOCKER_STATE/$key.raw"
    exit 0
fi
printf 'unexpected docker invocation\\n' >&2
exit 2
`
    )
    chmodSync(docker, 0o755)
    const node = join(bin, 'node')
    writeFileSync(
        node,
        `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
    */verify-dockerhub-immutability.mjs)
        exec "$REAL_NODE" "$@"
        ;;
    */release-manifest.mjs)
        case "\${2:-}" in
            verify)
                if [[ "\${FAKE_MANIFEST_VERIFY_ERROR:-}" == true ]]; then
                    printf 'Release manifest error: Image archive mismatch\\n' >&2
                    exit 1
                fi
                exit 0
                ;;
            verify-archive)
                if [[ "\${FAKE_ARCHIVE_VERIFY_ERROR:-}" == true ]]; then
                    printf 'Release manifest error: Docker archive semantic mismatch\\n' >&2
                    exit 1
                fi
                printf '%s\\n' "$FAKE_ARCHIVE_CONFIG_DIGEST"
                exit 0
                ;;
        esac
        ;;
esac
printf 'unexpected node invocation\\n' >&2
exit 2
`
    )
    chmodSync(node, 0o755)

    const run = (extraEnv = {}) =>
        spawnSync(
            'bash',
            [
                SCRIPT_PATH,
                '--image-tag',
                `flowise-chinese:git-${SHA}`,
                '--publish-image',
                'owner/flowise',
                '--git-sha',
                SHA,
                '--release-tag',
                'v1.2.3',
                '--manifest',
                manifest,
                '--archive',
                archive,
                '--immutability-settings',
                immutabilitySettings
            ],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    REAL_NODE: process.execPath,
                    FAKE_DOCKER_LOG: log,
                    FAKE_DOCKER_STATE: state,
                    FAKE_ARCHIVE_CONFIG_DIGEST: CONFIG_DIGEST,
                    FAKE_LOCAL_STORE_IDENTITY: STORE_IDENTITY,
                    FAKE_LOCAL_SOURCE: REPOSITORY_URL,
                    FAKE_LOCAL_REVISION: SHA,
                    FAKE_LOCAL_VERSION: `git-${SHA}`,
                    FAKE_LOCAL_CREATED: IMAGE_CREATED,
                    FAKE_LOCAL_MANIFEST: RAW_MANIFEST,
                    ...extraEnv
                }
            }
        )

    return {
        root,
        state,
        log,
        archive,
        immutabilitySettings,
        run,
        cleanup: () => rmSync(root, { recursive: true, force: true })
    }
}

test('publisher requires all-tags server-side immutability before touching Docker', () => {
    const fixture = createFixture()
    try {
        writeFileSync(
            fixture.immutabilitySettings,
            `${JSON.stringify({
                namespace: 'owner',
                name: 'flowise',
                immutable_tags_settings: { enabled: true, rules: ['^git-[0-9a-f]{40}$', '^v[0-9]+\\.[0-9]+\\.[0-9]+$'] }
            })}\n`
        )
        const result = fixture.run()
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /server-side immutable tag policy is not proven/)
        assert.equal(readFileSync(fixture.log, 'utf8'), '')
    } finally {
        fixture.cleanup()
    }
})

test('publisher creates both absent tags and verifies an identical remote manifest', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run()
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /Verified immutable image publication completed/)
        const log = readFileSync(fixture.log, 'utf8')
        assert.equal((log.match(/^push /gm) ?? []).length, 2)
        assert.match(log, new RegExp('^tag ' + STORE_IDENTITY + ' owner/flowise:git-' + SHA + '$', 'm'))
        assert.match(log, new RegExp('^tag ' + STORE_IDENTITY + ' owner/flowise:v1\\.2\\.3$', 'm'))
        assert.equal(readFileSync(join(fixture.state, 'git.raw'), 'utf8'), RAW_MANIFEST)
        assert.equal(readFileSync(join(fixture.state, 'release.raw'), 'utf8'), RAW_MANIFEST)
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects a missing archive before touching Docker or the registry', () => {
    const fixture = createFixture()
    try {
        rmSync(fixture.archive)
        const result = fixture.run()
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /release image archive is unavailable/)
        assert.equal(readFileSync(fixture.log, 'utf8'), '')
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects a manifest/archive hash mismatch before touching Docker or the registry', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run({ FAKE_MANIFEST_VERIFY_ERROR: 'true' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /release manifest and image archive verification failed/)
        assert.equal(readFileSync(fixture.log, 'utf8'), '')
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects an archive config digest mismatch before any registry inspection or publication', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run({ FAKE_ARCHIVE_CONFIG_DIGEST: OTHER_CONFIG_DIGEST })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /verified archive config digest mismatch/)
        const log = readFileSync(fixture.log, 'utf8')
        assert.match(log, /^load --input /m)
        assert.match(log, /^image inspect /m)
        assert.doesNotMatch(log, /^buildx imagetools inspect /m)
        assert.doesNotMatch(log, /^(?:tag|push) /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects an archive load failure before any registry inspection or publication', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run({ FAKE_LOAD_ERROR: 'true' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /verified image archive could not be loaded/)
        const log = readFileSync(fixture.log, 'utf8')
        assert.match(log, /^load --input /m)
        assert.doesNotMatch(log, /^image inspect /m)
        assert.doesNotMatch(log, /^buildx imagetools inspect /m)
        assert.doesNotMatch(log, /^(?:tag|push) /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects a missing loaded tag before any registry inspection or publication', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run({ FAKE_LOCAL_IMAGE_MISSING: 'true' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /loaded local image is unavailable/)
        const log = readFileSync(fixture.log, 'utf8')
        assert.match(log, /^load --input /m)
        assert.match(log, /^image inspect /m)
        assert.doesNotMatch(log, /^buildx imagetools inspect /m)
        assert.doesNotMatch(log, /^(?:tag|push) /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher rejects loaded image metadata drift before any registry inspection or publication', () => {
    const fixture = createFixture()
    try {
        const result = fixture.run({ FAKE_LOCAL_REVISION: '2'.repeat(40) })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /loaded local image revision label mismatch/)
        const log = readFileSync(fixture.log, 'utf8')
        assert.match(log, /^load --input /m)
        assert.match(log, /^image inspect /m)
        assert.doesNotMatch(log, /^buildx imagetools inspect /m)
        assert.doesNotMatch(log, /^(?:tag|push) /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher treats equal pre-existing tags as an idempotent no-op', () => {
    const fixture = createFixture()
    try {
        writeFileSync(join(fixture.state, 'git.raw'), RAW_MANIFEST)
        writeFileSync(join(fixture.state, 'release.raw'), RAW_MANIFEST)
        const result = fixture.run()
        assert.equal(result.status, 0, result.stderr)
        assert.match(result.stdout, /already complete and immutable/)
        assert.doesNotMatch(readFileSync(fixture.log, 'utf8'), /^push /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher refuses to overwrite tags that point to another config', () => {
    const fixture = createFixture()
    try {
        writeFileSync(join(fixture.state, 'git.raw'), OTHER_RAW_MANIFEST)
        writeFileSync(join(fixture.state, 'release.raw'), OTHER_RAW_MANIFEST)
        const result = fixture.run()
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /different image config/)
        assert.doesNotMatch(readFileSync(fixture.log, 'utf8'), /^push /m)
    } finally {
        fixture.cleanup()
    }
})

test('publisher fails closed on partial state or inconclusive registry inspection', () => {
    const partial = createFixture()
    try {
        writeFileSync(join(partial.state, 'git.raw'), RAW_MANIFEST)
        const result = partial.run()
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /partial release/)
        assert.doesNotMatch(readFileSync(partial.log, 'utf8'), /^push /m)
    } finally {
        partial.cleanup()
    }

    const inconclusive = createFixture()
    try {
        const result = inconclusive.run({ FAKE_INSPECT_ERROR_MESSAGE: 'unauthorized: authentication required' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /inspection was inconclusive/)
        assert.doesNotMatch(readFileSync(inconclusive.log, 'utf8'), /^push /m)
    } finally {
        inconclusive.cleanup()
    }
})

test('publisher only treats explicit missing-manifest errors as absent', () => {
    for (const errorMessage of ['Error response from daemon: manifest unknown: manifest unknown', 'no such manifest: __REF__']) {
        const fixture = createFixture()
        try {
            const result = fixture.run({ FAKE_INSPECT_ERROR_MESSAGE: errorMessage })
            assert.equal(result.status, 0, result.stderr)
            assert.equal((readFileSync(fixture.log, 'utf8').match(/^push /gm) ?? []).length, 2)
        } finally {
            fixture.cleanup()
        }
    }
})

test('publisher accepts the exact single-line Docker Hub missing-tag response for each ref', () => {
    for (const errorMessage of ['ERROR: __REF__: not found', 'ERROR: docker.io/__REF__: not found']) {
        const fixture = createFixture()
        try {
            const result = fixture.run({ FAKE_INSPECT_ERROR_MESSAGE: errorMessage })
            assert.equal(result.status, 0, result.stderr)
            assert.equal((readFileSync(fixture.log, 'utf8').match(/^push /gm) ?? []).length, 2)
        } finally {
            fixture.cleanup()
        }
    }
})

test('publisher treats generic missing and repository authorization errors as inconclusive', () => {
    for (const errorMessage of [
        'ERROR: docker.io/other/flowise:v1.2.3: not found',
        'pull access denied for owner/flowise, repository does not exist or may require authorization: server message: insufficient_scope: authorization failed'
    ]) {
        const fixture = createFixture()
        try {
            const result = fixture.run({ FAKE_INSPECT_ERROR_MESSAGE: errorMessage })
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /inspection was inconclusive/)
            assert.doesNotMatch(readFileSync(fixture.log, 'utf8'), /^(?:tag|push) /m)
        } finally {
            fixture.cleanup()
        }
    }
})

test('publisher rejects mixed or multiline registry errors even when they contain missing-manifest text', () => {
    for (const errorMessage of [
        'unauthorized: authentication required; manifest unknown',
        'dial tcp 203.0.113.10:443: i/o timeout; no such manifest: __REF__',
        'manifest unknown: repository does not exist or may require authorization',
        'ERROR: __REF__: not found\nunauthorized: authentication required'
    ]) {
        const fixture = createFixture()
        try {
            const result = fixture.run({ FAKE_INSPECT_ERROR_MESSAGE: errorMessage })
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /inspection was inconclusive/)
            assert.doesNotMatch(readFileSync(fixture.log, 'utf8'), /^(?:tag|push) /m)
        } finally {
            fixture.cleanup()
        }
    }
})
