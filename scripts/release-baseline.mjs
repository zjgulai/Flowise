import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXACT_IMAGE_PATTERN = /:git-([0-9a-f]{40})$/
const SIZE_PATTERN = /^([0-9]+(?:\.[0-9]+)?)(B|kB|MB|GB|TB)$/
const OCI_LABELS = Object.freeze({
    source: 'org.opencontainers.image.source',
    revision: 'org.opencontainers.image.revision',
    version: 'org.opencontainers.image.version',
    created: 'org.opencontainers.image.created'
})

const TOOL_NAMES = Object.freeze(['python3', 'git', 'make', 'g++', 'gcc', 'chromium-browser', 'curl'])
const APK_NAMES = Object.freeze([
    'libc6-compat',
    'python3',
    'make',
    'g++',
    'build-base',
    'cairo-dev',
    'pango-dev',
    'chromium',
    'curl',
    'font-noto-cjk',
    'fontconfig',
    'git'
])
const MODULE_NAMES = Object.freeze(['sqlite3', 'sharp', 'canvas', '@napi-rs/canvas', 'chromadb'])

const fail = (message) => {
    throw new Error(message)
}

export const parseHumanBytes = (value) => {
    if (typeof value !== 'string') return null
    const match = value.match(SIZE_PATTERN)
    if (!match) return null
    const multiplier = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[2]]
    return Math.round(Number(match[1]) * multiplier)
}

export const parseApkInstalledSize = (value) => {
    if (typeof value !== 'string') return null
    const match = value.match(/installed size:\s*\n([0-9]+(?:\.[0-9]+)?) (B|KiB|MiB|GiB)\s*$/)
    if (!match) return null
    const multiplier = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]]
    return Math.round(Number(match[1]) * multiplier)
}

export const parseArgs = (argv) => {
    const result = { image: '', output: '', uiDist: 'packages/ui/build', top: 10, measureArchive: false }
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index]
        if (value === '--measure-archive') {
            result.measureArchive = true
            continue
        }
        if (!['--image', '--output', '--ui-dist', '--top'].includes(value)) fail(`Unknown argument: ${value}`)
        const next = argv[index + 1]
        if (!next) fail(`Missing value for ${value}`)
        index += 1
        if (value === '--image') result.image = next
        if (value === '--output') result.output = next
        if (value === '--ui-dist') result.uiDist = next
        if (value === '--top') result.top = Number(next)
    }

    const match = result.image.match(EXACT_IMAGE_PATTERN)
    if (!match || result.image.includes('@') || /\s/.test(result.image))
        fail('Expected an exact local image tag ending in :git-<40 lowercase hex>')
    if (!result.output) fail('Expected --output PATH')
    if (!Number.isInteger(result.top) || result.top < 1 || result.top > 50) fail('Expected --top between 1 and 50')
    return { ...result, revision: match[1] }
}

const layerCategory = (createdBy = '') => {
    if (/COPY --chown=.*\/usr\/src\/flowise/.test(createdBy)) return 'application_copy'
    if (/apk add --no-cache/.test(createdBy) && /chromium/.test(createdBy)) return 'runtime_packages'
    if (/ADD alpine-minirootfs/.test(createdBy)) return 'base_rootfs'
    if (/node-v\$NODE_VERSION|node-v[0-9]/.test(createdBy)) return 'node_runtime'
    if (/^(?:CMD|ENTRYPOINT|EXPOSE|USER|WORKDIR|ENV|ARG|LABEL)/.test(createdBy)) return 'metadata'
    return 'other'
}

export const summarizeHistory = (rows, top = 10) =>
    rows
        .map((row, index) => ({
            order: index,
            category: layerCategory(row.CreatedBy),
            display_size: row.Size,
            parsed_bytes: parseHumanBytes(row.Size)
        }))
        .filter((row) => row.parsed_bytes !== null)
        .sort((left, right) => right.parsed_bytes - left.parsed_bytes || left.order - right.order)
        .slice(0, top)

export const summarizeImageInspect = (inspect, image, revision, storeDisplaySize = null) => {
    const labels = inspect?.Config?.Labels ?? {}
    if (labels[OCI_LABELS.revision] !== revision) fail('Image OCI revision does not match the exact Git-derived tag')
    if (inspect?.Architecture !== 'amd64' || inspect?.Os !== 'linux') fail('Expected linux/amd64 release image')
    if (inspect?.Config?.User !== 'node') fail('Expected non-root node image user')

    return {
        reference: image,
        store_identity: inspect.Id,
        repo_digests: Array.isArray(inspect.RepoDigests) ? [...inspect.RepoDigests].sort() : [],
        created: inspect.Created,
        platform: `${inspect.Os}/${inspect.Architecture}`,
        inspect_size_bytes: inspect.Size,
        docker_list_display_size: storeDisplaySize,
        docker_list_parsed_bytes: parseHumanBytes(storeDisplaySize),
        user: inspect.Config.User,
        working_dir: inspect.Config.WorkingDir,
        cmd: inspect.Config.Cmd,
        oci: Object.fromEntries(Object.entries(OCI_LABELS).map(([key, label]) => [key, labels[label] ?? null]))
    }
}

