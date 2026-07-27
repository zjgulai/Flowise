#!/usr/bin/env bash
# Verify both local browser loaders inside the exact release image without
# weakening Chromium's sandbox or allowing external network traffic.

set -euo pipefail

IMAGE_TAG=''
PROFILE_PATH=''
SMOKE_NAME=''
CONTAINER_CREATED=false

fail() {
    echo "Chromium sandbox verification failed: $1" >&2
    exit 1
}

usage() {
    echo 'Usage: bash scripts/verify-chromium-sandbox.sh --image-tag TAG --profile PATH --smoke-name NAME' >&2
    exit 2
}

while (($# > 0)); do
    (($# >= 2)) || usage
    case "$1" in
        --image-tag) IMAGE_TAG=$2 ;;
        --profile) PROFILE_PATH=$2 ;;
        --smoke-name) SMOKE_NAME=$2 ;;
        *) usage ;;
    esac
    shift 2
done

[[ "$IMAGE_TAG" =~ ^flowise-chinese:git-[0-9a-f]{40}$ ]] || fail 'image tag must use the exact production release SHA'
[[ "$PROFILE_PATH" == /* && "$PROFILE_PATH" != *$'\n'* && "$PROFILE_PATH" != *$'\r'* ]] || fail 'profile path must be absolute'
[[ "$SMOKE_NAME" =~ ^flowise-ci-chromium-[A-Za-z0-9_.-]+$ ]] || fail 'smoke name must be run-scoped'
[[ -f "$PROFILE_PATH" && ! -L "$PROFILE_PATH" ]] || fail 'seccomp profile must be a regular non-symlink file'
[[ "$(node --version)" == v24.18.0 ]] || fail 'host Node version must be v24.18.0'
docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 || fail 'candidate image is missing'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE_TAG")" == linux/amd64 ]] ||
    fail 'candidate platform must be linux/amd64'
[[ "$(docker image inspect --format '{{.Config.User}}' "$IMAGE_TAG")" == node ]] ||
    fail 'candidate runtime user must be node'

required_allow_syscalls='chroot clone unshare'
export PROFILE_PATH
export REQUIRED_ALLOW_SYSCALLS="$required_allow_syscalls"
node <<'NODE'
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')

const bytes = readFileSync(process.env.PROFILE_PATH)
assert.equal(createHash('sha256').update(bytes).digest('hex'), 'a1a19b1ab248ef5835972e3f867613a9aa838266855a3e7e6f8b3feac2eca8d3')
const profile = JSON.parse(bytes)
assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO')
assert.equal(profile.defaultErrnoRet, 1)

const sandboxRules = profile.syscalls.slice(-5)
const names = [...new Set(sandboxRules.flatMap((rule) => rule.names))].sort()
assert.deepEqual(names, process.env.REQUIRED_ALLOW_SYSCALLS.split(' ').sort())
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
    { names: ['chroot'], action: 'SCMP_ACT_ALLOW' }
])
const clone3Rule = profile.syscalls.find((rule) => rule.names?.length === 1 && rule.names[0] === 'clone3')
assert.deepEqual(clone3Rule, {
    names: ['clone3'],
    action: 'SCMP_ACT_ERRNO',
    errnoRet: 38,
    excludes: { caps: ['CAP_SYS_ADMIN'] }
})
const socketcallRule = profile.syscalls.find((rule) => rule.names?.length === 1 && rule.names[0] === 'socketcall')
assert.equal(socketcallRule?.action, 'SCMP_ACT_ERRNO')
assert.equal(socketcallRule?.errnoRet, 38)
NODE

cleanup() {
    if [[ "$CONTAINER_CREATED" == true ]]; then
        if docker rm -f "$SMOKE_NAME" >/dev/null 2>&1; then
            CONTAINER_CREATED=false
        else
            return 1
        fi
    fi
}
trap 'cleanup || true' EXIT

if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
    fail 'run-scoped Chromium smoke container already exists'
fi

if docker create \
    --name "$SMOKE_NAME" \
    --platform linux/amd64 \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=$PROFILE_PATH" \
    --user 1000:1000 \
    --pids-limit 256 \
    --memory 1g \
    --log-driver none \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777 \
    --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=1777 \
    --env HOME=/tmp/home \
    --env XDG_CONFIG_HOME=/tmp/chromium/config \
    --env XDG_CACHE_HOME=/tmp/chromium/cache \
    --env XDG_RUNTIME_DIR=/tmp/chromium/runtime \
    --env PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    --env PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    --entrypoint tail \
    "$IMAGE_TAG" -f /dev/null >/dev/null; then
    CONTAINER_CREATED=true
else
    if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
        CONTAINER_CREATED=true
    fi
    fail 'Chromium smoke container could not be created'
fi

docker start "$SMOKE_NAME" >/dev/null || fail 'Chromium smoke container could not start'
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$SMOKE_NAME")" == none ]] ||
    fail 'Chromium smoke network mode changed'
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$SMOKE_NAME")" == true ]] ||
    fail 'Chromium smoke root filesystem is writable'
[[ "$(docker inspect --format '{{.Config.User}}' "$SMOKE_NAME")" == 1000:1000 ]] ||
    fail 'Chromium smoke user changed'
[[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$SMOKE_NAME")" == '["ALL"]' ]] ||
    fail 'Chromium smoke capabilities were not fully dropped'

SECURITY_OPTIONS="$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$SMOKE_NAME")"
export SECURITY_OPTIONS
node <<'NODE'
const assert = require('node:assert/strict')
const options = JSON.parse(process.env.SECURITY_OPTIONS)
assert.equal(options.some((option) => option.startsWith('no-new-privileges')), true)
assert.equal(options.some((option) => option.startsWith('seccomp=')), true)
assert.equal(options.some((option) => option === `seccomp=${'un' + 'confined'}`), false)
NODE

docker exec "$SMOKE_NAME" sh -euc '
    test "$(id -u):$(id -g)" = 1000:1000
    test "$(node --version)" = v24.18.0
    test "$(awk '"'"'$1 == "CapInh:" {print $2}'"'"' /proc/self/status)" = 0000000000000000
    test "$(awk '"'"'$1 == "CapPrm:" {print $2}'"'"' /proc/self/status)" = 0000000000000000
    test "$(awk '"'"'$1 == "CapEff:" {print $2}'"'"' /proc/self/status)" = 0000000000000000
    test "$(awk '"'"'$1 == "CapBnd:" {print $2}'"'"' /proc/self/status)" = 0000000000000000
    test "$(awk '"'"'$1 == "CapAmb:" {print $2}'"'"' /proc/self/status)" = 0000000000000000
    test "$(awk '"'"'$1 == "NoNewPrivs:" {print $2}'"'"' /proc/self/status)" = 1
    test "$(awk '"'"'$1 == "Seccomp:" {print $2}'"'"' /proc/self/status)" = 2
    test -x "$PLAYWRIGHT_EXECUTABLE_PATH"
    test -x "$PUPPETEER_EXECUTABLE_PATH"
    mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
    chmod 700 "$XDG_RUNTIME_DIR"
    unshare -U true
    if unshare -Urn true >/dev/null 2>&1; then
        exit 1
    fi
    chromium-browser --version
'

docker exec -i "$SMOKE_NAME" python3 <<'PY'
import ctypes
import errno


class CloneArgs(ctypes.Structure):
    _fields_ = [
        ("flags", ctypes.c_uint64),
        ("pidfd", ctypes.c_uint64),
        ("child_tid", ctypes.c_uint64),
        ("parent_tid", ctypes.c_uint64),
        ("exit_signal", ctypes.c_uint64),
        ("stack", ctypes.c_uint64),
        ("stack_size", ctypes.c_uint64),
        ("tls", ctypes.c_uint64),
        ("set_tid", ctypes.c_uint64),
        ("set_tid_size", ctypes.c_uint64),
        ("cgroup", ctypes.c_uint64),
    ]


libc = ctypes.CDLL(None, use_errno=True)
args = CloneArgs(flags=0x40000000)
result = libc.syscall(435, ctypes.byref(args), ctypes.sizeof(args))
assert result == -1
assert ctypes.get_errno() == errno.ENOSYS
print("clone3_namespace=blocked_enosys")
PY

docker exec -i "$SMOKE_NAME" node <<'NODE'
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const { chromium } = require('playwright')
const puppeteer = require('puppeteer')

const forbidden = new Set([`--no${'-sandbox'}`, `--disable-setuid${'-sandbox'}`])
const url = 'data:text/html,<main id="marker">flowise-browser-library-ok</main>'

function assertSandboxFlagsAbsent() {
    for (const entry of fs.readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(entry)) continue
        try {
            const args = fs
                .readFileSync(`/proc/${entry}/cmdline`)
                .toString('utf8')
                .split('\0')
                .filter(Boolean)
            if (!args.some((arg) => arg.includes('chromium'))) continue
            assert.equal(args.some((arg) => forbidden.has(arg)), false)
        } catch {
            // Browser processes can exit while /proc is being inspected.
        }
    }
}

function verifyRawChromium() {
    const profilePath = '/tmp/chromium/raw-profile'
    fs.mkdirSync(profilePath, { recursive: true })
    const args = [
        '--headless=new',
        '--disable-background-networking',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-domain-reliability',
        '--disable-features=MediaRouter,OptimizationHints',
        '--disable-gpu',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        `--user-data-dir=${profilePath}`,
        '--dump-dom',
        'data:text/html,<main id="marker">flowise-raw-chromium-ok</main>'
    ]
    assert.equal(args.some((arg) => forbidden.has(arg)), false)
    const result = spawnSync(process.env.PLAYWRIGHT_EXECUTABLE_PATH, args, {
        encoding: 'utf8',
        timeout: 45_000
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /flowise-raw-chromium-ok/)
}

async function verifyPlaywright() {
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH
    })
    try {
        assertSandboxFlagsAbsent()
        const page = await browser.newPage()
        await page.goto(url)
        assert.equal(await page.textContent('#marker'), 'flowise-browser-library-ok')
    } finally {
        await browser.close()
    }
}

async function verifyPuppeteer() {
    const browser = await puppeteer.launch({
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH
    })
    try {
        const spawnArgs = browser.process()?.spawnargs ?? []
        assert.equal(spawnArgs.some((arg) => forbidden.has(arg)), false)
        assertSandboxFlagsAbsent()
        const page = await browser.newPage()
        await page.goto(url)
        assert.equal(await page.$eval('#marker', (element) => element.textContent), 'flowise-browser-library-ok')
    } finally {
        await browser.close()
    }
}

async function main() {
    verifyRawChromium()
    await verifyPlaywright()
    await verifyPuppeteer()
    console.log('raw_chromium_sandbox=passed')
    console.log('playwright_sandbox=passed')
    console.log('puppeteer_sandbox=passed')
    console.log('forbidden_sandbox_flags=absent')
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
NODE

cleanup || fail 'Chromium smoke container cleanup failed'
if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
    fail 'Chromium smoke container residue remained after cleanup'
fi

trap - EXIT
echo 'Chromium sandbox verification passed.'
