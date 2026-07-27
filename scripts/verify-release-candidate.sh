#!/usr/bin/env bash
# Build output verifier for a clean, offline, non-pushing Flowise release candidate.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHROMIUM_PROFILE="$REPO_ROOT/docker/seccomp/chromium.json"
PRODUCTION_COMPOSE="$REPO_ROOT/docker-compose.prod.yml"
PRODUCTION_WRAPPER="$REPO_ROOT/scripts/flowise-production-release.py"
IMAGE_TAG=''
SOURCE=''
REVISION=''
VERSION=''
CREATED=''
ARCHIVE_PATH=''
MANIFEST_PATH=''
EVIDENCE_PATH=''
SMOKE_NAME=''
SMOKE_CREATED=false

fail() {
    echo "Release candidate verification failed: $1" >&2
    exit 1
}

usage() {
    echo 'Usage: bash scripts/verify-release-candidate.sh --image-tag TAG --source URL --revision SHA --version VERSION --created ISO8601 --archive PATH --manifest PATH --evidence PATH --smoke-name NAME' >&2
    exit 2
}

while (($# > 0)); do
    (($# >= 2)) || usage
    case "$1" in
        --image-tag) IMAGE_TAG=$2 ;;
        --source) SOURCE=$2 ;;
        --revision) REVISION=$2 ;;
        --version) VERSION=$2 ;;
        --created) CREATED=$2 ;;
        --archive) ARCHIVE_PATH=$2 ;;
        --manifest) MANIFEST_PATH=$2 ;;
        --evidence) EVIDENCE_PATH=$2 ;;
        --smoke-name) SMOKE_NAME=$2 ;;
        *) usage ;;
    esac
    shift 2
done

