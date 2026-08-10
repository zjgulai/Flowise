#!/usr/bin/env bash

# Emit the lowercase SHA-256 digest for stdin without assuming GNU coreutils.
# Linux release runners provide sha256sum; macOS provides shasum.

set -euo pipefail

fail() {
    printf 'SHA-256 helper failed: %s\n' "$1" >&2
    exit 1
}

(($# == 0)) || fail 'arguments are not supported'

output=''
if command -v sha256sum >/dev/null 2>&1; then
    output=$(sha256sum) || fail 'SHA-256 tool execution failed'
elif command -v shasum >/dev/null 2>&1; then
    output=$(shasum -a 256) || fail 'SHA-256 tool execution failed'
else
    fail 'SHA-256 tool is unavailable'
fi

if [[ ! "$output" =~ ^([0-9a-f]{64})[[:space:]]+-$ ]]; then
    fail 'SHA-256 tool returned invalid output'
fi

printf '%s\n' "${BASH_REMATCH[1]}"
