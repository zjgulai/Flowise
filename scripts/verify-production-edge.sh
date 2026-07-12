#!/usr/bin/env bash
# Read-only production edge contract. This script does not authenticate or call providers.

set -euo pipefail

BASE_URL="${1:-}"
if [[ -z "$BASE_URL" ]]; then
    echo "Usage: bash scripts/verify-production-edge.sh https://flowise.example.com" >&2
    exit 2
fi

if [[ "$BASE_URL" != https://* || "$BASE_URL" =~ [[:space:][:cntrl:]] ]]; then
    echo "Production edge verification requires a plain https:// origin" >&2
    exit 2
fi

ORIGIN="${BASE_URL#https://}"
ORIGIN="${ORIGIN%/}"
if [[ -z "$ORIGIN" || "$ORIGIN" == */* || "$ORIGIN" == *"@"* || "$ORIGIN" == *"?"* || "$ORIGIN" == *"#"* ]]; then
    echo "Production edge verification requires a plain https:// origin" >&2
    exit 2
fi
if [[ ! "$ORIGIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$ ]]; then
    echo "Production edge verification requires a plain https:// origin" >&2
    exit 2
fi
BASE_URL="https://${ORIGIN}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0
CURL=(curl --silent --show-error --connect-timeout 10 --max-time 30 --retry 2)

pass() {
    echo "  PASS $1"
    PASS=$((PASS + 1))
}

fail() {
    echo "  FAIL $1"
    FAIL=$((FAIL + 1))
}

request() {
    local name=$1
    local method=$2
    local path=$3
    shift 3

    "${CURL[@]}" \
        --request "$method" \
        --dump-header "$TMP_DIR/$name.headers" \
        --output "$TMP_DIR/$name.body" \
        --write-out '%{http_code}' \
        "$@" \
        "$BASE_URL$path"
}

assert_status() {
    local actual=$1
    local expected=$2
    local label=$3
    if [[ "$actual" == "$expected" ]]; then
        pass "$label"
    else
        fail "$label (expected $expected, got $actual)"
    fi
}

header_count() {
    local file=$1
    local header_name=$2
    local normalized_name
    normalized_name="$(printf '%s' "$header_name" | tr '[:upper:]' '[:lower:]')"
    awk -F: -v target="$normalized_name" '
        tolower($1) == target { count++ }
        END { print count + 0 }
    ' "$file"
}

assert_header_once() {
    local file=$1
    local header_name=$2
    local value_pattern=$3
    local count
    count="$(header_count "$file" "$header_name")"

    if [[ "$count" != "1" ]]; then
        fail "$header_name appears exactly once (got $count)"
        return
    fi

    if tr -d '\r' < "$file" | grep -Eiq "^${header_name}:[[:space:]]*${value_pattern}"; then
        pass "$header_name appears once with the expected contract"
    else
        fail "$header_name value matches the expected contract"
    fi
}

echo "Flowise production edge verification"
echo "target: $BASE_URL"

ping_status="$(request ping GET /api/v1/ping)"
assert_status "$ping_status" "200" "health endpoint returns 200"
if [[ "$(tr -d '\r\n' < "$TMP_DIR/ping.body")" == "pong" ]]; then
    pass "health endpoint returns pong"
else
    fail "health endpoint returns pong"
fi

signin_status="$(request signin GET /signin)"
assert_status "$signin_status" "200" "sign-in page returns 200"
assert_header_once "$TMP_DIR/signin.headers" "Strict-Transport-Security" "max-age=31536000;[[:space:]]*includeSubDomains"
assert_header_once "$TMP_DIR/signin.headers" "X-Frame-Options" "SAMEORIGIN"
assert_header_once "$TMP_DIR/signin.headers" "X-Content-Type-Options" "nosniff"
assert_header_once "$TMP_DIR/signin.headers" "Referrer-Policy" "strict-origin-when-cross-origin"
assert_header_once "$TMP_DIR/signin.headers" "Content-Security-Policy" ".*default-src[[:space:]]+'self'"

auth_get_status="$(request auth_get GET /api/v1/auth/resolve)"
assert_status "$auth_get_status" "405" "auth resolve rejects GET with 405"
if grep -Eiq 'isOrganizationAdmin|Cannot read properties|"stack"' "$TMP_DIR/auth_get.body"; then
    fail "auth resolve GET body does not expose internal implementation details"
else
    pass "auth resolve GET body does not expose internal implementation details"
fi

auth_post_status="$(request auth_post POST /api/v1/auth/resolve)"
assert_status "$auth_post_status" "200" "auth resolve accepts POST"
if grep -Eq '"redirectUrl"[[:space:]]*:[[:space:]]*"/signin"' "$TMP_DIR/auth_post.body"; then
    pass "auth resolve POST preserves the /signin contract"
else
    fail "auth resolve POST preserves the /signin contract"
fi

cors_status="$(request cors OPTIONS /api/v1/prediction/not-a-uuid \
    --header 'Origin: https://malicious.invalid' \
    --header 'Access-Control-Request-Method: POST')"
if [[ "$cors_status" =~ ^[234][0-9][0-9]$ ]]; then
    pass "malicious-origin preflight avoids a 5xx response"
else
    fail "malicious-origin preflight avoids a 5xx response (got $cors_status)"
fi

if [[ "$(header_count "$TMP_DIR/cors.headers" "Access-Control-Allow-Origin")" == "0" ]]; then
    pass "malicious-origin preflight receives no Access-Control-Allow-Origin"
else
    fail "malicious-origin preflight receives no Access-Control-Allow-Origin"
fi

echo ""
echo "Summary: $PASS passed, $FAIL failed"
if (( FAIL > 0 )); then
    exit 1
fi
