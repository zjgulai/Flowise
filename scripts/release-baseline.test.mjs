import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
    classifyRuntime,
    parseApkInstalledSize,
    parseArgs,
    parseHumanBytes,
    scanUiDist,
    summarizeHistory,
    summarizeImageInspect,
    summarizeRuntimeProbe
} from './release-baseline.mjs'

const REVISION = 'a'.repeat(40)
const IMAGE = `flowise-chinese:git-${REVISION}`
const DOCKERFILE_PATH = fileURLToPath(new URL('../Dockerfile', import.meta.url))
const SLIM_PROBE_PATH = fileURLToPath(new URL('./verify-runtime-without-compilers.sh', import.meta.url))

test('CLI accepts only an exact Git-derived local image and a bounded top-N', () => {
    assert.deepEqual(parseArgs(['--image', IMAGE, '--output', 'out.json', '--top', '7']), {
        image: IMAGE,
        output: 'out.json',
        uiDist: 'packages/ui/build',
        top: 7,
        measureArchive: false,
        revision: REVISION
    })
    assert.throws(() => parseArgs(['--image', 'flowise-chinese:latest', '--output', 'out.json']), /exact local image tag/)
    assert.throws(() => parseArgs(['--image', IMAGE, '--output', 'out.json', '--top', '0']), /between 1 and 50/)
})

test('human Docker sizes and history are normalized without retaining layer commands', () => {
    assert.equal(parseHumanBytes('1.31GB'), 1_310_000_000)
    assert.equal(parseHumanBytes('20.5kB'), 20_500)
    assert.equal(parseHumanBytes('unknown'), null)
    assert.equal(parseApkInstalledSize('g++-15.2.0-r5 installed size:\n45 MiB\n'), 45 * 1024 * 1024)
    assert.equal(parseApkInstalledSize('invalid'), null)
    const rows = summarizeHistory(
        [
            { Size: '1.31GB', CreatedBy: 'RUN apk add --no-cache chromium SECRET_SENTINEL' },
            { Size: '2.78GB', CreatedBy: 'COPY --chown=node:node /usr/src/flowise . SECRET_SENTINEL' }
        ],
        2
    )
    assert.deepEqual(
        rows.map(({ category, parsed_bytes }) => ({ category, parsed_bytes })),
        [
            { category: 'application_copy', parsed_bytes: 2_780_000_000 },
            { category: 'runtime_packages', parsed_bytes: 1_310_000_000 }
        ]
    )
    assert.equal(JSON.stringify(rows).includes('SECRET_SENTINEL'), false)
})

test('image summary binds platform, non-root user, tag revision and OCI revision', () => {
    const inspect = {
        Id: `sha256:${'b'.repeat(64)}`,
        Created: '2026-07-21T00:00:00Z',
        Architecture: 'amd64',
        Os: 'linux',
        Size: 100,
        RepoDigests: [],
        Config: {
            User: 'node',
            WorkingDir: '/usr/src/flowise',
            Cmd: ['node', 'packages/server/bin/run', 'start'],
            Labels: {
                'org.opencontainers.image.revision': REVISION,
                'org.opencontainers.image.source': 'https://example.invalid/repo.git'
            }
        }
    }
    assert.equal(summarizeImageInspect(inspect, IMAGE, REVISION, '5.34GB').docker_list_parsed_bytes, 5_340_000_000)
    inspect.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40)
    assert.throws(() => summarizeImageInspect(inspect, IMAGE, REVISION), /does not match/)
})

test('UI bundle scan is deterministic and reports missing output explicitly', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowise-ui-baseline-'))
    try {
        mkdirSync(join(root, 'assets'))
        writeFileSync(join(root, 'assets', 'app.js'), '12345')
        writeFileSync(join(root, 'assets', 'app.css'), '123')
        assert.deepEqual(scanUiDist(join(root, 'missing')), { state: 'not_built', path: join(root, 'missing') })
        const result = scanUiDist(root, 2)
        assert.equal(result.total_bytes, 8)
        assert.equal(result.js_bytes, 5)
        assert.equal(result.css_bytes, 3)
        assert.deepEqual(
            result.largest.map((file) => file.path),
            ['assets/app.js', 'assets/app.css']
        )
    } finally {
        rmSync(root, { recursive: true, force: true })
    }
})

test('compiler tools remain candidates only after selected native modules load', () => {
    const probe = {
        node: 'v24.18.0',
        platform: 'linux',
        arch: 'x64',
        uid: 1000,
        tools: { 'chromium-browser': true, curl: true },
        packages: {},
        modules: {
            sqlite3: { loaded: true },
            sharp: { loaded: true },
            '@napi-rs/canvas': { loaded: true },
            chromadb: { loaded: true },
            canvas: { loaded: false, code: 'MODULE_NOT_FOUND' }
        }
    }
    assert.equal(
        classifyRuntime(probe).candidate_remove.every((entry) => entry.state === 'candidate_only'),
        true
    )
    assert.equal(
        summarizeRuntimeProbe(probe).classification.unresolved.some((entry) => entry.item === 'cairo-dev/pango-dev'),
        true
    )
    probe.modules.sqlite3.loaded = false
    assert.equal(
        classifyRuntime(probe).candidate_remove.every((entry) => entry.state === 'blocked_by_native_probe'),
        true
    )
})

test('throwaway compiler-removal probe is offline, exact-scoped and leaves publication disabled', () => {
    const source = readFileSync(SLIM_PROBE_PATH, 'utf8')
    for (const expected of [
        'apk del make g++ build-base',
        '--network none',
        '--cap-drop ALL',
        'no-new-privileges',
        'docker exec --detach --user 1000:1000',
        'production_unchanged: true',
        'image_build: false',
        'image_commit: false'
    ]) {
        assert.equal(source.includes(expected), true, `missing compiler-removal guard: ${expected}`)
    }
    assert.equal(/docker (?:image )?(?:pull|push|build|commit|prune)/.test(source), false)
})

test('compiler toolchain stays in the builder and is excluded from the runtime stage', () => {
    const source = readFileSync(DOCKERFILE_PATH, 'utf8')
    const runtimeMarker = ' AS runtime'
    const runtimeOffset = source.indexOf(runtimeMarker)
    assert.notEqual(runtimeOffset, -1, 'runtime stage marker missing')

    const builder = source.slice(0, runtimeOffset)
    const runtime = source.slice(runtimeOffset)
    for (const packageName of ['make', 'g++', 'build-base']) {
        const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pinnedBuilderPattern = new RegExp(`^\\s*${escapedPackageName}=[A-Za-z0-9+_.~-]+\\s*\\\\?$`, 'm')
        const runtimePattern = new RegExp(`^\\s*${escapedPackageName}(?:=[A-Za-z0-9+_.~-]+)?\\s*\\\\?$`, 'm')
        assert.match(builder, pinnedBuilderPattern, `builder must retain an exact ${packageName} version`)
        assert.doesNotMatch(runtime, runtimePattern, `runtime must exclude ${packageName}`)
    }
})