const walkFiles = (root, directory = root, files = []) => {
    for (const name of readdirSync(directory).sort()) {
        const absolute = resolve(directory, name)
        const stat = lstatSync(absolute)
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) walkFiles(root, absolute, files)
        if (stat.isFile()) files.push({ path: relative(root, absolute), bytes: stat.size, extension: extname(name).toLowerCase() })
    }
    return files
}

export const scanUiDist = (path, top = 10) => {
    const root = resolve(path)
    if (!existsSync(root)) return { state: 'not_built', path }
    const files = walkFiles(root)
    const bytesByType = (extension) => files.filter((file) => file.extension === extension).reduce((sum, file) => sum + file.bytes, 0)
    return {
        state: 'measured',
        path,
        files: files.length,
        total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        js_bytes: bytesByType('.js'),
        css_bytes: bytesByType('.css'),
        largest: [...files].sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)).slice(0, top)
    }
}

export const classifyRuntime = (probe) => {
    const nativeReady = ['sqlite3', 'sharp', '@napi-rs/canvas', 'chromadb'].every((name) => probe.modules?.[name]?.loaded === true)
    return {
        runtime_required: [
            {
                item: 'chromium',
                evidence: probe.tools?.['chromium-browser'] === true ? 'browser executable present' : 'browser executable missing'
            },
            {
                item: 'curl',
                evidence: probe.tools?.curl === true ? 'Compose healthcheck executable present' : 'Compose healthcheck executable missing'
            },
            { item: 'font-noto-cjk/fontconfig', evidence: 'Chinese rendering contract; package-presence only in this batch' }
        ],
        candidate_remove: ['make', 'g++', 'gcc', 'build-base'].map((item) => ({
            item,
            state: nativeReady ? 'candidate_only' : 'blocked_by_native_probe',
            evidence: nativeReady
                ? 'selected native modules loaded without invoking a compiler'
                : 'one or more selected native modules failed to load'
        })),
        unresolved: [
            { item: 'python3', reason: 'custom tool and document-processing compatibility matrix not executed' },
            { item: 'git', reason: 'repository/document loader compatibility matrix not executed' },
            { item: 'cairo-dev/pango-dev', reason: 'runtime shared-library replacement and Canvas path matrix not established' }
        ]
    }
}

export const summarizeRuntimeProbe = (probe) => {
    if (probe?.uid !== 1000 || probe?.platform !== 'linux' || probe?.arch !== 'x64')
        fail('Runtime probe did not execute as linux/x64 uid 1000')
    return {
        ...probe,
        classification: classifyRuntime(probe)
    }
}

const parseJsonLines = (value) =>
    value
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))

const runtimeProbeProgram = `
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const tools = ${JSON.stringify(TOOL_NAMES)}
const packages = ${JSON.stringify(APK_NAMES)}
const modules = ${JSON.stringify(MODULE_NAMES)}
const result = { node: process.version, platform: process.platform, arch: process.arch, uid: process.getuid?.(), tools: {}, packages: {}, modules: {} }
for (const name of tools) result.tools[name] = cp.spawnSync('sh', ['-lc', 'command -v "' + name + '" >/dev/null 2>&1']).status === 0
const parseApkInstalledSize = ${parseApkInstalledSize.toString()}
for (const name of packages) {
    const installed = cp.spawnSync('apk', ['info', '--installed', name]).status === 0
    const size = installed ? cp.spawnSync('apk', ['info', '--size', name], { encoding: 'utf8' }) : null
    result.packages[name] = { installed, installed_size_bytes: size && size.status === 0 ? parseApkInstalledSize(size.stdout) : null }
}
for (const name of modules) {
    try { require(name); result.modules[name] = { loaded: true } }
    catch (error) { result.modules[name] = { loaded: false, code: error && error.code ? String(error.code) : 'LOAD_ERROR' } }
}
if (result.tools['chromium-browser']) {
    const version = cp.spawnSync('chromium-browser', ['--version'], { encoding: 'utf8' })
    result.chromium_version = version.status === 0 ? version.stdout.trim() : null
}
const uiRoot = '/usr/src/flowise/packages/ui/build'
if (!fs.existsSync(uiRoot)) {
    result.ui_bundle = { state: 'not_built', path: 'packages/ui/build', evidence_scope: 'exact_release_image' }
} else {
    const files = []
    const walk = (directory) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const absolute = path.join(directory, name)
            const stat = fs.lstatSync(absolute)
            if (stat.isSymbolicLink()) continue
            if (stat.isDirectory()) walk(absolute)
            if (stat.isFile()) files.push({ path: path.relative(uiRoot, absolute), bytes: stat.size, extension: path.extname(name).toLowerCase() })
        }
    }
    walk(uiRoot)
    const bytesByType = (extension) => files.filter((file) => file.extension === extension).reduce((sum, file) => sum + file.bytes, 0)
    result.ui_bundle = {
        state: 'measured',
        path: 'packages/ui/build',
        evidence_scope: 'exact_release_image',
        files: files.length,
        total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
        js_bytes: bytesByType('.js'),
        css_bytes: bytesByType('.css'),
        largest: files.sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path)).slice(0, 50)
    }
}
console.log(JSON.stringify(result))
`

