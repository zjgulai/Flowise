#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG=''
OUTPUT_PATH=''
CONTAINER_NAME=''

usage() {
    echo 'Usage: bash scripts/verify-runtime-without-compilers.sh --image TAG --output PATH --container NAME' >&2
    exit 2
}

fail() {
    echo "Runtime compiler-removal experiment failed: $1" >&2
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --image)
            [[ $# -ge 2 ]] || usage
            IMAGE_TAG=$2
            shift 2
            ;;
        --output)
            [[ $# -ge 2 ]] || usage
            OUTPUT_PATH=$2
            shift 2
            ;;
        --container)
            [[ $# -ge 2 ]] || usage
            CONTAINER_NAME=$2
            shift 2
            ;;
        *) usage ;;
    esac
done

[[ "$IMAGE_TAG" =~ :git-([0-9a-f]{40})$ ]] || fail 'image must end in :git-<40 lowercase hex>'
REVISION=${BASH_REMATCH[1]}
[[ -n "$OUTPUT_PATH" ]] || fail 'output path is required'
[[ "$CONTAINER_NAME" =~ ^flowise-x0-compiler-[a-z0-9-]+$ ]] || fail 'container name must use the flowise-x0-compiler- prefix'
docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 && fail 'run-owned container name already exists'

IMAGE_REVISION=$(docker image inspect "$IMAGE_TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
[[ "$IMAGE_REVISION" == "$REVISION" ]] || fail 'image OCI revision does not match its tag'
[[ "$(docker image inspect "$IMAGE_TAG" --format '{{.Os}}/{{.Architecture}}')" == 'linux/amd64' ]] || fail 'image is not linux/amd64'

cleanup() {
    if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
        docker container rm --force "$CONTAINER_NAME" >/dev/null
    fi
}
trap cleanup EXIT INT TERM

CONTAINER_SCRIPT='
set -eu
stage=bootstrap
diagnose() {
    code=$?
    printf "experiment_stage=%s exit_code=%s\n" "$stage" "$code" >&2
    exit "$code"
}
trap diagnose EXIT
stage=footprint-before
before_kib=$(du -sk /usr | awk "{print \$1}")
stage=apk-delete
apk del make g++ build-base >/tmp/apk-del.log
stage=package-absence
for package in make g++ build-base; do
    if apk info --installed "$package" >/dev/null 2>&1; then
        exit 41
    fi
done
stage=command-absence
for command in make g++ gcc; do
    if command -v "$command" >/dev/null 2>&1; then
        exit 42
    fi
done
stage=footprint-after
after_kib=$(du -sk /usr | awk "{print \$1}")
printf "%s %s\n" "$before_kib" "$after_kib" >/tmp/compiler-footprint
stage=experiment-ready
trap - EXIT
exec tail -f /dev/null
'

docker create \
    --name "$CONTAINER_NAME" \
    --platform linux/amd64 \
    --network none \
    --user 0:0 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m \
    --tmpfs /usr/src/flowise/.flowise:rw,nosuid,size=128m,uid=1000,gid=1000 \
    --env DATABASE_PATH=/usr/src/flowise/.flowise \
    --env DATABASE_TYPE=sqlite \
    --env DISABLE_FLOWISE_TELEMETRY=true \
    --env HOME=/usr/src/flowise \
    --env LOG_LEVEL=warn \
    --env LOG_PATH=/usr/src/flowise/.flowise/logs \
    --env OFFLINE=true \
    --env SECRETKEY_PATH=/usr/src/flowise/.flowise \
    --entrypoint sh \
    "$IMAGE_TAG" -lc "$CONTAINER_SCRIPT" >/dev/null
docker start "$CONTAINER_NAME" >/dev/null

EXPERIMENT_READY=false
for _ in $(seq 1 30); do
    if docker exec --user 0:0 "$CONTAINER_NAME" test -f /tmp/compiler-footprint; then
        EXPERIMENT_READY=true
        break
    fi
    if [[ "$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}')" != true ]]; then
        docker logs --tail 20 "$CONTAINER_NAME" >&2 || true
        fail "container exited during package removal (exit=$(docker inspect "$CONTAINER_NAME" --format '{{.State.ExitCode}}'))"
    fi
    sleep 1
done
[[ "$EXPERIMENT_READY" == true ]] || fail 'package-removal experiment did not become ready'

docker exec --detach --user 1000:1000 "$CONTAINER_NAME" sh -lc 'node packages/server/bin/run start >/tmp/flowise-app.log 2>&1; printf "%s\n" "$?" >/tmp/flowise-app-exit'

READY=false
for _ in $(seq 1 60); do
    if docker exec --user 1000:1000 "$CONTAINER_NAME" node -e "fetch('http://127.0.0.1:3000/api/v1/ping').then(async (response) => { if (!response.ok || (await response.text()) !== 'pong') process.exit(1) }).catch(() => process.exit(1))"; then
        READY=true
        break
    fi
    if docker exec --user 0:0 "$CONTAINER_NAME" test -f /tmp/flowise-app-exit; then
        docker exec --user 0:0 "$CONTAINER_NAME" tail -n 20 /tmp/flowise-app.log >&2 || true
        fail "application exited before ping became ready (exit=$(docker exec --user 0:0 "$CONTAINER_NAME" cat /tmp/flowise-app-exit))"
    fi
    if [[ "$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}')" != true ]]; then
        docker logs --tail 20 "$CONTAINER_NAME" >&2 || true
        fail "container exited before ping became ready (exit=$(docker inspect "$CONTAINER_NAME" --format '{{.State.ExitCode}}'))"
    fi
    sleep 2
done
[[ "$READY" == true ]] || fail 'isolated ping did not become ready'

APP_PID=$(docker exec --user 0:0 "$CONTAINER_NAME" sh -lc '
for status in /proc/[0-9]*/status; do
    pid=${status#/proc/}
    pid=${pid%/status}
    [[ "$pid" == 1 ]] && continue
    cmdline=$(tr "\000" " " </proc/"$pid"/cmdline 2>/dev/null || true)
    case "$cmdline" in
        *"packages/server/bin/run start"*) printf "%s\n" "$pid"; exit 0 ;;
    esac
done
exit 1
')
PID_UID=$(docker exec --user 0:0 "$CONTAINER_NAME" sh -lc "awk '/^Uid:/ {print \$2}' /proc/$APP_PID/status")
PID_GID=$(docker exec --user 0:0 "$CONTAINER_NAME" sh -lc "awk '/^Gid:/ {print \$2}' /proc/$APP_PID/status")
[[ "$PID_UID" == 1000 && "$PID_GID" == 1000 ]] || fail 'application process did not run as uid/gid 1000'

FOOTPRINT=$(docker exec --user 0:0 "$CONTAINER_NAME" cat /tmp/compiler-footprint)
BEFORE_KIB=${FOOTPRINT%% *}
AFTER_KIB=${FOOTPRINT##* }
[[ "$BEFORE_KIB" =~ ^[0-9]+$ && "$AFTER_KIB" =~ ^[0-9]+$ && "$AFTER_KIB" -lt "$BEFORE_KIB" ]] || fail 'runtime footprint did not decrease'

MODULE_JSON=$(docker exec --user 1000:1000 "$CONTAINER_NAME" node -e '
const names = ["sqlite3", "sharp", "@napi-rs/canvas", "chromadb"]
const modules = {}
for (const name of names) {
    try { require(name); modules[name] = { loaded: true } }
    catch (error) { modules[name] = { loaded: false, code: error && error.code ? String(error.code) : "LOAD_ERROR" } }
}
console.log(JSON.stringify(modules))
if (Object.values(modules).some((entry) => !entry.loaded)) process.exit(1)
')
CHROMIUM_VERSION=$(docker exec --user 1000:1000 "$CONTAINER_NAME" chromium-browser --version)
[[ -n "$CHROMIUM_VERSION" ]] || fail 'Chromium version probe failed'

cleanup
trap - EXIT INT TERM
docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1 && fail 'run-owned container residue remained'

umask 077
mkdir -p "$(dirname "$OUTPUT_PATH")"
IMAGE_TAG="$IMAGE_TAG" REVISION="$REVISION" BEFORE_KIB="$BEFORE_KIB" AFTER_KIB="$AFTER_KIB" MODULE_JSON="$MODULE_JSON" CHROMIUM_VERSION="$CHROMIUM_VERSION" OUTPUT_PATH="$OUTPUT_PATH" node -e '
const fs = require("node:fs")
const report = {
    schema: "flowise-runtime-without-compilers/v1",
    generated_at: new Date().toISOString(),
    boundaries: {
        production_unchanged: true,
        production_write: false,
        registry_pull: false,
        registry_push: false,
        image_build: false,
        image_commit: false,
        secrets_read: false,
        container_residue: false
    },
    image: { reference: process.env.IMAGE_TAG, revision: process.env.REVISION },
    experiment: {
        removed_packages: ["make", "g++", "build-base"],
        absent_commands: ["make", "g++", "gcc"],
        rootfs_scope: "throwaway_container_writable_layer",
        application_process: { uid: 1000, gid: 1000 },
        usr_before_kib: Number(process.env.BEFORE_KIB),
        usr_after_kib: Number(process.env.AFTER_KIB),
        usr_delta_kib: Number(process.env.BEFORE_KIB) - Number(process.env.AFTER_KIB),
        modules: JSON.parse(process.env.MODULE_JSON),
        chromium_version: process.env.CHROMIUM_VERSION,
        ping: "pong"
    },
    conclusion: "compiler_toolchain_candidate_only"
}
fs.writeFileSync(process.env.OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
'

echo "Runtime compiler-removal experiment passed: $OUTPUT_PATH"
