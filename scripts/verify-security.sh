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
file_contains "package.json" '"release:manifest": "node scripts/release-manifest.mjs"' "package.json exposes the release manifest CLI"
file_contains "package.json" '"test:release": "node --test scripts/release-manifest.test.mjs"' "package.json exposes release contract tests"
file_fixed_count "Dockerfile" "FROM docker.io/library/node:24.18.0-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd" 2 "Dockerfile pins both Node stages to the reviewed registry index digest"
file_not_contains_regex "Dockerfile" '^FROM[[:space:]]+node:' "Dockerfile has no floating Node base"
file_contains "Dockerfile" "COPY package.json pnpm-workspace.yaml .npmrc ./" "Dockerfile applies the pnpm workspace config before install"
file_contains "Dockerfile" "RUN pnpm install --frozen-lockfile" "Dockerfile uses frozen lockfile install"
file_not_contains_regex "Dockerfile" "pnpm install --frozen-lockfile[[:space:]]*\\|\\|" "Dockerfile has no pnpm install fallback"
file_contains "Dockerfile" "COPY packages/agentflow/package.json ./packages/agentflow/" "Dockerfile installs the agentflow workspace"
file_contains "Dockerfile" "COPY packages/observe/package.json ./packages/observe/" "Dockerfile installs the observe workspace"
file_contains "Dockerfile" 'CMD [ "node", "packages/server/bin/run", "start" ]' "Runtime starts through the built Node CLI"
file_not_contains_regex "Dockerfile" 'CMD[[:space:]]*\[[[:space:]]*"pnpm"' "Runtime CMD does not require pnpm"
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
file_contains "docker-compose.prod.yml" "IFRAME_ORIGINS=\${IFRAME_ORIGINS:-'self'}" "Compose defaults IFRAME_ORIGINS to CSP self"
file_contains "docker-compose.prod.yml" 'CSP_ENFORCEMENT_MODE=${CSP_ENFORCEMENT_MODE:-compat}' "Compose defaults CSP enforcement to compat"
file_contains "docker-compose.prod.yml" 'CSP_REPORT_ONLY_MODE=${CSP_REPORT_ONLY_MODE:-off}' "Compose defaults CSP report-only to off"
file_contains "docker-compose.prod.yml" 'DEEPSEEK_BASE_URL_ALLOWLIST=${DEEPSEEK_BASE_URL_ALLOWLIST:-}' "Compose forwards the DeepSeek endpoint allowlist"
file_contains "docker-compose.prod.yml" 'KIMI_BASE_URL_ALLOWLIST=${KIMI_BASE_URL_ALLOWLIST:-}' "Compose forwards the Kimi endpoint allowlist"
file_contains ".env.production.template" "DEEPSEEK_BASE_URL_ALLOWLIST=" "Production template defines the DeepSeek endpoint allowlist"
file_contains ".env.production.template" "KIMI_BASE_URL_ALLOWLIST=" "Production template defines the Kimi endpoint allowlist"
file_contains ".env.production.template" "FLOWISE_IMAGE=" "Production template defines the immutable Flowise image key"
file_contains ".env.production.template" "POSTGRES_IMAGE=" "Production template defines the explicit PostgreSQL image key"
file_contains ".env.production.template" "CSP_ENFORCEMENT_MODE=compat" "Production template keeps compatible CSP enforcement"
file_contains ".env.production.template" "CSP_REPORT_ONLY_MODE=off" "Production template requires explicit CSP observation"
file_not_contains_regex "packages/ui/index.html" "fonts\\.googleapis|fonts\\.gstatic|r\\.wdfl\\.co|rewardful" "UI index has no blocked third-party font/rewardful resources"
file_not_contains_regex "packages/ui/index.html" "<script[[:space:]]*>" "UI index has no executable inline script block"
file_contains "packages/ui/index.html" '<script src="/global.js"></script>' "UI loads the compatibility bootstrap from self"
file_contains "packages/ui/public/global.js" "globalThis.global = globalThis" "UI global bootstrap is a same-origin static asset"
file_not_contains_regex "packages/ui/src/views/auth/register.jsx" "data-rewardful|rewardful" "Register page has no rewardful marker"
file_contains "packages/ui/package.json" '"flowise-embed": "3.1.5"' "UI pins flowise-embed"
file_contains "packages/ui/package.json" '"flowise-embed-react": "3.1.5"' "UI pins flowise-embed-react"
file_contains "packages/ui/package.json" '"zod": "^3.25.76"' "UI declares its direct zod dependency"
file_not_contains_regex "packages/ui/vite.config.js" "\\.\\./\\.\\./node_modules/@(codemirror|uiw|lezer)" "Vite does not depend on root-hoisted editor packages"
file_contains "packages/ui/src/views/auth/signIn.jsx" "ssoApi.ssoLogin" "Sign-in uses the exported SSO API binding"
file_contains "packages/ui/src/views/auth/signIn.jsx" "loginMethodApi.getDefaultLoginMethods" "Sign-in uses the exported login-method API binding"
path_not_contains_regex "packages/ui/src/views/auth" "width:[[:space:]]*'480px'" "Auth views avoid fixed 480px form widths"
file_contains "packages/ui/src/layout/AuthLayout/index.jsx" "maxWidth: '512px'" "Auth layout constrains responsive content width"
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
file_not_contains_regex "packages/server/src/index.ts" "existingCsp|baseCspDirectives" "Server has no hand-written CSP merge"
file_contains_in_order "packages/server/src/index.ts" "this.app.use(CSP_REPORT_ENDPOINT" "this.app.use(express.json" "CSP report route precedes the global JSON parser"
file_exists "scripts/release-manifest.mjs" "Release manifest generator exists"
file_exists "scripts/release-manifest.test.mjs" "Release manifest tests exist"
file_contains ".github/workflows/main.yml" "node-version: [24.18.0]" "Main CI uses Node 24.18.0"
file_contains ".github/workflows/main.yml" "pnpm install --frozen-lockfile" "Main CI uses a frozen root install"
file_contains ".github/workflows/main.yml" "pnpm test:release" "Main CI runs release contract tests"
file_contains ".github/workflows/main.yml" "bash scripts/verify-release-source.sh" "Main CI runs the release source gate"
file_contains ".github/workflows/main.yml" "bash scripts/verify-security.sh" "Main CI runs the static security gate"
file_contains ".github/workflows/test_docker_build.yml" "node-version: '24.18.0'" "Docker test CI uses Node 24.18.0"
file_contains ".github/workflows/test_docker_build.yml" "pnpm install --frozen-lockfile" "Docker test CI uses a frozen root install"
file_contains ".github/workflows/test_docker_build.yml" "file: Dockerfile" "Docker test CI builds the fork root Dockerfile"
file_contains ".github/workflows/test_docker_build.yml" "push: false" "Docker test CI never pushes"
file_contains ".github/workflows/test_docker_build.yml" "BUILD_REVISION=" "Docker test CI injects OCI provenance"
file_fixed_count ".github/workflows/publish-package.yml" "node-version: '24.18.0'" 2 "Package workflows use Node 24.18.0"
file_not_contains_regex ".github/workflows/publish-package.yml" "node-version:[[:space:]]*'20" "Package workflows contain no Node 20 install"
file_fixed_count ".github/workflows/publish-package.yml" "pnpm install --frozen-lockfile" 2 "Package workflows keep frozen root installs"
file_contains ".github/workflows/docker-image-ecr.yml" "node-version: '24.18.0'" "ECR build-only CI uses Node 24.18.0"
file_contains ".github/workflows/docker-image-ecr.yml" "pnpm install --frozen-lockfile" "ECR build-only CI uses a frozen root install"
file_contains ".github/workflows/docker-image-ecr.yml" "file: Dockerfile" "ECR build-only CI uses the fork root Dockerfile"
file_contains ".github/workflows/docker-image-ecr.yml" "push: false" "ECR foundation lane never pushes"
file_contains ".github/workflows/docker-image-ecr.yml" "BUILD_REVISION=" "ECR foundation lane injects OCI provenance"
file_not_contains_regex ".github/workflows/docker-image-ecr.yml" "default:[[:space:]]*['\"]?latest|amazon-ecr-login|configure-aws-credentials|push:[[:space:]]*true" "ECR foundation lane has no latest tag or registry login"

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