[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || fail 'revision must be an exact lowercase Git SHA'
[[ "$VERSION" == "git-$REVISION" ]] || fail 'version must be derived from the exact Git SHA'
[[ "$IMAGE_TAG" == "flowise-chinese:git-$REVISION" ]] ||
    fail 'image tag must use the production flowise-chinese namespace and exact Git SHA'
[[ "$SOURCE" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || fail 'source must be a plain HTTPS repository URL'
[[ "$CREATED" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || fail 'created must be an ISO-8601 timestamp'
[[ "$SMOKE_NAME" =~ ^flowise-ci-smoke-[A-Za-z0-9_.-]+$ ]] || fail 'smoke name must be run-scoped'
[[ -f "$CHROMIUM_PROFILE" && ! -L "$CHROMIUM_PROFILE" ]] || fail 'reviewed Chromium seccomp profile is missing'
[[ -f "$PRODUCTION_COMPOSE" && ! -L "$PRODUCTION_COMPOSE" ]] || fail 'reviewed production Compose file is missing'
[[ -f "$PRODUCTION_WRAPPER" && ! -L "$PRODUCTION_WRAPPER" ]] || fail 'reviewed production release wrapper is missing'
CHROMIUM_NAME="${SMOKE_NAME/flowise-ci-smoke-/flowise-ci-chromium-}"
[[ "$CHROMIUM_NAME" =~ ^flowise-ci-chromium-[A-Za-z0-9_.-]+$ ]] || fail 'Chromium smoke name is invalid'

BUNDLE_DIR="$(dirname "$ARCHIVE_PATH")"
BUNDLE_MANIFEST_PATH="$BUNDLE_DIR/deployment-bundle.json"
[[ "$ARCHIVE_PATH" == "$BUNDLE_DIR/image.tar.gz" ]] || fail 'archive path must use the fixed deployment bundle layout'
[[ "$MANIFEST_PATH" == "$BUNDLE_DIR/release-manifest.json" ]] || fail 'manifest path must use the fixed deployment bundle layout'
[[ "$EVIDENCE_PATH" == "$BUNDLE_DIR/evidence.txt" ]] || fail 'evidence path must use the fixed deployment bundle layout'

for output_path in "$ARCHIVE_PATH" "$MANIFEST_PATH" "$EVIDENCE_PATH" "$BUNDLE_MANIFEST_PATH"; do
    [[ "$output_path" == /* && "$output_path" != *$'\n'* && "$output_path" != *$'\r'* ]] || fail 'output paths must be absolute and single-line'
    [[ -d "$(dirname "$output_path")" ]] || fail 'output parent directory does not exist'
    [[ ! -e "$output_path" && ! -L "$output_path" ]] || fail 'output path already exists'
done

cleanup() {
    if [[ "$SMOKE_CREATED" == true ]]; then
        if docker rm -f "$SMOKE_NAME" >/dev/null 2>&1; then
            SMOKE_CREATED=false
        else
            return 1
        fi
    fi
}
trap 'cleanup || true' EXIT

docker image inspect "$IMAGE_TAG" >/dev/null 2>&1 || fail 'candidate image is missing'
store_identity="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")"
[[ "$store_identity" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'Docker store identity is invalid'
[[ "$(docker image inspect --format '{{.Os}}' "$IMAGE_TAG")" == linux ]] || fail 'candidate operating system is not linux'
[[ "$(docker image inspect --format '{{.Architecture}}' "$IMAGE_TAG")" == amd64 ]] || fail 'candidate architecture is not amd64'
[[ "$(docker image inspect --format '{{.Config.User}}' "$IMAGE_TAG")" == node ]] || fail 'candidate runtime user is not node'
[[ "$(docker image inspect --format '{{.Config.WorkingDir}}' "$IMAGE_TAG")" == /usr/src/flowise ]] || fail 'candidate working directory is invalid'
[[ "$(docker image inspect --format '{{join .Config.Cmd " "}}' "$IMAGE_TAG")" == 'node packages/server/bin/run start' ]] || fail 'candidate command is invalid'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE_TAG")" == "$SOURCE" ]] || fail 'candidate source label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")" == "$REVISION" ]] || fail 'candidate revision label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE_TAG")" == "$VERSION" ]] || fail 'candidate version label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$IMAGE_TAG")" == "$CREATED" ]] || fail 'candidate created label mismatch'

umask 077
docker save "$IMAGE_TAG" | gzip -n > "$ARCHIVE_PATH"
[[ -s "$ARCHIVE_PATH" ]] || fail 'offline archive is empty'

image_config_digest="$(node scripts/release-manifest.mjs verify-archive \
    --archive "$ARCHIVE_PATH" \
    --image-tag "$IMAGE_TAG" \
    --revision "$REVISION" \
    --source "$SOURCE" \
    --version "$VERSION" \
    --created "$CREATED" \
    --platform linux/amd64)"
[[ "$image_config_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail 'archive config digest is invalid'

node scripts/release-manifest.mjs generate \
    --distribution offline_archive \
    --image-tag "$IMAGE_TAG" \
    --image-config-digest "$image_config_digest" \
    --archive "$ARCHIVE_PATH" \
    --platform linux/amd64 \
    --out "$MANIFEST_PATH"
node scripts/release-manifest.mjs verify \
    --manifest "$MANIFEST_PATH" \
    --image-tag "$IMAGE_TAG" \
    --image-config-digest "$image_config_digest" \
    --archive "$ARCHIVE_PATH" \
    --require-clean

docker image rm "$IMAGE_TAG"
if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
    fail 'candidate tag remained after removal'
fi
gzip -dc "$ARCHIVE_PATH" | docker load
reloaded_identity="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")"
[[ "$reloaded_identity" == "$store_identity" ]] || fail 'Docker store identity changed after archive reload'
[[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$IMAGE_TAG")" == linux/amd64 ]] || fail 'reloaded platform mismatch'
[[ "$(docker image inspect --format '{{.Config.User}}' "$IMAGE_TAG")" == node ]] || fail 'reloaded runtime user mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE_TAG")" == "$SOURCE" ]] || fail 'reloaded source label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")" == "$REVISION" ]] || fail 'reloaded revision label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE_TAG")" == "$VERSION" ]] || fail 'reloaded version label mismatch'
[[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$IMAGE_TAG")" == "$CREATED" ]] || fail 'reloaded created label mismatch'
node scripts/release-manifest.mjs verify \
    --manifest "$MANIFEST_PATH" \
    --image-tag "$IMAGE_TAG" \
    --image-config-digest "$image_config_digest" \
    --archive "$ARCHIVE_PATH" \
    --require-clean

if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
    fail 'run-scoped smoke container name already exists'
fi
if docker run --detach \
    --name "$SMOKE_NAME" \
    --init \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --security-opt "seccomp=$CHROMIUM_PROFILE" \
    --user 1000:1000 \
    --pids-limit 512 \
    --log-driver none \
    --tmpfs /tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777 \
    --tmpfs /dev/shm:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=1777 \
    --tmpfs /usr/src/flowise/.flowise:rw,nosuid,nodev,size=512m,uid=1000,gid=1000,mode=0700 \
    --tmpfs /usr/src/flowise/packages/server/logs:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700 \
    --env DATABASE_PATH=/usr/src/flowise/.flowise \
    --env DATABASE_TYPE=sqlite \
    --env DISABLE_FLOWISE_TELEMETRY=true \
    --env HOME=/usr/src/flowise \
    --env LOG_LEVEL=warn \
    --env LOG_PATH=/usr/src/flowise/.flowise/logs \
    --env OFFLINE=true \
    --env SECRETKEY_PATH=/usr/src/flowise/.flowise \
    "$IMAGE_TAG" >/dev/null; then
    SMOKE_CREATED=true
else
    if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
        SMOKE_CREATED=true
    fi
    fail 'isolated runtime could not start'
fi

ready=false
for _ in $(seq 1 60); do
    if docker exec "$SMOKE_NAME" node -e "fetch('http://127.0.0.1:3000/api/v1/ping').then(async (response) => { if (!response.ok || (await response.text()) !== 'pong') process.exit(1) }).catch(() => process.exit(1))"; then
        ready=true
        break
    fi
    [[ "$(docker inspect --format '{{.State.Running}}' "$SMOKE_NAME")" == true ]] || fail 'isolated runtime exited before becoming healthy'
    sleep 2
done
[[ "$ready" == true ]] || fail 'isolated runtime did not become healthy'
[[ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$SMOKE_NAME")" == none ]] || fail 'isolated runtime network mode changed'
[[ "$(docker inspect --format '{{.HostConfig.Init}}' "$SMOKE_NAME")" == true ]] || fail 'isolated runtime init process changed'
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$SMOKE_NAME")" == true ]] || fail 'isolated runtime root filesystem is writable'
[[ "$(docker inspect --format '{{.Config.User}}' "$SMOKE_NAME")" == 1000:1000 ]] || fail 'isolated runtime user changed'
[[ "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$SMOKE_NAME")" == '["ALL"]' ]] || fail 'isolated runtime capabilities were not fully dropped'
[[ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$SMOKE_NAME")" == 512 ]] || fail 'isolated runtime PID limit changed'
security_options="$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$SMOKE_NAME")"
printf '%s\n' "$security_options" | grep -Eq '"no-new-privileges(:true)?"' || fail 'isolated runtime privilege escalation guard changed'
printf '%s\n' "$security_options" | grep -Fq '"seccomp=' || fail 'isolated runtime seccomp profile is missing'
if printf '%s\n' "$security_options" | grep -Fq 'seccomp=unconfined'; then
    fail 'isolated runtime seccomp is unconfined'
fi
[[ "$(docker exec "$SMOKE_NAME" node --version)" == v24.18.0 ]] || fail 'isolated runtime Node version mismatch'
cleanup || fail 'isolated runtime cleanup failed'
if docker container inspect "$SMOKE_NAME" >/dev/null 2>&1; then
    fail 'isolated runtime residue remained after cleanup'
fi

bash "$REPO_ROOT/scripts/verify-chromium-sandbox.sh" \
    --image-tag "$IMAGE_TAG" \
    --profile "$CHROMIUM_PROFILE" \
    --smoke-name "$CHROMIUM_NAME"

{
    echo "source=$SOURCE"
    echo "revision=$REVISION"
    echo "image_tag=$IMAGE_TAG"
    echo "store_identity=$store_identity"
    echo "image_config_digest=$image_config_digest"
    echo 'platform=linux/amd64'
    echo "archive_bytes=$(wc -c < "$ARCHIVE_PATH" | tr -d ' ')"
    echo "archive_sha256=$(sha256sum "$ARCHIVE_PATH" | awk '{print $1}')"
    echo "manifest_sha256=$(sha256sum "$MANIFEST_PATH" | awk '{print $1}')"
    echo 'isolated_smoke=passed'
    echo "chromium_profile_sha256=$(sha256sum "$CHROMIUM_PROFILE" | awk '{print $1}')"
    echo "production_compose_sha256=$(sha256sum "$PRODUCTION_COMPOSE" | awk '{print $1}')"
    echo "production_wrapper_sha256=$(sha256sum "$PRODUCTION_WRAPPER" | awk '{print $1}')"
    echo 'chromium_sandbox=passed'
    echo 'raw_chromium_sandbox=passed'
    echo 'playwright_sandbox=passed'
    echo 'puppeteer_sandbox=passed'
    echo 'clone3_namespace=blocked_enosys'
    echo 'unsafe_chromium_flags=false'
    echo 'registry_push=false'
} > "$EVIDENCE_PATH"

node "$REPO_ROOT/scripts/deployment-bundle.mjs" generate \
    --bundle-dir "$BUNDLE_DIR" \
    --archive "$ARCHIVE_PATH" \
    --manifest "$MANIFEST_PATH" \
    --evidence "$EVIDENCE_PATH" \
    --compose "$PRODUCTION_COMPOSE" \
    --seccomp "$CHROMIUM_PROFILE" \
    --wrapper "$PRODUCTION_WRAPPER"
node "$REPO_ROOT/scripts/deployment-bundle.mjs" verify \
    --bundle-dir "$BUNDLE_DIR" \
    --expected-revision "$REVISION" \
    --expected-image-tag "$IMAGE_TAG" \
    --expected-image-config-digest "$image_config_digest"

echo 'Release candidate verification passed.'
