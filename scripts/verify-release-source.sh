#!/usr/bin/env bash

set -uo pipefail

status=0
git_error=0

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    exit 2
fi

if [[ ! -f .gitignore ]]; then
    printf '%s\n' '.gitignore'
    status=1
fi

if [[ ! -f .dockerignore ]]; then
    printf '%s\n' '.dockerignore'
    status=1
fi

git_patterns=(
    '/.codegraph/'
    '/.playwright-cli/'
    '/output/'
    '/test_reports/'
    '/.superpowers/'
    '/tmp/'
)

docker_patterns=(
    '.codegraph/'
    '.playwright-cli/'
    'output/'
    'test_reports/'
    '.superpowers/'
    'tmp/'
)

probe_paths=(
    '.codegraph/codegraph.db'
    '.playwright-cli/session.json'
    'output/release-artifact'
    'test_reports/report.xml'
    '.superpowers/sdd/task'
    'tmp/release-source'
)

for index in "${!probe_paths[@]}"; do
    artifact_ok=1

    if ! grep -Fqx -- "${git_patterns[$index]}" .gitignore 2>/dev/null; then
        artifact_ok=0
    fi
    git check-ignore -q -- "${probe_paths[$index]}" 2>/dev/null
    ignore_status=$?
    case "$ignore_status" in
        0)
            ;;
        1)
            artifact_ok=0
            ;;
        *)
            artifact_ok=0
            git_error=1
            ;;
    esac
    if ! grep -Fqx -- "${docker_patterns[$index]}" .dockerignore 2>/dev/null; then
        artifact_ok=0
    fi

    if [[ "$artifact_ok" -ne 1 ]]; then
        printf '%s\n' "${probe_paths[$index]}"
        status=1
    fi
done

if [[ ! -f .env.production.template ]]; then
    printf '%s\n' '.env.production.template'
    status=1
else
    git check-ignore -q -- .env.production.template 2>/dev/null
    template_ignore_status=$?
    case "$template_ignore_status" in
        0)
            printf '%s\n' '.env.production.template'
            status=1
            ;;
        1)
            ;;
        *)
            printf '%s\n' '.env.production.template'
            git_error=1
            ;;
    esac
fi

tracked_paths=''
docker_probe_repo=''
cleanup() {
    if [[ -n "$tracked_paths" ]]; then
        rm -f -- "$tracked_paths" >/dev/null 2>&1 || true
    fi
    if [[ -n "$docker_probe_repo" ]]; then
        rm -rf -- "$docker_probe_repo" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

ssh_patterns=(
    '**/id_rsa*'
    '**/id_dsa*'
    '**/id_ecdsa*'
    '**/id_ed25519*'
)

ssh_probe_paths=(
    'id_rsa-flowise-release-source-probe'
    '.release-source-probe/id_rsa-flowise-release-source-probe'
    'id_dsa-flowise-release-source-probe'
    '.release-source-probe/id_dsa-flowise-release-source-probe'
    'id_ecdsa-flowise-release-source-probe'
    '.release-source-probe/id_ecdsa-flowise-release-source-probe'
    'id_ed25519-flowise-release-source-probe'
    '.release-source-probe/id_ed25519-flowise-release-source-probe'
)

docker_probe_repo=$(mktemp -d "${TMPDIR:-/tmp}/flowise-release-dockerignore.XXXXXX" 2>/dev/null)
if [[ $? -ne 0 || -z "$docker_probe_repo" ]]; then
    exit 2
fi
if ! git -C "$docker_probe_repo" init -q >/dev/null 2>&1; then
    exit 2
fi
docker_ignore_path=$(pwd -P)/.dockerignore

for index in "${!ssh_probe_paths[@]}"; do
    probe_path=${ssh_probe_paths[$index]}
    pattern_index=$((index / 2))
    probe_ok=1

    if ! grep -Fqx -- "${ssh_patterns[$pattern_index]}" .gitignore 2>/dev/null; then
        probe_ok=0
    fi
    git check-ignore -q -- "$probe_path" 2>/dev/null
    ignore_status=$?
    case "$ignore_status" in
        0)
            ;;
        1)
            probe_ok=0
            ;;
        *)
            probe_ok=0
            git_error=1
            ;;
    esac

    if ! grep -Fqx -- "${ssh_patterns[$pattern_index]}" .dockerignore 2>/dev/null; then
        probe_ok=0
    fi
    git -C "$docker_probe_repo" -c core.excludesFile="$docker_ignore_path" check-ignore --no-index -q -- "$probe_path" 2>/dev/null
    docker_ignore_status=$?
    case "$docker_ignore_status" in
        0)
            ;;
        1)
            probe_ok=0
            ;;
        *)
            probe_ok=0
            git_error=1
            ;;
    esac

    if [[ "$probe_ok" -ne 1 ]]; then
        printf '%s\n' "$probe_path"
        status=1
    fi
done

is_private_path() {
    local path=$1
    local basename=${path##*/}
    local lower_path

    lower_path=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
    case "$lower_path" in
        *.pem|*.key|*.keys|*.priv|*.rsa|*.p12|*.pfx|*.key.json|id_rsa*|*/id_rsa*|id_dsa*|*/id_dsa*|id_ecdsa*|*/id_ecdsa*|id_ed25519*|*/id_ed25519*)
            return 0
            ;;
    esac

    case "$basename" in
        .env|.env.*)
            case "$basename" in
                *.example|*.template)
                    ;;
                *)
                    return 0
                    ;;
            esac
            ;;
    esac

    return 1
}

for path in "${ssh_probe_paths[@]}"; do
    if ! is_private_path "$path"; then
        printf '%s\n' "$path"
        status=1
    fi
done

tracked_paths=$(mktemp "${TMPDIR:-/tmp}/flowise-release-source.XXXXXX" 2>/dev/null)
if [[ $? -ne 0 || -z "$tracked_paths" ]]; then
    exit 2
fi

git ls-files -z -- >"$tracked_paths" 2>/dev/null
ls_files_status=$?
if [[ "$ls_files_status" -ne 0 ]]; then
    exit "$ls_files_status"
fi

while IFS= read -r -d '' path; do
    if is_private_path "$path"; then
        printf '%s\n' "$path"
        status=1
    fi
done <"$tracked_paths"

if [[ "$git_error" -ne 0 ]]; then
    exit 2
fi

exit "$status"