const measureArchiveStream = (dockerBin, image) =>
    new Promise((resolvePromise, reject) => {
        const save = spawn(dockerBin, ['image', 'save', image], { stdio: ['ignore', 'pipe', 'pipe'] })
        const gzip = spawn('gzip', ['-1', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] })
        const hash = createHash('sha256')
        let bytes = 0
        let saveError = ''
        let gzipError = ''
        save.stdout.pipe(gzip.stdin)
        save.stderr.on('data', (chunk) => (saveError += chunk))
        gzip.stderr.on('data', (chunk) => (gzipError += chunk))
        gzip.stdout.on('data', (chunk) => {
            bytes += chunk.length
            hash.update(chunk)
        })
        Promise.all([
            new Promise((resolveClose) => save.on('close', resolveClose)),
            new Promise((resolveClose) => gzip.on('close', resolveClose))
        ])
            .then(([saveCode, gzipCode]) => {
                if (saveCode !== 0) return reject(new Error(`docker image save failed: ${saveError.trim()}`))
                if (gzipCode !== 0) return reject(new Error(`gzip archive measurement failed: ${gzipError.trim()}`))
                resolvePromise({ state: 'measured_stream_only', bytes, sha256: hash.digest('hex') })
            })
            .catch(reject)
    })

const run = async () => {
    const args = parseArgs(process.argv.slice(2))
    const dockerBin = process.env.DOCKER_BIN || 'docker'
    const inspect = JSON.parse(execFileSync(dockerBin, ['image', 'inspect', args.image, '--format', '{{json .}}'], { encoding: 'utf8' }))
    const listRows = parseJsonLines(
        execFileSync(dockerBin, ['image', 'ls', '--no-trunc', '--format', '{{json .}}', args.image], { encoding: 'utf8' })
    )
    const exactListRow = listRows.find((row) => `${row.Repository}:${row.Tag}` === args.image)
    if (!exactListRow) fail('Exact image tag was not returned by docker image ls')
    const history = parseJsonLines(
        execFileSync(dockerBin, ['history', '--no-trunc', '--format', '{{json .}}', args.image], { encoding: 'utf8' })
    )
    const platform = `${inspect.Os}/${inspect.Architecture}`
    const probe = JSON.parse(
        execFileSync(
            dockerBin,
            [
                'run',
                '--rm',
                '--platform',
                platform,
                '--network',
                'none',
                '--read-only',
                '--tmpfs',
                '/tmp:rw,noexec,nosuid,size=64m',
                '--user',
                '1000:1000',
                '--cap-drop',
                'ALL',
                '--security-opt',
                'no-new-privileges',
                args.image,
                'node',
                '-e',
                runtimeProbeProgram
            ],
            { encoding: 'utf8', maxBuffer: 1024 * 1024 }
        )
    )

    const report = {
        schema: 'flowise-release-baseline/v1',
        generated_at: new Date().toISOString(),
        boundaries: {
            production_unchanged: true,
            production_write: false,
            registry_pull: false,
            registry_push: false,
            provider_call: false,
            secrets_read: false,
            image_prune: false
        },
        image: summarizeImageInspect(inspect, args.image, args.revision, exactListRow.Size),
        largest_layers: summarizeHistory(history, args.top),
        runtime: summarizeRuntimeProbe(probe),
        ui_bundle: { ...probe.ui_bundle, largest: probe.ui_bundle?.largest?.slice(0, args.top) ?? [] },
        workspace_ui_bundle: {
            evidence_scope: 'existing_local_output_not_bound_to_exact_image',
            ...scanUiDist(args.uiDist, args.top)
        },
        compressed_archive: args.measureArchive
            ? await measureArchiveStream(dockerBin, args.image)
            : { state: 'not_measured', reason: 'rerun with --measure-archive to stream-count gzip bytes without retaining an archive' }
    }
    mkdirSync(dirname(resolve(args.output)), { recursive: true })
    writeFileSync(resolve(args.output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${JSON.stringify({ output: args.output, schema: report.schema, image: report.image.reference })}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
    run().catch((error) => {
        process.stderr.write(`${error.message}\n`)
        process.exitCode = 1
    })
}
