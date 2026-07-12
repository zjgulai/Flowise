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
cleanup() {
    if [[ -n "$tracked_paths" ]]; then
        rm -f -- "$tracked_paths" >/dev/null 2>&1 || true
    fi
}
trap cleanup EXIT

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
    basename=${path##*/}
    lower_path=$(printf '%s' "$path" | tr '[:upper:]' '[:lower:]')
    private_path=0

    case "$lower_path" in
        *.pem|*.key|*.keys|*.priv|*.rsa|*.p12|*.pfx|*.key.json|*/id_rsa|*/id_rsa.*|*/id_ed25519|*/id_ed25519.*)
            private_path=1
            ;;
    esac

    case "$basename" in
        .env|.env.*)
            case "$basename" in
                *.example|*.template)
                    ;;
                *)
                    private_path=1
                    ;;
            esac
            ;;
    esac

    if [[ "$private_path" -eq 1 ]]; then
        printf '%s\n' "$path"
        status=1
    fi
done <"$tracked_paths"

if [[ "$git_error" -ne 0 ]]; then
    exit 2
fi

exit "$status"
