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
ignored_paths=''
docker_probe_repo=''
cleanup() {
    if [[ -n "$tracked_paths" ]]; then
        rm -f -- "$tracked_paths" >/dev/null 2>&1 || true
    fi
    if [[ -n "$docker_probe_repo" ]]; then
        rm -rf -- "$docker_probe_repo" >/dev/null 2>&1 || true
    fi
    if [[ -n "$ignored_paths" ]]; then
        rm -f -- "$ignored_paths" >/dev/null 2>&1 || true
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

# Every repository-ignored local/private path must also be excluded from the
# Docker build context. Otherwise a clean Git manifest can describe one source
# tree while `COPY . .` consumes additional ignored files.
context_git_patterns=(
    '.idea'
    '.vscode'
    '**/package-lock.json'
    '**/yarn.lock'
    '**/logs'
    '.pnpm-store/'
    '**/.ruff_cache/'
    '**/*.baiduyun.uploading.cfg'
    '**/*.baiduyun.uploading.cfg'
    '**/tmp'
    '**/temp'
    '**/coverage'
    '.env*'
    '**/api.json'
    '**/uploads'
    '**/*.tgz'
    '.history/'
    '*.keys'
    '*.priv'
    '*.rsa'
    '*.key.json'
    '*.ssh'
    '*.ssh-key'
    '.key-mrc'
    '*.ca'
    '*.crt'
    '*.csr'
    '*.der'
    '*.kdb'
    '*.org'
    '*.rnd'
    '*.ssleay'
    '*.smime'
    '*.vsix'
    'extensions/'
    'apps/*/'
    '.claude/plans/'
    '.claude/settings.local.json'
    '.claude/agent-memory/*'
)

context_docker_patterns=(
    '.idea'
    '.vscode'
    '**/package-lock.json'
    '**/yarn.lock'
    '**/logs'
    '.pnpm-store/'
    '**/.ruff_cache/'
    '**/*.baiduyun.uploading.cfg'
    '**/*.baiduyun.uploading.cfg'
    '**/tmp'
    '**/temp'
    '**/coverage'
    '**/.env*'
    '**/api.json'
    '**/uploads'
    '**/*.tgz'
    '.history/'
    '**/*.keys'
    '**/*.priv'
    '**/*.rsa'
    '**/*.key.json'
    '**/*.ssh'
    '**/*.ssh-key'
    '**/.key-mrc'
    '**/*.ca'
    '**/*.crt'
    '**/*.csr'
    '**/*.der'
    '**/*.kdb'
    '**/*.org'
    '**/*.rnd'
    '**/*.ssleay'
    '**/*.smime'
    '**/*.vsix'
    'extensions/'
    'apps/*/'
    '.claude/plans/'
    '.claude/settings.local.json'
    '.claude/agent-memory/'
)

context_probe_paths=(
    '.idea/workspace.xml'
    '.vscode/private.json'
    'packages/server/package-lock.json'
    'packages/server/yarn.lock'
    'packages/server/logs/server.txt'
    '.pnpm-store/cache/index'
    '.ruff_cache/CACHEDIR.TAG'
    '.release-source-probe.baiduyun.uploading.cfg'
    'scripts/.release-source-probe.baiduyun.uploading.cfg'
    'packages/server/tmp/local.txt'
    'packages/server/temp/local.txt'
    'packages/server/coverage/lcov.info'
    'packages/server/.env.local'
    'packages/server/api.json'
    'packages/server/uploads/customer.bin'
    'release-source-probe.tgz'
    '.history/local.json'
    'release-source-probe.keys'
    'release-source-probe.priv'
    'release-source-probe.rsa'
    'release-source-probe.key.json'
    'release-source-probe.ssh'
    'release-source-probe.ssh-key'
    '.key-mrc'
    'release-source-probe.ca'
    'release-source-probe.crt'
    'release-source-probe.csr'
    'release-source-probe.der'
    'release-source-probe.kdb'
    'release-source-probe.org'
    'release-source-probe.rnd'
    'release-source-probe.ssleay'
    'release-source-probe.smime'
    'release-source-probe.vsix'
    'extensions/private.txt'
    'apps/private/config.json'
    '.claude/plans/private.md'
    '.claude/settings.local.json'
    '.claude/agent-memory/private.md'
)

if [[ "${#context_git_patterns[@]}" -ne "${#context_docker_patterns[@]}" || "${#context_git_patterns[@]}" -ne "${#context_probe_paths[@]}" ]]; then
    printf '%s\n' 'scripts/verify-release-source.sh'
    exit 2
fi

docker_probe_repo=$(mktemp -d "${TMPDIR:-/tmp}/flowise-release-dockerignore.XXXXXX" 2>/dev/null)
if [[ $? -ne 0 || -z "$docker_probe_repo" ]]; then
    exit 2
fi
if ! git -C "$docker_probe_repo" init -q >/dev/null 2>&1; then
    exit 2
fi
docker_ignore_path=$(pwd -P)/.dockerignore

for index in "${!context_probe_paths[@]}"; do
    probe_path=${context_probe_paths[$index]}
    probe_ok=1

    if ! grep -Fqx -- "${context_git_patterns[$index]}" .gitignore 2>/dev/null; then
        probe_ok=0
    fi
    git check-ignore -q --no-index -- "$probe_path" 2>/dev/null
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

    if ! grep -Fqx -- "${context_docker_patterns[$index]}" .dockerignore 2>/dev/null; then
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

oss_app_probe='apps/oss-app/release-source-probe.ts'
oss_app_ok=1
if ! grep -Fqx -- '!apps/oss-app/' .gitignore 2>/dev/null; then
    oss_app_ok=0
fi
if ! grep -Fqx -- '!apps/oss-app/' .dockerignore 2>/dev/null || ! grep -Fqx -- '!apps/oss-app/**' .dockerignore 2>/dev/null; then
    oss_app_ok=0
fi
git check-ignore -q --no-index -- "$oss_app_probe" 2>/dev/null
git_oss_status=$?
git -C "$docker_probe_repo" -c core.excludesFile="$docker_ignore_path" check-ignore --no-index -q -- "$oss_app_probe" 2>/dev/null
docker_oss_status=$?
if [[ "$git_oss_status" -ne 1 || "$docker_oss_status" -ne 1 ]]; then
    oss_app_ok=0
fi
if [[ "$oss_app_ok" -ne 1 ]]; then
    printf '%s\n' "$oss_app_probe"
    status=1
fi

example_lock_probes=(
    'packages/agentflow/examples/package-lock.json'
    'packages/observe/examples/package-lock.json'
)
for example_lock_probe in "${example_lock_probes[@]}"; do
    example_lock_ok=1
    if ! grep -Fqx -- '!**/examples/package-lock.json' .gitignore 2>/dev/null; then
        example_lock_ok=0
    fi
    if ! grep -Fqx -- '!**/examples/package-lock.json' .dockerignore 2>/dev/null; then
        example_lock_ok=0
    fi
    git check-ignore -q --no-index -- "$example_lock_probe" 2>/dev/null
    git_example_status=$?
    git -C "$docker_probe_repo" -c core.excludesFile="$docker_ignore_path" check-ignore --no-index -q -- "$example_lock_probe" 2>/dev/null
    docker_example_status=$?
    if [[ "$git_example_status" -ne 1 || "$docker_example_status" -ne 1 ]]; then
        example_lock_ok=0
    fi
    if [[ "$example_lock_ok" -ne 1 ]]; then
        printf '%s\n' "$example_lock_probe"
        status=1
    fi
done

# `git check-ignore` is a local pattern-model check, not a substitute for an
# actual Docker context/image inspection. Also inspect paths that exist in this
# checkout, including entries
# hidden by a developer's standard/global Git excludes. This keeps a local
# release from silently sending ignored files to Docker.
ignored_paths=$(mktemp "${TMPDIR:-/tmp}/flowise-release-ignored.XXXXXX" 2>/dev/null)
if [[ $? -ne 0 || -z "$ignored_paths" ]]; then
    exit 2
fi
git ls-files -z --ignored --others --exclude-standard --directory --no-empty-directory >"$ignored_paths" 2>/dev/null
ignored_status=$?
if [[ "$ignored_status" -ne 0 ]]; then
    exit "$ignored_status"
fi
while IFS= read -r -d '' ignored_path; do
    git -C "$docker_probe_repo" -c core.excludesFile="$docker_ignore_path" check-ignore --no-index -q -- "$ignored_path" 2>/dev/null
    docker_ignore_status=$?
    case "$docker_ignore_status" in
        0)
            ;;
        1)
            printf '%s\n' "$ignored_path"
            status=1
            ;;
        *)
            printf '%s\n' "$ignored_path"
            git_error=1
            ;;
    esac
done <"$ignored_paths"

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
    case "$path" in
        .ruff_cache/*|*/.ruff_cache/*|*.baiduyun.uploading.cfg)
            printf '%s\n' "$path"
            status=1
            ;;
    esac
done <"$tracked_paths"

if [[ "$git_error" -ne 0 ]]; then
    exit 2
fi

exit "$status"
