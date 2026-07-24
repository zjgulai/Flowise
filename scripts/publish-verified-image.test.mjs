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
const RAW_MANIFEST = JSON.stringify({ schemaVersion: 2, config: { digest: CONFIG_DIGEST }, layers: [] })
const OTHER_RAW_MANIFEST = JSON.stringify({ schemaVersion: 2, config: { digest: OTHER_CONFIG_DIGEST }, layers: [] })

const createFixture = () => {
    const root = mkdtempSync(join(tmpdir(), 'flowise-publisher-test-'))
    const bin = join(root, 'bin')
    const state = join(root, 'state')
    const manifest = join(root, 'manifest.json')
    const log = join(root, 'docker.log')
    const immutabilitySettings = join(root, 'dockerhub-repository.json')
    mkdirSync(bin)
    mkdirSync(state)
    writeFileSync(log, '')
    writeFileSync(
        manifest,
        `${JSON.stringify({ source: { revision: SHA }, image: { tag: `flowise-ci:git-${SHA}`, config_digest: CONFIG_DIGEST } })}\n`
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
    if [[ "\${FAKE_INSPECT_ERROR:-}" == true ]]; then
        printf 'unauthorized: authentication required\\n' >&2
        exit 1
    fi
    key=$(key_for_ref "$4")
    path="$FAKE_DOCKER_STATE/$key.raw"
    if [[ ! -f "$path" ]]; then
        printf 'manifest unknown: manifest not found\\n' >&2
        exit 1
    fi
    command cat "$path"
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

    const run = (extraEnv = {}) =>
        spawnSync(
            'bash',
            [
                SCRIPT_PATH,
                '--image-tag',
                `flowise-ci:git-${SHA}`,
                '--publish-image',
                'owner/flowise',
                '--git-sha',
                SHA,
                '--release-tag',
                'v1.2.3',
                '--manifest',
                manifest,
                '--immutability-settings',
                immutabilitySettings
            ],
            {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    PATH: `${bin}:${process.env.PATH}`,
                    FAKE_DOCKER_LOG: log,
                    FAKE_DOCKER_STATE: state,
                    FAKE_LOCAL_MANIFEST: RAW_MANIFEST,
                    ...extraEnv
                }
            }
        )

    return {
        root,
        state,
        log,
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
        assert.equal(readFileSync(join(fixture.state, 'git.raw'), 'utf8'), RAW_MANIFEST)
        assert.equal(readFileSync(join(fixture.state, 'release.raw'), 'utf8'), RAW_MANIFEST)
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
        const result = inconclusive.run({ FAKE_INSPECT_ERROR: 'true' })
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, /inspection was inconclusive/)
        assert.doesNotMatch(readFileSync(inconclusive.log, 'utf8'), /^push /m)
    } finally {
        inconclusive.cleanup()
    }
})
