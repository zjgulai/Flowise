#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
SOURCE_IMAGE=${FLOWISE_BOOTSTRAP_TEST_SOURCE_IMAGE:-python:3.12.13-alpine}
PREFIX="flowise-bootstrap-it-$(date -u +%Y%m%d%H%M%S)-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")
PROJECT="${PREFIX}-project"
LEGACY_IMAGE="${PREFIX}-legacy:local"
CANDIDATE_IMAGE="${PREFIX}-candidate:local"

cleanup() {
    local status=$?
    set +e
    if [[ -f "$WORK/live/docker-compose.prod.yml" ]]; then
        docker compose --project-name "$PROJECT" --project-directory "$WORK/live" \
            --env-file "$WORK/live/.env.production" -f "$WORK/live/docker-compose.prod.yml" \
            down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
    fi
    docker container rm -f "${PREFIX}-flowise" "${PREFIX}-postgres" "${PREFIX}-nginx" \
        "${PREFIX}-legacy-seed" "${PREFIX}-candidate-seed" >/dev/null 2>&1
    docker volume rm "${PREFIX}-flowise-data" "${PREFIX}-postgres-data" >/dev/null 2>&1
    docker network rm "${PREFIX}-network" >/dev/null 2>&1
    docker image rm -f "$LEGACY_IMAGE" "$CANDIDATE_IMAGE" >/dev/null 2>&1
    if [[ -d "$WORK" && "$WORK" == "${TMPDIR:-/tmp}/flowise-bootstrap-it-"* ]]; then
        find "$WORK" -depth -delete
    fi
    trap - EXIT
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

docker version --format '{{.Server.Version}}' >/dev/null
docker compose version >/dev/null
if ! docker image inspect "$SOURCE_IMAGE" >/dev/null 2>&1; then
    echo "required local image absent; refusing registry pull: $SOURCE_IMAGE" >&2
    exit 1
fi
mkdir -p "$WORK/bundle"

docker container create --name "${PREFIX}-legacy-seed" "$SOURCE_IMAGE" /bin/true >/dev/null
docker container commit \
    --change 'LABEL org.opencontainers.image.revision=c947339b7033c930be37591918f59c7725800bbe' \
    --change "LABEL flowise.bootstrap.fixture=$PREFIX" \
    "${PREFIX}-legacy-seed" "$LEGACY_IMAGE" >/dev/null
docker container rm "${PREFIX}-legacy-seed" >/dev/null

docker container create --name "${PREFIX}-candidate-seed" "$SOURCE_IMAGE" /bin/true >/dev/null
docker container commit \
    --change 'LABEL org.opencontainers.image.revision=0123456789abcdef0123456789abcdef01234567' \
    --change "LABEL flowise.bootstrap.fixture=$PREFIX" \
    "${PREFIX}-candidate-seed" "$CANDIDATE_IMAGE" >/dev/null
docker container rm "${PREFIX}-candidate-seed" >/dev/null
docker image save "$CANDIDATE_IMAGE" | gzip -n >"$WORK/bundle/image.tar.gz"
chmod 600 "$WORK/bundle/image.tar.gz"
docker image rm "$CANDIDATE_IMAGE" >/dev/null
if docker image inspect "$CANDIDATE_IMAGE" >/dev/null 2>&1; then
    echo "candidate image unexpectedly loaded before test" >&2
    exit 1
fi

python3 "$SCRIPT_DIR/test_flowise_legacy_bootstrap_docker.py" \
    --repo "$REPO" --work "$WORK" --prefix "$PREFIX" --source-image "$SOURCE_IMAGE" \
    --legacy-image "$LEGACY_IMAGE" --candidate-image "$CANDIDATE_IMAGE"

cleanup_status=0
set +e
docker compose --project-name "$PROJECT" --project-directory "$WORK/live" \
    --env-file "$WORK/live/.env.production" -f "$WORK/live/docker-compose.prod.yml" \
    down --volumes --remove-orphans --timeout 5 >/dev/null 2>&1
docker image rm -f "$LEGACY_IMAGE" >/dev/null 2>&1
for resource in "${PREFIX}-flowise" "${PREFIX}-postgres" "${PREFIX}-nginx"; do
    docker container inspect "$resource" >/dev/null 2>&1 && cleanup_status=1
done
docker volume inspect "${PREFIX}-flowise-data" >/dev/null 2>&1 && cleanup_status=1
docker volume inspect "${PREFIX}-postgres-data" >/dev/null 2>&1 && cleanup_status=1
docker network inspect "${PREFIX}-network" >/dev/null 2>&1 && cleanup_status=1
docker image inspect "$LEGACY_IMAGE" >/dev/null 2>&1 && cleanup_status=1
set -e
if [[ "$cleanup_status" -ne 0 ]]; then
    echo "isolated Docker residue remains" >&2
    exit 1
fi
echo "ok 8 - trap-compatible cleanup leaves no fixture containers, volumes, network, or image tags"
