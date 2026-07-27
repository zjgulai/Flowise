#!/usr/bin/env bash
# ============================================================
# Flowise production hardening verification.
#
# Static repo checks:
#   bash scripts/verify-security.sh
#
# Static + env preflight without printing secret values:
#   bash scripts/verify-security.sh /path/to/.env.production
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${1:-}"
PASS=0
FAIL=0
WARN=0

pass() { echo "  PASS $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN $1"; WARN=$((WARN + 1)); }

file_contains() {
    local file=$1
    local pattern=$2
    local label=$3
    if grep -Fq -- "$pattern" "$REPO_ROOT/$file"; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_exists() {
    local file=$1
    local label=$2
    if [[ -f "$REPO_ROOT/$file" ]]; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_sha256() {
    local file=$1
    local expected=$2
    local label=$3
    local actual
    if [[ ! -f "$REPO_ROOT/$file" ]]; then
        fail "$label"
        return
    fi
    actual="$(shasum -a 256 "$REPO_ROOT/$file" 2>/dev/null | awk '{print $1}' || true)"
    if [[ -n "$actual" && "$actual" == "$expected" ]]; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_exact_line() {
    local file=$1
    local expected=$2
    local label=$3
    if [[ "$(wc -l < "$REPO_ROOT/$file" | tr -d '[:space:]')" == "1" ]] && grep -Fqx -- "$expected" "$REPO_ROOT/$file"; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_has_exact_line() {
    local file=$1
    local expected=$2
    local label=$3
    if grep -Fqx -- "$expected" "$REPO_ROOT/$file"; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_fixed_count() {
    local file=$1
    local pattern=$2
    local expected_count=$3
    local label=$4
    local actual_count
    actual_count="$(grep -Fc -- "$pattern" "$REPO_ROOT/$file" || true)"
    if [[ "$actual_count" == "$expected_count" ]]; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_not_contains_regex() {
    local file=$1
    local pattern=$2
    local label=$3
    if grep -Eq -- "$pattern" "$REPO_ROOT/$file"; then
        fail "$label"
    else
        pass "$label"
    fi
}

workflow_actions_commit_pinned() {
    local file=$1
    local label=$2
    if awk '
        /^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*/ {
            ref = $0
            sub(/^[[:space:]]*(-[[:space:]]+)?uses:[[:space:]]*/, "", ref)
            sub(/[[:space:]#].*$/, "", ref)
            if (ref ~ /^\.\//) next
            separator = index(ref, "@")
            digest = separator == 0 ? "" : substr(ref, separator + 1)
            if (separator == 0 || length(digest) != 40 || digest !~ /^[0-9a-f]+$/) invalid = 1
            external += 1
        }
        END { exit invalid || external == 0 }
    ' "$REPO_ROOT/$file"; then
        pass "$label"
    else
        fail "$label"
    fi
}

apk_lock_valid() {
    local file=$1
    local label=$2
    local lines
    lines="$(wc -l < "$REPO_ROOT/$file" | tr -d '[:space:]')"
    if [[ "$lines" -gt 100 ]] &&
        LC_ALL=C sort -c -u "$REPO_ROOT/$file" >/dev/null 2>&1 &&
        awk -F= '
            NF != 2 || $1 !~ /^[A-Za-z0-9+_.-]+$/ || $2 !~ /^[A-Za-z0-9+_.~-]+$/ { invalid = 1 }
            END { exit invalid }
        ' "$REPO_ROOT/$file"; then
        pass "$label"
    else
        fail "$label"
    fi
}

file_contains_in_order() {
    local file=$1
    local first=$2
    local second=$3
    local label=$4
    local first_line second_line
    first_line="$(grep -nF -- "$first" "$REPO_ROOT/$file" | head -1 | cut -d: -f1 || true)"
    second_line="$(grep -nF -- "$second" "$REPO_ROOT/$file" | head -1 | cut -d: -f1 || true)"
    if [[ -n "$first_line" && -n "$second_line" && "$first_line" -lt "$second_line" ]]; then
        pass "$label"
    else
        fail "$label"
    fi
}

path_not_contains_regex() {
    local path=$1
    local pattern=$2
    local label=$3
    if grep -REq --include='*.js' --include='*.jsx' -- "$pattern" "$REPO_ROOT/$path"; then
        fail "$label"
    else
        pass "$label"
    fi
}

get_env_value() {
    local key=$1
    { grep -E "^${key}=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d'=' -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

get_env_raw_value() {
    local key=$1
    { grep -E "^${key}=" "$ENV_FILE" 2>/dev/null || true; } | tail -1 | cut -d'=' -f2-
}

env_has_key() {
    local key=$1
    grep -Eq "^${key}=" "$ENV_FILE" 2>/dev/null
}

is_placeholder() {
    local val=$1
    [[ -z "$val" || "$val" == REPLACE_WITH_* || "$val" == your_* || "$val" == *your-domain* || "$val" == *_placeholder || "$val" == changeme ]]
}

check_required() {
    local key=$1
    local val
    val="$(get_env_value "$key")"
    if is_placeholder "$val"; then
        fail "$key is missing or placeholder"
    else
        pass "$key is set"
    fi
}

check_secret_length() {
    local key=$1
    local min_len=$2
    local val
    val="$(get_env_value "$key")"
    if is_placeholder "$val"; then
        fail "$key is missing or placeholder"
        return
    fi
    case "$val" in
        AABBCCDDAABBCCDDAABBCCDDAABBCCDDAABBCCDD|flowise|popcorn)
            fail "$key uses a known weak default"
            return
            ;;
    esac
    if [[ ${#val} -ge "$min_len" ]]; then
        pass "$key length >= $min_len"
    else
        fail "$key length < $min_len"
    fi
}

check_bool() {
    local key=$1
    local expected=$2
    local val
    val="$(get_env_value "$key")"
    if [[ "$val" == "$expected" ]]; then
        pass "$key=$expected"
    else
        fail "$key expected $expected"
    fi
}

check_boolean() {
    local key=$1
    local val
    val="$(get_env_value "$key")"
    case "$val" in
        true|false)
            pass "$key is boolean"
            ;;
        *)
            fail "$key must be true or false"
            ;;
    esac
}

check_empty() {
    local key=$1
    local val
    if ! env_has_key "$key"; then
        fail "$key is missing"
        return
    fi
    val="$(get_env_value "$key")"
    if [[ -z "$val" ]]; then
        pass "$key is empty"
    else
        fail "$key must remain empty until separately reviewed and authorized"
    fi
}

check_https_url() {
    local key=$1
    local val
    val="$(get_env_value "$key")"
    if is_placeholder "$val"; then
        fail "$key is missing or placeholder"
    elif [[ "$val" == https://* ]]; then
        pass "$key uses HTTPS"
    else
        fail "$key must use HTTPS"
    fi
}

check_not_wildcard() {
    local key=$1
    local val
    val="$(get_env_value "$key")"
    if is_placeholder "$val"; then
        fail "$key is missing or placeholder"
    elif [[ "$val" == "*" ]]; then
        fail "$key must not be wildcard"
    else
        pass "$key is not wildcard"
    fi
}

check_iframe_origins() {
    local raw val
    raw="$(get_env_raw_value IFRAME_ORIGINS)"
    val="$(get_env_value IFRAME_ORIGINS)"
    if is_placeholder "$val"; then
        fail "IFRAME_ORIGINS is missing or placeholder"
    elif [[ "$val" == "*" ]]; then
        fail "IFRAME_ORIGINS must not be wildcard"
    elif [[ "$raw" == "\"'self'\"" || "$raw" == "\"'none'\"" || "$val" == https://* ]]; then
        pass "IFRAME_ORIGINS uses CSP-safe value"
    elif [[ "$val" == "self" || "$val" == "none" ]]; then
        fail "IFRAME_ORIGINS must preserve CSP quotes; use IFRAME_ORIGINS=\"'$val'\""
    else
        fail "IFRAME_ORIGINS should be 'self', 'none', or explicit https origins"
    fi
}

check_csp_modes() {
    local enforcement report enforcement_rank report_rank
    enforcement="$(get_env_value CSP_ENFORCEMENT_MODE)"
    report="$(get_env_value CSP_REPORT_ONLY_MODE)"

    case "$enforcement" in
        compat) enforcement_rank=0 ;;
        no-eval) enforcement_rank=1 ;;
        strict-script) enforcement_rank=2 ;;
        strict) enforcement_rank=3 ;;
        *) fail "CSP_ENFORCEMENT_MODE is unsupported"; return ;;
    esac

    if [[ "$report" == "off" ]]; then
        pass "CSP modes are valid"
        return
    fi

    case "$report" in
        compat) report_rank=0 ;;
        no-eval) report_rank=1 ;;
        strict-script) report_rank=2 ;;
        strict) report_rank=3 ;;
        *) fail "CSP_REPORT_ONLY_MODE is unsupported"; return ;;
    esac

    if [[ "$report_rank" -gt "$enforcement_rank" ]]; then
        pass "CSP report-only mode is stricter than enforcement"
    else
        fail "CSP report-only mode must be stricter than enforcement"
    fi
}

check_mcp_allowed_commands() {
    local val normalized
    if ! env_has_key "CUSTOM_MCP_ALLOWED_COMMANDS"; then
        fail "CUSTOM_MCP_ALLOWED_COMMANDS is missing"
        return
    fi

    val="$(get_env_value CUSTOM_MCP_ALLOWED_COMMANDS)"
    if [[ -z "$val" ]]; then
        pass "CUSTOM_MCP_ALLOWED_COMMANDS blocks all stdio commands"
        return
    fi

    normalized="$(printf '%s' "$val" | tr -d '[:space:]')"
    if [[ "$normalized" == "*" || "$normalized" == *";"* || "$normalized" == *"|"* || "$normalized" == *"&"* ]]; then
        fail "CUSTOM_MCP_ALLOWED_COMMANDS contains unsafe shell metacharacters"
        return
    fi

    pass "CUSTOM_MCP_ALLOWED_COMMANDS is explicit"
    case ",$normalized," in
        *,npx,*|*,docker,*|*,python,*|*,python3,*)
            warn "CUSTOM_MCP_ALLOWED_COMMANDS includes broad command entries; verify every MCP server before production"
            ;;
    esac
}

check_flowise_image() {
    local val tag
    val="$(get_env_value FLOWISE_IMAGE)"
    tag="${val##*:}"
    if is_placeholder "$val" || [[ "$val" == "$tag" || "$val" == *@* || "$tag" == latest ]]; then
        fail "FLOWISE_IMAGE must use an explicit unique Git-derived tag"
    elif [[ "$tag" =~ ^git-[0-9a-f]{40}$ ]]; then
        if [[ "$tag" == "git-0000000000000000000000000000000000000000" ]]; then
            fail "FLOWISE_IMAGE must replace the all-zero template revision"
        else
            pass "FLOWISE_IMAGE uses an immutable clean Git identity"
        fi
    elif [[ "$tag" =~ ^dirty-([0-9a-f]{12})-([0-9a-f]{12})$ ]]; then
        if [[ "${BASH_REMATCH[1]}" == "000000000000" || "${BASH_REMATCH[2]}" == "000000000000" ]]; then
            fail "FLOWISE_IMAGE must replace the all-zero dirty identity"
        else
            pass "FLOWISE_IMAGE uses an explicit non-stable dirty identity"
        fi
    else
        fail "FLOWISE_IMAGE must use an explicit unique Git-derived tag"
    fi
}

check_postgres_image() {
    local val tag
    val="$(get_env_value POSTGRES_IMAGE)"
    tag="${val##*:}"
    if is_placeholder "$val" || [[ "$tag" == latest || ( "$val" != *@* && ( "$val" == "$tag" || "$tag" == */* ) ) ]]; then
        fail "POSTGRES_IMAGE must use an explicit non-latest reference"
    else
        pass "POSTGRES_IMAGE is explicit and separate from the Flowise release"
    fi
}

check_rendered_compose_contract() {
    local compose_json

    if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
        fail "Rendered Compose contract requires Docker Compose"
        return
    fi
    if ! command -v node >/dev/null 2>&1; then
        fail "Rendered Compose contract requires Node.js"
        return
    fi

    compose_json="$(mktemp "${TMPDIR:-/tmp}/flowise-compose-contract.XXXXXX" 2>/dev/null)"
    if [[ -z "$compose_json" ]]; then
        fail "Rendered Compose contract temp file is available"
        return
    fi
    chmod 600 "$compose_json"

    if ! docker compose --env-file "$REPO_ROOT/.env.production.template" -f "$REPO_ROOT/docker-compose.prod.yml" config --format json >"$compose_json" 2>/dev/null; then
        rm -f -- "$compose_json"
        fail "Rendered Compose contract is valid"
        return
    fi

    if node - "$compose_json" <<'NODE'
const fs = require('fs')

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const flowise = config.services?.flowise
const environment = flowise?.environment
const exactEnvironment = {
    HOME: '/usr/src/flowise',
    DATABASE_PATH: '/usr/src/flowise/.flowise',
    SECRETKEY_PATH: '/usr/src/flowise/.flowise',
    PLAYWRIGHT_EXECUTABLE_PATH: '/usr/bin/chromium-browser',
    PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium-browser',
    XDG_CACHE_HOME: '/tmp/chromium/cache',
    XDG_CONFIG_HOME: '/tmp/chromium/config',
    XDG_RUNTIME_DIR: '/tmp/chromium/runtime',
    DATABASE_REJECT_UNAUTHORIZED: 'true',
    CORS_ALLOW_CREDENTIALS: 'false',
    CUSTOM_MCP_ALLOWED_COMMANDS: '',
    TOOL_FUNCTION_BUILTIN_DEP: '',
    TOOL_FUNCTION_EXTERNAL_DEP: '',
    ALLOW_BUILTIN_DEP: 'false'
}

if (!flowise || !environment) process.exit(1)
for (const [key, value] of Object.entries(exactEnvironment)) {
    if (environment[key] !== value) process.exit(1)
}
if (typeof environment.FLOWISE_SECRETKEY_OVERWRITE !== 'string' || environment.FLOWISE_SECRETKEY_OVERWRITE.length === 0) process.exit(1)
if (typeof environment.LOG_SANITIZE_BODY_FIELDS !== 'string' || environment.LOG_SANITIZE_BODY_FIELDS.length === 0) process.exit(1)
if (flowise.read_only !== true || flowise.init !== true) process.exit(1)
if (flowise.pids_limit !== 512 || flowise.deploy?.resources?.limits?.pids !== 512) process.exit(1)
if (!Array.isArray(flowise.cap_drop) || !flowise.cap_drop.includes('ALL')) process.exit(1)
if (
    !Array.isArray(flowise.security_opt) ||
    !flowise.security_opt.includes('no-new-privileges:true') ||
    !flowise.security_opt.includes('seccomp=./docker/seccomp/chromium.json')
) {
    process.exit(1)
}
if (
    !Array.isArray(flowise.tmpfs) ||
    !flowise.tmpfs.some((entry) => entry.startsWith('/tmp:')) ||
    !flowise.tmpfs.some((entry) => entry.startsWith('/dev/shm:'))
) {
    process.exit(1)
}

const hasPersistentVolume = Array.isArray(flowise.volumes) && flowise.volumes.some((volume) => {
    return volume?.type === 'volume' && volume?.source === 'flowise_data' && volume?.target === '/usr/src/flowise/.flowise'
})
if (!hasPersistentVolume) process.exit(1)
NODE
    then
        pass "Rendered Compose binds the Flowise runtime and persistent state contract"
    else
        fail "Rendered Compose binds the Flowise runtime and persistent state contract"
    fi

    rm -f -- "$compose_json"
}

echo "Flowise production hardening verification"
echo "repo: $REPO_ROOT"
echo ""

echo "Static repo checks"
file_contains ".dockerignore" ".DS_Store" ".dockerignore excludes .DS_Store"
file_contains ".dockerignore" "._*" ".dockerignore excludes AppleDouble files"
file_contains ".dockerignore" "__MACOSX/" ".dockerignore excludes __MACOSX"
file_contains ".dockerignore" ".env.*" ".dockerignore excludes env files"
file_contains ".dockerignore" "*.pem" ".dockerignore excludes PEM files"
file_contains ".dockerignore" "*.key" ".dockerignore excludes key files"
file_contains ".dockerignore" "**/node_modules" ".dockerignore excludes nested node_modules"
file_exact_line ".nvmrc" "v24.18.0" ".nvmrc pins Node 24.18.0 exactly"
file_contains ".npmrc" "engine-strict = true" ".npmrc enforces package engines"
file_contains "package.json" '"packageManager": "pnpm@10.26.0"' "package.json pins the pnpm package manager"
file_contains "package.json" '"node": "24.18.0"' "package.json pins the Node engine"
file_contains "package.json" '"pnpm": "10.26.0"' "package.json pins the pnpm engine"
file_contains "package.json" '"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"' "Root override pins the reviewed SheetJS CDN tarball"
file_contains "packages/components/package.json" '"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"' "Components pins the reviewed SheetJS CDN tarball"
file_contains "pnpm-lock.yaml" 'resolution: {integrity: sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==, tarball: https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz}' "Lockfile binds SheetJS URL to the reviewed SHA-512 integrity"
file_contains "package.json" '"dompurify": "3.4.12"' "Root override pins DOMPurify"
file_contains "packages/ui/package.json" '"dompurify": "3.4.12"' "UI pins DOMPurify"
file_contains "packages/agentflow/package.json" '"dompurify": "3.4.12"' "Agentflow pins DOMPurify"
file_contains "packages/components/package.json" '"mammoth": "1.11.0"' "Components pins the remediated Mammoth release"
file_contains "package.json" '"release:manifest": "node scripts/release-manifest.mjs"' "package.json exposes the release manifest CLI"
file_contains "package.json" '"test:release": "node --test scripts/release-manifest.test.mjs scripts/release-baseline.test.mjs scripts/publish-verified-image.test.mjs scripts/deployment-bundle.test.mjs && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/test_flowise_production_release.py scripts/integration/test_flowise_legacy_bootstrap_docker.py"' "package.json exposes release contract tests"
file_fixed_count "Dockerfile" "FROM docker.io/library/node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd" 2 "Dockerfile pins both Node stages to the reviewed registry index digest"
file_not_contains_regex "Dockerfile" '^FROM[[:space:]]+node:' "Dockerfile has no floating Node base"
file_contains "Dockerfile" "COPY package.json pnpm-workspace.yaml .npmrc ./" "Dockerfile applies the pnpm workspace config before install"
file_contains "Dockerfile" "RUN pnpm install --frozen-lockfile" "Dockerfile uses frozen lockfile install"
file_not_contains_regex "Dockerfile" "pnpm install --frozen-lockfile[[:space:]]*\\|\\|" "Dockerfile has no pnpm install fallback"
file_not_contains_regex "Dockerfile" '(^|[[:space:]])apk update([[:space:]]|$)' "Dockerfile does not resolve from a refreshed mutable APK index"
apk_lock_valid "docker/apk-build.lock" "Build-stage APK lock is complete, exact, sorted and unique"
apk_lock_valid "docker/apk-runtime.lock" "Runtime APK lock is complete, exact, sorted and unique"
file_contains "Dockerfile" "COPY docker/apk-build.lock /tmp/apk-build.lock" "Dockerfile consumes the build-stage APK closure lock"
file_contains "Dockerfile" "COPY docker/apk-runtime.lock /tmp/apk-runtime.lock" "Dockerfile consumes the runtime APK closure lock"
file_contains "Dockerfile" "cmp -s /tmp/apk-build.lock /tmp/apk-actual.lock" "Build-stage transitive APK drift fails closed"
file_contains "Dockerfile" "cmp -s /tmp/apk-runtime.lock /tmp/apk-actual.lock" "Runtime transitive APK drift fails closed"
file_contains "Dockerfile" "ARG SOURCE_DATE_EPOCH=0" "Dockerfile gives non-release consumers a valid deterministic epoch fallback"
file_fixed_count "Dockerfile" "ARG SOURCE_DATE_EPOCH" 3 "Dockerfile defines the epoch fallback and supplies it to both independent stages"
file_fixed_count "Dockerfile" "SOURCE_DATE_EPOCH must be a non-negative integer" 2 "Dockerfile rejects an absent or invalid reproducible epoch in both independent stages"
file_fixed_count "Dockerfile" 'SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" fc-cache -fv' 2 "Dockerfile makes both font cache builds consume the reproducible epoch"
file_contains "Dockerfile" "node_modules/.cache/turbo" "Dockerfile removes the root Turbo cache before the runtime copy"
file_contains "Dockerfile" "packages/api-documentation/.turbo" "Dockerfile removes the API documentation Turbo log before the runtime copy"
file_contains "Dockerfile" "packages/components/.turbo" "Dockerfile removes the components Turbo log before the runtime copy"
file_contains "Dockerfile" "packages/server/.turbo" "Dockerfile removes the server Turbo log before the runtime copy"
file_contains "Dockerfile" "packages/ui/.turbo" "Dockerfile removes the UI Turbo log before the runtime copy"
file_not_contains_regex "Dockerfile" 'node_modules/\.cache/\*|packages/\*/\.turbo' "Dockerfile does not use a broad wildcard to remove Turbo output"
file_contains "Dockerfile" "COPY packages/agentflow/package.json ./packages/agentflow/" "Dockerfile installs the agentflow workspace"
file_contains "Dockerfile" "COPY packages/observe/package.json ./packages/observe/" "Dockerfile installs the observe workspace"
file_contains "Dockerfile" 'CMD [ "node", "packages/server/bin/run", "start" ]' "Runtime starts through the built Node CLI"
file_not_contains_regex "Dockerfile" 'CMD[[:space:]]*\[[[:space:]]*"pnpm"' "Runtime CMD does not require pnpm"
file_contains "Dockerfile" 'ENV PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser' "Runtime binds Playwright to the installed Chromium binary"
file_contains "Dockerfile" 'ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser' "Runtime binds Puppeteer to the installed Chromium binary"
file_contains "packages/server/src/commands/base.ts" 'PLAYWRIGHT_EXECUTABLE_PATH: Flags.string()' "Server CLI accepts the canonical Playwright executable path"
file_contains "packages/server/src/commands/base.ts" 'PUPPETEER_EXECUTABLE_PATH: Flags.string()' "Server CLI accepts the canonical Puppeteer executable path"
file_contains "packages/components/nodes/documentloaders/Playwright/Playwright.ts" 'process.env.PLAYWRIGHT_EXECUTABLE_PATH || process.env.PLAYWRIGHT_EXECUTABLE_FILE_PATH' "Playwright loader preserves the legacy executable path alias"
file_contains "packages/components/nodes/documentloaders/Puppeteer/Puppeteer.ts" 'process.env.PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_FILE_PATH' "Puppeteer loader preserves the legacy executable path alias"
file_contains "packages/server/.env.example" 'PLAYWRIGHT_EXECUTABLE_PATH=' "Server env example documents the canonical Playwright path"
file_contains "packages/server/.env.example" 'PUPPETEER_EXECUTABLE_PATH=' "Server env example documents the canonical Puppeteer path"
file_contains "Dockerfile" 'RUN mkdir -p /usr/src/flowise/.flowise && chown node:node /usr/src/flowise/.flowise' "Runtime prepares the persistent Flowise mountpoint for the node user"
file_contains "Dockerfile" "ARG BUILD_SOURCE" "Runtime requires an OCI source build argument"
file_contains "Dockerfile" "ARG BUILD_REVISION" "Runtime requires an OCI revision build argument"
file_contains "Dockerfile" "ARG BUILD_VERSION" "Runtime requires an OCI version build argument"
file_contains "Dockerfile" "ARG BUILD_CREATED" "Runtime requires an OCI creation-time build argument"
file_contains "Dockerfile" 'org.opencontainers.image.source="${BUILD_SOURCE}"' "Runtime emits the OCI source label"
file_contains "Dockerfile" 'org.opencontainers.image.revision="${BUILD_REVISION}"' "Runtime emits the OCI revision label"
file_contains "Dockerfile" 'org.opencontainers.image.version="${BUILD_VERSION}"' "Runtime emits the OCI version label"
file_contains "Dockerfile" 'org.opencontainers.image.created="${BUILD_CREATED}"' "Runtime emits the OCI creation-time label"
file_not_contains_regex "docker-compose.prod.yml" '^[[:space:]]+build:' "Compose has no source-build fallback"
file_contains "docker-compose.prod.yml" 'image: ${FLOWISE_IMAGE:?FLOWISE_IMAGE must be a unique Git-derived image tag}' "Compose requires an explicit Flowise image"
file_contains "docker-compose.prod.yml" 'image: ${POSTGRES_IMAGE:?POSTGRES_IMAGE must be explicit}' "Compose requires an explicit PostgreSQL image"
file_not_contains_regex "docker-compose.prod.yml" '^[[:space:]]+image:[[:space:]].*latest' "Compose contains no latest image"
file_contains "docker-compose.prod.yml" '${FLOWISE_BIND_IP:-127.0.0.1}:3000:3000' "Compose defaults the Flowise port to localhost"
file_not_contains_regex "docker-compose.prod.yml" "['\"]?0\.0\.0\.0:3000:3000" "Compose does not publish Flowise on all host interfaces"
file_contains "docker-compose.prod.yml" 'name: ${FLOWISE_PROXY_NETWORK:-lighthouse_ai_video_net}' "Compose preserves the external reverse-proxy network"
file_contains "docker-compose.prod.yml" 'read_only: true' "Compose makes the Flowise root filesystem read-only"
file_contains "docker-compose.prod.yml" 'init: true' "Compose installs a PID 1 reaper for browser child processes"
file_contains "docker-compose.prod.yml" 'pids_limit: 512' "Compose caps Flowise process creation"
file_contains "docker-compose.prod.yml" 'pids: 512' "Compose deploy limits match the Flowise PID cap"
file_contains "docker-compose.prod.yml" 'cap_drop:' "Compose declares an explicit capability drop"
file_contains "docker-compose.prod.yml" '- ALL' "Compose drops every ambient Flowise capability"
file_contains "docker-compose.prod.yml" 'no-new-privileges:true' "Compose forbids Flowise privilege escalation"
file_contains "docker-compose.prod.yml" 'seccomp=./docker/seccomp/chromium.json' "Compose applies the reviewed Chromium seccomp profile"
file_not_contains_regex "docker-compose.prod.yml" 'privileged:[[:space:]]*true|SYS_ADMIN|seccomp=unconfined' "Compose has no privileged Chromium bypass"
file_not_contains_regex "docker-compose.prod.yml" '--no-sandbox|--disable-setuid-sandbox' "Compose has no Chromium sandbox-disable flag"
file_contains "docker-compose.prod.yml" 'PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium-browser' "Compose binds Playwright to the installed Chromium binary"
file_contains "docker-compose.prod.yml" 'XDG_CONFIG_HOME=/tmp/chromium/config' "Compose gives Chromium a writable temporary config root"
file_contains "docker-compose.prod.yml" 'XDG_CACHE_HOME=/tmp/chromium/cache' "Compose gives Chromium a writable temporary cache root"
file_contains "docker-compose.prod.yml" 'XDG_RUNTIME_DIR=/tmp/chromium/runtime' "Compose gives Chromium a writable temporary runtime root"
file_exists "docker/seccomp/chromium.json" "Reviewed Chromium seccomp profile exists"
file_sha256 "docker/seccomp/chromium.json" "a1a19b1ab248ef5835972e3f867613a9aa838266855a3e7e6f8b3feac2eca8d3" "Chromium seccomp profile matches the reviewed upstream-derived bytes"
file_exists "scripts/verify-chromium-sandbox.sh" "Chromium sandbox runtime gate exists"
file_contains "docker-compose.prod.yml" "IFRAME_ORIGINS=\${IFRAME_ORIGINS:-'self'}" "Compose defaults IFRAME_ORIGINS to CSP self"
file_contains "docker-compose.prod.yml" 'CSP_ENFORCEMENT_MODE=${CSP_ENFORCEMENT_MODE:-compat}' "Compose defaults CSP enforcement to compat"
file_contains "docker-compose.prod.yml" 'CSP_REPORT_ONLY_MODE=${CSP_REPORT_ONLY_MODE:-off}' "Compose defaults CSP report-only to off"
file_contains "docker-compose.prod.yml" 'DEEPSEEK_BASE_URL_ALLOWLIST=${DEEPSEEK_BASE_URL_ALLOWLIST:-}' "Compose forwards the DeepSeek endpoint allowlist"
file_contains "docker-compose.prod.yml" 'KIMI_BASE_URL_ALLOWLIST=${KIMI_BASE_URL_ALLOWLIST:-}' "Compose forwards the Kimi endpoint allowlist"
file_fixed_count "docker-compose.prod.yml" 'HOME=/usr/src/flowise' 1 "Compose binds the runtime home to the persistent Flowise root exactly once"
file_fixed_count "docker-compose.prod.yml" 'DATABASE_PATH=/usr/src/flowise/.flowise' 1 "Compose binds local database state to the persistent Flowise volume exactly once"
file_fixed_count "docker-compose.prod.yml" 'SECRETKEY_PATH=/usr/src/flowise/.flowise' 1 "Compose binds encryption keys to the persistent Flowise volume exactly once"
file_fixed_count "docker-compose.prod.yml" 'FLOWISE_SECRETKEY_OVERWRITE=${FLOWISE_SECRETKEY_OVERWRITE:?FLOWISE_SECRETKEY_OVERWRITE must reuse the current production encryption key}' 1 "Compose requires the migrated production encryption key exactly once"
file_fixed_count "docker-compose.prod.yml" 'DATABASE_REJECT_UNAUTHORIZED=${DATABASE_REJECT_UNAUTHORIZED:-true}' 1 "Compose forwards the database certificate policy exactly once"
file_fixed_count "docker-compose.prod.yml" 'CORS_ALLOW_CREDENTIALS=${CORS_ALLOW_CREDENTIALS:-false}' 1 "Compose defaults credentialed CORS off exactly once"
file_fixed_count "docker-compose.prod.yml" 'CUSTOM_MCP_ALLOWED_COMMANDS=${CUSTOM_MCP_ALLOWED_COMMANDS:-}' 1 "Compose forwards the Custom MCP command allowlist exactly once"
file_not_contains_regex ".env.production.template" '^FLOWISE_LANGUAGE=' "Production template does not advertise an unused language variable"
file_fixed_count "docker-compose.prod.yml" 'LOG_SANITIZE_BODY_FIELDS=${LOG_SANITIZE_BODY_FIELDS}' 1 "Compose forwards the log redaction field list exactly once"
file_fixed_count "docker-compose.prod.yml" 'TOOL_FUNCTION_BUILTIN_DEP=${TOOL_FUNCTION_BUILTIN_DEP:-}' 1 "Compose forwards reviewed extra builtin dependencies exactly once"
file_fixed_count "docker-compose.prod.yml" 'TOOL_FUNCTION_EXTERNAL_DEP=${TOOL_FUNCTION_EXTERNAL_DEP:-}' 1 "Compose forwards reviewed extra external dependencies exactly once"
file_fixed_count "docker-compose.prod.yml" 'ALLOW_BUILTIN_DEP=${ALLOW_BUILTIN_DEP:-false}' 1 "Compose defaults broad builtin dependency access off exactly once"
file_contains ".env.production.template" "DEEPSEEK_BASE_URL_ALLOWLIST=" "Production template defines the DeepSeek endpoint allowlist"
file_contains ".env.production.template" "KIMI_BASE_URL_ALLOWLIST=" "Production template defines the Kimi endpoint allowlist"
file_contains ".env.production.template" "FLOWISE_IMAGE=" "Production template defines the immutable Flowise image key"
file_contains ".env.production.template" "POSTGRES_IMAGE=" "Production template defines the explicit PostgreSQL image key"
file_contains ".env.production.template" "CSP_ENFORCEMENT_MODE=compat" "Production template keeps compatible CSP enforcement"
file_contains ".env.production.template" "CSP_REPORT_ONLY_MODE=off" "Production template requires explicit CSP observation"
file_has_exact_line ".env.production.template" "TOOL_FUNCTION_BUILTIN_DEP=" "Production template does not expand builtin dependencies"
file_has_exact_line ".env.production.template" "TOOL_FUNCTION_EXTERNAL_DEP=" "Production template does not allow external dependencies"
file_not_contains_regex "packages/ui/index.html" "fonts\\.googleapis|fonts\\.gstatic|r\\.wdfl\\.co|rewardful" "UI index has no blocked third-party font/rewardful resources"
file_not_contains_regex "packages/ui/index.html" "<script[[:space:]]*>" "UI index has no executable inline script block"
file_contains "packages/ui/index.html" '<script src="/global.js"></script>' "UI loads the compatibility bootstrap from self"
file_contains "packages/ui/public/global.js" "globalThis.global = globalThis" "UI global bootstrap is a same-origin static asset"
file_not_contains_regex "packages/ui/src/views/auth/register.jsx" "data-rewardful|rewardful" "Register page has no rewardful marker"
file_contains "packages/ui/package.json" '"flowise-embed": "3.1.5"' "UI pins flowise-embed"
file_contains "packages/ui/package.json" '"flowise-embed-react": "3.1.5"' "UI pins flowise-embed-react"
file_contains "packages/ui/package.json" '"zod": "^3.25.76"' "UI declares its direct zod dependency"
file_not_contains_regex "packages/ui/vite.config.js" "\\.\\./\\.\\./node_modules/@(codemirror|uiw|lezer)" "Vite does not depend on root-hoisted editor packages"
file_not_contains_regex "packages/ui/src/views/auth/signIn.jsx" "ssoApi|signInWithSSO|getDefaultProvidersApi" "Admin-only sign-in exposes no SSO path"
file_not_contains_regex "packages/ui/src/views/auth/signIn.jsx" "to=['\"]\/register['\"]" "Admin-only sign-in exposes no registration CTA"
path_not_contains_regex "packages/ui/src/views/auth" "width:[[:space:]]*'480px'" "Auth views avoid fixed 480px form widths"
file_contains "packages/ui/src/layout/AuthLayout/index.jsx" "isFullBleedAuthPage ? 'none' : '512px'" "Auth layout keeps recovery pages constrained and sign-in full-bleed"
file_contains "packages/server/src/enterprise/utils/adminOnlyPolicy.ts" "value !== 'false'" "Admin-only mode fails closed by default"
file_contains "packages/server/src/enterprise/controllers/account.controller.ts" "assertAccountProvisioningAllowed()" "Account creation paths use the admin-only guard"
file_contains "docker-compose.prod.yml" 'ADMIN_ONLY_MODE=${ADMIN_ONLY_MODE:-true}' "Compose defaults to administrator-only mode"
file_contains ".env.production.template" "ADMIN_ONLY_MODE=true" "Production template enables administrator-only mode"
file_contains "scripts/verify-production-edge.sh" 'assert_header_once "$TMP_DIR/signin.headers" "Strict-Transport-Security"' "Production smoke checks HSTS cardinality"
file_contains "scripts/verify-production-edge.sh" 'assert_header_once "$TMP_DIR/signin.headers" "X-Frame-Options"' "Production smoke checks X-Frame-Options cardinality"
file_contains "scripts/verify-production-edge.sh" 'assert_header_once "$TMP_DIR/signin.headers" "X-Content-Type-Options"' "Production smoke checks X-Content-Type-Options cardinality"
file_contains "scripts/verify-production-edge.sh" 'assert_header_once "$TMP_DIR/signin.headers" "Referrer-Policy"' "Production smoke checks Referrer-Policy cardinality"
file_contains "packages/server/src/utils/XSS.ts" "wildcard embedding is not allowed in production" "Production iframe wildcard fails closed"
file_not_contains_regex "packages/server/src/utils/XSS.ts" "Falling back to 'self'" "Iframe validation has no silent production fallback"
file_contains "packages/server/src/utils/cspReport.ts" "const CSP_REPORT_BODY_LIMIT = '16kb'" "CSP report body is capped at 16 KiB"
file_contains "packages/server/src/utils/csp.ts" "CSP_REPORT_ONLY_MODE must be stricter" "CSP report-only policy cannot downgrade enforcement"
file_contains "packages/server/src/utils/csp.ts" "resolveReportingEndpoint(env.APP_URL)" "Reporting API endpoint is derived from canonical APP_URL"
file_contains "packages/server/src/index.ts" "validateCspReportTrustProxy(trustProxy, cspReportOnlyEnabled)" "CSP reporting rejects unrestricted proxy trust"
file_contains "packages/server/src/index.ts" "import './globalAgent'" "Server initializes the controlled global proxy bootstrap first"
file_contains "packages/server/src/index.ts" "if (this.AppDataSource.isInitialized) await this.AppDataSource.destroy()" "Failed initialization closes the database connection"
file_contains_in_order "packages/server/src/index.ts" "Error during Data Source initialization" "throw error" "Failed initialization is rethrown before the server can listen"
file_not_contains_regex "packages/server/src/index.ts" "global-agent/bootstrap" "Server does not use the forceful global-agent bootstrap"
file_contains "packages/server/src/globalAgent.ts" "forceGlobalAgent: false" "Global proxy bootstrap preserves explicit security agents"
file_not_contains_regex "packages/server/src/index.ts" "existingCsp|baseCspDirectives" "Server has no hand-written CSP merge"
file_contains_in_order "packages/server/src/index.ts" "this.app.use(CSP_REPORT_ENDPOINT" "this.app.use(express.json" "CSP report route precedes the global JSON parser"
file_exists "scripts/release-manifest.mjs" "Release manifest generator exists"
file_exists "scripts/release-manifest.test.mjs" "Release manifest tests exist"
file_exists "scripts/release-baseline.mjs" "Local release baseline reporter exists"
file_exists "scripts/release-baseline.test.mjs" "Local release baseline tests exist"
file_exists "scripts/verify-runtime-without-compilers.sh" "Throwaway compiler-removal probe exists"
file_contains "package.json" '"release:baseline": "node scripts/release-baseline.mjs"' "package.json exposes the local release baseline CLI"
file_contains "package.json" '"test:release": "node --test scripts/release-manifest.test.mjs scripts/release-baseline.test.mjs scripts/publish-verified-image.test.mjs scripts/deployment-bundle.test.mjs && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest scripts/test_flowise_production_release.py scripts/integration/test_flowise_legacy_bootstrap_docker.py"' "Release tests include bundle, production wrapper, baseline, publisher, and Compose discovery contracts"
file_contains "scripts/release-baseline.mjs" "'--network'" "Release baseline runtime probe has no external network"
file_contains "scripts/release-baseline.mjs" "'--read-only'" "Release baseline runtime probe uses a read-only root filesystem"
file_contains "scripts/release-baseline.mjs" "'--cap-drop'" "Release baseline runtime probe drops capabilities"
file_contains "scripts/release-baseline.mjs" "'no-new-privileges'" "Release baseline runtime probe forbids privilege escalation"
file_not_contains_regex "scripts/release-baseline.mjs" "docker[[:space:]]+(pull|push|prune|rm)|secrets\\." "Release baseline reporter has no pull, push, prune, remove, or secret reference"
file_contains "scripts/verify-runtime-without-compilers.sh" "apk del make g++ build-base" "Compiler-removal probe deletes only the scoped compiler packages"
file_contains "scripts/verify-runtime-without-compilers.sh" "--network none" "Compiler-removal probe has no external network"
file_contains "scripts/verify-runtime-without-compilers.sh" "--cap-drop ALL" "Compiler-removal probe drops all capabilities"
file_contains "scripts/verify-runtime-without-compilers.sh" "no-new-privileges" "Compiler-removal probe forbids privilege escalation"
file_not_contains_regex "scripts/verify-runtime-without-compilers.sh" "docker[[:space:]]+(pull|push|build|commit|prune)|secrets\\." "Compiler-removal probe cannot publish, build, commit, prune, or read secrets"
file_contains ".github/workflows/main.yml" "node-version: [24.18.0]" "Main CI uses Node 24.18.0"
file_contains ".github/workflows/main.yml" "pnpm install --frozen-lockfile" "Main CI uses a frozen root install"
file_contains ".github/workflows/main.yml" "pnpm test:release" "Main CI runs release contract tests"
file_contains ".github/workflows/main.yml" "bash scripts/verify-release-source.sh" "Main CI runs the release source gate"
file_contains ".github/workflows/main.yml" "bash scripts/verify-security.sh" "Main CI runs the static security gate"
file_contains ".github/workflows/test_docker_build.yml" "node-version: '24.18.0'" "Docker test CI uses Node 24.18.0"
file_contains ".github/workflows/test_docker_build.yml" "pnpm install --frozen-lockfile" "Docker test CI uses a frozen root install"
file_contains ".github/workflows/test_docker_build.yml" "pnpm audit --prod --audit-level high" "Docker test CI fails closed on high or critical production advisories"
file_not_contains_regex ".github/workflows/test_docker_build.yml" "pnpm audit.*\\|\\||pnpm audit.*;[[:space:]]*true" "Docker test CI does not bypass audit failures"
file_contains ".github/workflows/test_docker_build.yml" "file: Dockerfile" "Docker test CI builds the fork root Dockerfile"
file_contains ".github/workflows/test_docker_build.yml" "push: false" "Docker test CI never pushes"
file_contains ".github/workflows/test_docker_build.yml" "BUILD_REVISION=" "Docker test CI injects OCI provenance"
file_contains ".github/workflows/test_docker_build.yml" "concurrency:" "Docker test CI cancels superseded builds"
file_contains ".github/workflows/test_docker_build.yml" 'outputs: type=docker,name=flowise-chinese:${{ steps.metadata.outputs.version }},rewrite-timestamp=true' "Docker test CI reproducibly exports and loads the single-platform image for inspection"
file_fixed_count ".github/workflows/test_docker_build.yml" "rewrite-timestamp=true" 2 "Build-only and readiness images both rewrite layer timestamps"
file_not_contains_regex ".github/workflows/test_docker_build.yml" 'load:[[:space:]]*true|--load' "Build-only and readiness images do not bypass the configured Docker exporter"
file_contains ".github/workflows/test_docker_build.yml" "runs-on: ubuntu-24.04" "Docker test CI pins the native amd64 runner image"
file_contains ".github/workflows/test_docker_build.yml" 'test "$(uname -m)" = x86_64' "Docker test CI refuses architecture emulation"
file_contains ".github/workflows/test_docker_build.yml" "provenance: false" "Docker test CI exports a classic offline-loadable image"
file_contains ".github/workflows/test_docker_build.yml" "git ls-files --error-unmatch" "Docker test CI requires release automation to be tracked"
file_fixed_count ".github/workflows/test_docker_build.yml" "persist-credentials: false" 2 "Docker release jobs do not retain checkout credentials"
file_fixed_count ".github/workflows/test_docker_build.yml" "version: v0.34.1" 2 "Build-only and readiness jobs pin Docker Buildx"
file_fixed_count ".github/workflows/test_docker_build.yml" "image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f" 2 "Build-only and readiness jobs pin the BuildKit image by digest"
file_exists "scripts/verify-release-candidate.sh" "Reusable release candidate verifier exists"
file_contains ".github/workflows/test_docker_build.yml" "bash scripts/verify-release-candidate.sh" "Docker test CI uses the reusable release candidate verifier"
file_contains "scripts/verify-release-candidate.sh" "node scripts/release-manifest.mjs generate" "Release candidate verifier creates the canonical manifest"
file_fixed_count "scripts/verify-release-candidate.sh" 'node scripts/release-manifest.mjs verify \' 2 "Release candidate verifier checks the manifest before and after reload"
file_contains "scripts/verify-release-candidate.sh" "node scripts/release-manifest.mjs verify-archive" "Release candidate verifier derives and validates archive identity independently"
file_not_contains_regex "scripts/verify-release-candidate.sh" "config_digest=.*docker image inspect.*\\.Id" "Docker store identity is never mislabeled as the archive config digest"
file_contains "scripts/verify-release-candidate.sh" "docker image rm" "Release candidate verifier removes the original image tag before reload"
file_contains "scripts/verify-release-candidate.sh" "gzip -dc" "Release candidate verifier reloads only from the offline archive"
file_contains "scripts/verify-release-candidate.sh" "--network none" "Release candidate smoke has no external network"
file_contains "scripts/verify-release-candidate.sh" "--init" "Release candidate smoke uses the production PID 1 reaper"
file_contains "scripts/verify-release-candidate.sh" "--read-only" "Release candidate smoke uses a read-only root filesystem"
file_contains "scripts/verify-release-candidate.sh" "--cap-drop ALL" "Release candidate smoke drops all capabilities"
file_contains "scripts/verify-release-candidate.sh" "no-new-privileges" "Release candidate smoke forbids privilege escalation"
file_contains "scripts/verify-release-candidate.sh" "--pids-limit 512" "Release candidate smoke matches the production PID cap"
file_contains "scripts/verify-release-candidate.sh" "scripts/verify-chromium-sandbox.sh" "Release candidate invokes the Chromium sandbox gate"
file_contains "scripts/verify-chromium-sandbox.sh" "required_allow_syscalls='chroot clone unshare'" "Chromium gate requires the exact reviewed sandbox allow set"
file_contains "scripts/verify-chromium-sandbox.sh" "chromiumSandbox: true" "Chromium gate exercises Playwright with its sandbox enabled"
file_contains "scripts/verify-chromium-sandbox.sh" "raw_chromium_sandbox=passed" "Chromium gate exercises the raw browser binary"
file_contains "scripts/verify-chromium-sandbox.sh" "playwright_sandbox=passed" "Chromium gate exercises the Playwright library"
file_contains "scripts/verify-chromium-sandbox.sh" "puppeteer_sandbox=passed" "Chromium gate exercises the Puppeteer library"
file_contains "scripts/verify-chromium-sandbox.sh" "clone3_namespace=blocked_enosys" "Chromium gate proves clone3 namespace requests stay blocked"
file_contains "scripts/verify-chromium-sandbox.sh" "forbidden_sandbox_flags=absent" "Chromium gate proves sandbox-disable flags are absent"
file_not_contains_regex "scripts/verify-chromium-sandbox.sh" '--no-sandbox|--disable-setuid-sandbox|seccomp=unconfined|--cap-add|--privileged' "Chromium gate has no unsafe bypass"
file_contains ".github/workflows/test_docker_build.yml" "actions/upload-artifact@" "Docker test CI uploads the verified offline artifact"
file_contains ".github/workflows/test_docker_build.yml" 'path: ${{ env.BUNDLE_DIR }}' "Docker test CI uploads the complete fixed-layout deployment bundle"
file_contains ".github/workflows/test_docker_build.yml" "node scripts/deployment-bundle.mjs verify" "Release readiness verifies every deployment bundle payload"
file_contains ".github/workflows/test_docker_build.yml" '${{ github.run_id }}' "Offline artifact identity includes the workflow run"
file_contains ".github/workflows/test_docker_build.yml" '${{ github.run_attempt }}' "Offline artifact identity includes the workflow attempt"
file_fixed_count ".github/workflows/test_docker_build.yml" "if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'" 2 "Large artifacts and readiness run only on approved manual main runs"
file_contains ".github/workflows/test_docker_build.yml" "retention-days: 3" "Docker test CI keeps the large artifact only briefly"
file_contains ".github/workflows/test_docker_build.yml" "github.ref == 'refs/heads/main'" "Release readiness is restricted to the main branch"
file_contains ".github/workflows/test_docker_build.yml" "name: release-readiness" "Release readiness uses the protected environment hook"
file_contains ".github/workflows/test_docker_build.yml" "actions/download-artifact@" "Release readiness reconsumes the same-run artifact"
file_contains ".github/workflows/test_docker_build.yml" 'expected_tag="flowise-chinese:git-${GITHUB_SHA}"' "Release readiness derives the production tag from GitHub SHA"
file_contains ".github/workflows/test_docker_build.yml" 'expected_source="${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}"' "Release readiness derives the expected source independently"
file_contains ".github/workflows/test_docker_build.yml" "node scripts/release-manifest.mjs verify-archive" "Release readiness parses the Docker archive independently"
file_contains ".github/workflows/test_docker_build.yml" 'docker image load --input "$ARCHIVE_PATH"' "Release readiness proves the downloaded archive is loadable"
file_contains ".github/workflows/test_docker_build.yml" 'docker image rm "$expected_tag"' "Release readiness removes its local image after verification"
file_not_contains_regex ".github/workflows/test_docker_build.yml" "manifest\\.image\\.(tag|config_digest)" "Release readiness trusts no identity value supplied by the manifest"
file_not_contains_regex ".github/workflows/test_docker_build.yml" "docker/login-action|push:[[:space:]]*true|secrets\\." "Build-only release CI has no registry login, push, or secret reference"
file_not_contains_regex "scripts/verify-release-candidate.sh" "docker/login-action|docker[[:space:]]+push|secrets\\." "Release candidate verifier has no registry login, push, or secret reference"
workflow_actions_commit_pinned ".github/workflows/test_docker_build.yml" "Docker test CI pins every external action to a commit"
file_exists ".github/workflows/production-readonly-monitor.yml" "Public production read-only monitor exists"
file_contains ".github/workflows/production-readonly-monitor.yml" "schedule:" "Public monitor has a scheduled trigger"
file_contains ".github/workflows/production-readonly-monitor.yml" "bash scripts/verify-production-edge.sh https://flowise.lute-tlz-dddd.top" "Public monitor runs the existing edge contract"
file_contains ".github/workflows/production-readonly-monitor.yml" "openssl x509 -checkend" "Public monitor checks the TLS expiry threshold"
file_not_contains_regex ".github/workflows/production-readonly-monitor.yml" "secrets\\.|(^|[^[:alnum:]_])ssh([^[:alnum:]_]|$)|provider|smtp|/prediction" "Public monitor contains no secret, remote shell, provider, mail, or prediction lane"
workflow_actions_commit_pinned ".github/workflows/production-readonly-monitor.yml" "Public monitor pins every external action to a commit"
file_contains ".github/workflows/docker-image-dockerhub.yml" "TAG_VERSION: \${{ inputs.tag_version }}" "Docker Hub input reaches shell only through an environment variable"
file_contains ".github/workflows/docker-image-dockerhub.yml" "if: github.ref == 'refs/heads/main'" "Docker Hub publication is restricted to main"
file_contains ".github/workflows/docker-image-dockerhub.yml" '[[ ${#TAG_VERSION} -le 128 ]]' "Docker Hub release tag respects the registry length limit"
file_contains ".github/workflows/docker-image-dockerhub.yml" '[[ "$TAG_VERSION" =~' "Docker Hub release validates the requested tag"
file_contains ".github/workflows/docker-image-dockerhub.yml" "name: dockerhub-release" "Docker Hub credentials are behind a protected environment"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'PUBLISH_ENABLED: ${{ vars.DOCKERHUB_RELEASE_ENABLED }}' "Docker Hub publication requires explicit control-plane enablement"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'PUBLISH_IMAGE: ${{ vars.DOCKERHUB_IMAGE }}' "Docker Hub target comes from protected repository configuration"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'test "$PUBLISH_ENABLED" = '\''true'\''' "Docker Hub publication fails closed when enablement is absent"
file_contains ".github/workflows/docker-image-dockerhub.yml" '[[ "$PUBLISH_IMAGE" != flowiseai/* ]]' "Fork release cannot target the upstream Flowise namespace"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'test "${PUBLISH_IMAGE%%/*}" = "$registry_username"' "Docker Hub namespace is bound to the protected login identity"
file_contains ".github/workflows/docker-image-dockerhub.yml" "file: Dockerfile" "Docker Hub release builds the canonical root Dockerfile"
file_contains ".github/workflows/docker-image-dockerhub.yml" "platforms: linux/amd64" "Docker Hub release is restricted to the reviewed architecture"
file_contains ".github/workflows/docker-image-dockerhub.yml" "git ls-files --error-unmatch" "Docker Hub release requires its automation to be tracked"
file_fixed_count ".github/workflows/docker-image-dockerhub.yml" "persist-credentials: false" 1 "Docker Hub checkout does not retain credentials"
file_fixed_count ".github/workflows/docker-image-dockerhub.yml" "version: v0.34.1" 1 "Docker Hub release pins Docker Buildx"
file_fixed_count ".github/workflows/docker-image-dockerhub.yml" "image=moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f" 1 "Docker Hub release pins the BuildKit image by digest"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'outputs: type=docker,name=flowise-chinese:git-${{ github.sha }},rewrite-timestamp=true' "Docker Hub release reproducibly exports and loads the candidate for verification"
file_not_contains_regex ".github/workflows/docker-image-dockerhub.yml" 'load:[[:space:]]*true|--load' "Docker Hub release does not bypass the configured Docker exporter"
file_contains ".github/workflows/docker-image-dockerhub.yml" "push: false" "Docker Hub build action cannot push an unverified image"
file_contains ".github/workflows/docker-image-dockerhub.yml" "bash scripts/verify-release-candidate.sh" "Docker Hub release verifies the exact offline candidate"
file_contains_in_order ".github/workflows/docker-image-dockerhub.yml" "bash scripts/verify-release-candidate.sh" "docker/login-action@" "Docker Hub candidate verification precedes registry credentials"
file_contains ".github/workflows/docker-image-dockerhub.yml" "expected_image_config_digest:" "Docker Hub release requires an independently supplied image config digest"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'test "$actual_config_digest" = "$EXPECTED_IMAGE_CONFIG_DIGEST"' "Docker Hub release binds the rebuilt candidate to the independently reviewed config digest"
file_contains_in_order ".github/workflows/docker-image-dockerhub.yml" "bash scripts/verify-release-candidate.sh" 'test "$actual_config_digest" = "$EXPECTED_IMAGE_CONFIG_DIGEST"' "Docker Hub independently supplied identity follows candidate verification"
file_contains_in_order ".github/workflows/docker-image-dockerhub.yml" 'test "$actual_config_digest" = "$EXPECTED_IMAGE_CONFIG_DIGEST"' "docker/login-action@" "Docker Hub candidate identity is proven before registry credentials"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'git tag --format=' "Docker Hub release alias must identify the checked-out revision"
file_contains ".github/workflows/docker-image-dockerhub.yml" "pnpm audit --prod --audit-level high" "Docker Hub release fails closed on high and critical production advisories"
file_contains ".github/workflows/docker-image-dockerhub.yml" "SOURCE_DATE_EPOCH:" "Docker Hub release normalizes build timestamps for independent identity comparison"
file_contains ".github/workflows/test_docker_build.yml" "SOURCE_DATE_EPOCH:" "Build-only release normalizes build timestamps for independent identity comparison"
file_contains ".github/workflows/docker-image-dockerhub.yml" 'SOURCE_DATE_EPOCH=${{ steps.metadata.outputs.source_date_epoch }}' "Docker Hub release passes the exact epoch as a build argument"
file_contains ".github/workflows/test_docker_build.yml" 'SOURCE_DATE_EPOCH=${{ steps.metadata.outputs.source_date_epoch }}' "Primary build passes the exact epoch as a build argument"
file_contains ".github/workflows/test_docker_build.yml" '--build-arg "SOURCE_DATE_EPOCH=$source_date_epoch"' "Readiness rebuild passes the same exact epoch as a build argument"
file_contains ".github/workflows/test_docker_build.yml" "Independently rebuild and bind the candidate config identity" "Release readiness uses a separate-runner rebuild rather than trusting artifact metadata alone"
file_contains ".github/workflows/test_docker_build.yml" 'test "$independent_config_digest" = "$expected_config_digest"' "Release readiness requires independent and primary config identities to match"
file_contains "scripts/verify-release-candidate.sh" "EXPECTED_BUILDX_VERSION='v0.34.1'" "Release evidence verifies the pinned Buildx version"
file_contains "scripts/verify-release-candidate.sh" "EXPECTED_BUILDKIT_VERSION='v0.30.0'" "Release evidence verifies the pinned BuildKit version"
file_contains "scripts/deployment-bundle.mjs" "buildx_version: 'v0.34.1'" "Deployment bundle binds the Buildx evidence"
file_contains "scripts/deployment-bundle.mjs" "buildkit_version: 'v0.30.0'" "Deployment bundle binds the BuildKit evidence"
file_contains_in_order ".github/workflows/test_docker_build.yml" "Download the same-run offline release artifact" "docker buildx build" "Release readiness rebuild follows the same-run artifact download"
file_contains_in_order ".github/workflows/test_docker_build.yml" "docker buildx build" 'test "$independent_config_digest" = "$expected_config_digest"' "Release readiness compares the downloaded candidate with an independently rebuilt image"
file_contains ".github/workflows/docker-image-dockerhub.yml" "bash scripts/publish-verified-image.sh" "Docker Hub publication uses the immutable tag guard"
file_contains ".github/workflows/docker-image-dockerhub.yml" '--archive "$ARCHIVE_PATH"' "Docker Hub publisher reconsumes the verified offline archive before registry inspection"
file_contains ".github/workflows/docker-image-dockerhub.yml" "https://hub.docker.com/v2/auth/token" "Docker Hub policy check uses the documented token API"
file_contains ".github/workflows/docker-image-dockerhub.yml" "jq -er '.access_token'" "Docker Hub policy check parses the documented token field"
file_not_contains_regex ".github/workflows/docker-image-dockerhub.yml" "/v2/users/login/" "Docker Hub policy check does not use the legacy login API"
file_contains ".github/workflows/docker-image-dockerhub.yml" "node scripts/verify-dockerhub-immutability.mjs" "Docker Hub publication proves server-side immutable-tag enforcement"
file_contains "scripts/verify-dockerhub-immutability.mjs" "immutable_tags_settings" "Docker Hub policy verifier consumes repository policy evidence"
file_not_contains_regex "scripts/verify-dockerhub-immutability.mjs" "new RegExp\\(" "Docker Hub policy verifier does not reinterpret RE2 rules with JavaScript regex"
file_contains ".github/workflows/docker-image-dockerhub.yml" '--immutability-settings "$IMMUTABILITY_SETTINGS_PATH"' "Docker Hub publisher receives the verified policy evidence"
file_not_contains_regex ".github/workflows/docker-image-dockerhub.yml" "docker[[:space:]]+push" "Docker Hub workflow delegates registry writes to the tested immutable publisher"
file_not_contains_regex ".github/workflows/docker-image-dockerhub.yml" "default:[[:space:]]*['\"]?latest|docker/Dockerfile|docker/worker/Dockerfile|npm install -g flowise|push:[[:space:]]*true" "Docker Hub release has no floating package, legacy Dockerfile, or direct build push lane"
file_fixed_count ".github/workflows/docker-image-dockerhub.yml" '${{ inputs.tag_version }}' 1 "Docker Hub input is interpolated exactly once into the environment boundary"
file_fixed_count ".github/workflows/docker-image-dockerhub.yml" '${{ inputs.expected_image_config_digest }}' 1 "Docker Hub expected config digest is interpolated exactly once into the environment boundary"
file_not_contains_regex ".github/workflows/docker-image-dockerhub.yml" "pnpm audit.*\\|\\||pnpm audit.*;[[:space:]]*true" "Docker Hub release does not bypass audit failures"
workflow_actions_commit_pinned ".github/workflows/docker-image-dockerhub.yml" "Docker Hub release pins every external action to a commit"
file_fixed_count ".github/workflows/publish-package.yml" "node-version: '24.18.0'" 2 "Package workflows use Node 24.18.0"
file_not_contains_regex ".github/workflows/publish-package.yml" "node-version:[[:space:]]*'20" "Package workflows contain no Node 20 install"
file_fixed_count ".github/workflows/publish-package.yml" "pnpm install --frozen-lockfile" 2 "Package workflows keep frozen root installs"
file_contains ".github/workflows/docker-image-ecr.yml" "node-version: '24.18.0'" "ECR build-only CI uses Node 24.18.0"
file_contains ".github/workflows/docker-image-ecr.yml" "pnpm install --frozen-lockfile" "ECR build-only CI uses a frozen root install"
file_contains ".github/workflows/docker-image-ecr.yml" "file: Dockerfile" "ECR build-only CI uses the fork root Dockerfile"
file_contains ".github/workflows/docker-image-ecr.yml" "push: false" "ECR foundation lane never pushes"
file_contains ".github/workflows/docker-image-ecr.yml" "BUILD_REVISION=" "ECR foundation lane injects OCI provenance"
file_not_contains_regex ".github/workflows/docker-image-ecr.yml" "default:[[:space:]]*['\"]?latest|amazon-ecr-login|configure-aws-credentials|push:[[:space:]]*true" "ECR foundation lane has no latest tag or registry login"
check_rendered_compose_contract

if [[ -n "$ENV_FILE" ]]; then
    echo ""
    echo "Env preflight checks"
    if [[ ! -f "$ENV_FILE" ]]; then
        fail "env file exists"
    else
        pass "env file exists"
        check_flowise_image
        check_postgres_image
        check_bool "NODE_ENV" "production"
        check_bool "SECURE_COOKIES" "true"
        check_bool "TRUST_PROXY" "1"
        check_https_url "APP_URL"
        check_required "POSTGRES_PASSWORD"
        check_secret_length "JWT_AUTH_TOKEN_SECRET" 32
        check_secret_length "JWT_REFRESH_TOKEN_SECRET" 32
        check_secret_length "EXPRESS_SESSION_SECRET" 32
        check_secret_length "TOKEN_HASH_SECRET" 32
        check_secret_length "FLOWISE_SECRETKEY_OVERWRITE" 32
        check_not_wildcard "CORS_ORIGINS"
        check_iframe_origins
        check_csp_modes
        check_bool "HTTP_SECURITY_CHECK" "true"
        check_bool "PATH_TRAVERSAL_SAFETY" "true"
        check_bool "CUSTOM_MCP_SECURITY_CHECK" "true"
        check_bool "OAUTH2_SECURITY_CHECK" "true"
        check_bool "DATABASE_REJECT_UNAUTHORIZED" "true"
        check_boolean "CORS_ALLOW_CREDENTIALS"
        if [[ "$(get_env_value CORS_ALLOW_CREDENTIALS)" == "true" ]]; then
            warn "CORS_ALLOW_CREDENTIALS=true requires an exact reviewed CORS_ORIGINS list"
        fi
        check_bool "ALLOW_BUILTIN_DEP" "false"
        check_required "LOG_SANITIZE_BODY_FIELDS"
        check_empty "TOOL_FUNCTION_BUILTIN_DEP"
        check_empty "TOOL_FUNCTION_EXTERNAL_DEP"
        check_mcp_allowed_commands
        if [[ "$(get_env_value LOG_LEVEL)" == "debug" || "$(get_env_value LOG_LEVEL)" == "verbose" ]]; then
            warn "LOG_LEVEL is verbose for production"
        fi
    fi
else
    echo ""
    echo "Env preflight skipped: pass /path/to/.env.production to validate deploy values."
fi

echo ""
echo "Result: $PASS passed, $FAIL failed, $WARN warnings"

if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
