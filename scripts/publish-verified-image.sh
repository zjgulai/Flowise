#!/usr/bin/env bash

# Publish a previously verified, single-platform candidate without overwriting
# an existing immutable or SemVer tag. Registry inspection failures are fatal;
# only an explicit manifest-not-found result is treated as an empty tag.

set -euo pipefail

IMAGE_TAG=''
PUBLISH_IMAGE=''
GIT_SHA=''
RELEASE_TAG=''
MANIFEST_PATH=''
IMMUTABILITY_SETTINGS_PATH=''
REMOTE_RAW=''

fail() {
    printf 'Verified image publication failed: %s\n' "$1" >&2
    exit 1
}

usage() {
    printf '%s\n' 'Usage: publish-verified-image.sh --image-tag TAG --publish-image REPOSITORY --git-sha SHA --release-tag TAG --manifest PATH --immutability-settings PATH' >&2
    exit 2
}

while (($# > 0)); do
    (($# >= 2)) || usage
    case "$1" in
        --image-tag) IMAGE_TAG=$2 ;;
        --publish-image) PUBLISH_IMAGE=$2 ;;
        --git-sha) GIT_SHA=$2 ;;
        --release-tag) RELEASE_TAG=$2 ;;
        --manifest) MANIFEST_PATH=$2 ;;
        --immutability-settings) IMMUTABILITY_SETTINGS_PATH=$2 ;;
        *) usage ;;
    esac
    shift 2
done

[[ "$GIT_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'Git revision is invalid'
[[ "$IMAGE_TAG" == "flowise-ci:git-$GIT_SHA" ]] || fail 'local image tag is not bound to the Git revision'
[[ "$PUBLISH_IMAGE" =~ ^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$ ]] || fail 'publish repository is invalid'
[[ ${#RELEASE_TAG} -le 128 ]] || fail 'release tag is too long'
[[ "$RELEASE_TAG" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || fail 'release tag is invalid'
[[ -f "$MANIFEST_PATH" && ! -L "$MANIFEST_PATH" ]] || fail 'release manifest is unavailable'
[[ -f "$IMMUTABILITY_SETTINGS_PATH" && ! -L "$IMMUTABILITY_SETTINGS_PATH" ]] || fail 'server-side immutability evidence is unavailable'

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node "$script_dir/verify-dockerhub-immutability.mjs" \
    --repository "$PUBLISH_IMAGE" \
    --git-tag "git-$GIT_SHA" \
    --release-tag "$RELEASE_TAG" \
    --settings "$IMMUTABILITY_SETTINGS_PATH" || fail 'server-side immutable tag policy is not proven'

local_config_digest=$(jq -er '.image.config_digest | select(type == "string" and test("^sha256:[0-9a-f]{64}$"))' "$MANIFEST_PATH") ||
    fail 'release manifest config digest is invalid'
[[ "$(jq -er '.source.revision' "$MANIFEST_PATH")" == "$GIT_SHA" ]] || fail 'release manifest revision mismatch'
[[ "$(jq -er '.image.tag' "$MANIFEST_PATH")" == "$IMAGE_TAG" ]] || fail 'release manifest image tag mismatch'

git_ref="$PUBLISH_IMAGE:git-$GIT_SHA"
release_ref="$PUBLISH_IMAGE:$RELEASE_TAG"

inspect_remote() {
    local ref=$1
    local error_file
    error_file=$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/flowise-registry-inspect.XXXXXX") || return 2
    if REMOTE_RAW=$(docker buildx imagetools inspect "$ref" --raw 2>"$error_file"); then
        rm -f -- "$error_file"
        return 0
    fi
    if grep -Eqi 'manifest unknown|manifest[^[:alnum:]]+not found|not found|does not exist' "$error_file"; then
        rm -f -- "$error_file"
        REMOTE_RAW=''
        return 1
    fi
    printf 'Registry inspection failed for %s: ' "$ref" >&2
    tr '\r\n' '  ' < "$error_file" >&2
    printf '\n' >&2
    rm -f -- "$error_file"
    return 2
}

raw_config_digest() {
    jq -er '.config.digest | select(type == "string" and test("^sha256:[0-9a-f]{64}$"))' <<<"$1"
}

raw_manifest_digest() {
    printf '%s' "$1" | sha256sum | awk '{print "sha256:" $1}'
}

git_exists=false
release_exists=false
git_raw=''
release_raw=''

if inspect_remote "$git_ref"; then
    git_exists=true
    git_raw=$REMOTE_RAW
else
    inspect_status=$?
    [[ "$inspect_status" -eq 1 ]] || fail 'immutable tag inspection was inconclusive'
fi

if inspect_remote "$release_ref"; then
    release_exists=true
    release_raw=$REMOTE_RAW
else
    inspect_status=$?
    [[ "$inspect_status" -eq 1 ]] || fail 'release alias inspection was inconclusive'
fi

if [[ "$git_exists" == true ]]; then
    [[ "$(raw_config_digest "$git_raw")" == "$local_config_digest" ]] || fail 'immutable tag already points to a different image config'
fi

if [[ "$release_exists" == true ]]; then
    [[ "$(raw_config_digest "$release_raw")" == "$local_config_digest" ]] || fail 'release alias already points to a different image config'
fi

if [[ "$git_exists" != "$release_exists" ]]; then
    fail 'registry contains a partial release; refusing automatic repair or overwrite'
fi

if [[ "$git_exists" == true ]]; then
    git_manifest_digest=$(raw_manifest_digest "$git_raw")
    release_manifest_digest=$(raw_manifest_digest "$release_raw")
    [[ "$git_manifest_digest" == "$release_manifest_digest" ]] || fail 'existing immutable and release tags have different manifest digests'
    printf 'Image publication is already complete and immutable: %s\n' "$git_manifest_digest"
    exit 0
fi

docker tag "$IMAGE_TAG" "$git_ref"
docker tag "$IMAGE_TAG" "$release_ref"
docker push "$git_ref"

inspect_remote "$git_ref" || fail 'immutable tag was not readable after publication'
git_raw=$REMOTE_RAW
[[ "$(raw_config_digest "$git_raw")" == "$local_config_digest" ]] || fail 'published immutable tag config digest mismatch'

docker push "$release_ref"
inspect_remote "$release_ref" || fail 'release alias was not readable after publication'
release_raw=$REMOTE_RAW
[[ "$(raw_config_digest "$release_raw")" == "$local_config_digest" ]] || fail 'published release alias config digest mismatch'

git_manifest_digest=$(raw_manifest_digest "$git_raw")
release_manifest_digest=$(raw_manifest_digest "$release_raw")
[[ "$git_manifest_digest" == "$release_manifest_digest" ]] || fail 'published tags have different manifest digests'

printf 'Verified immutable image publication completed: %s\n' "$git_manifest_digest"
