# Flowise CSP And Iframe Governance Design

**Date:** 2026-07-10
**Status:** approved for local L2 implementation
**Batch:** 6B
**Boundary:** `provider_call=false`, `secrets_read=false`, `production_write=false`

## 1. Problem Statement

The current server constructs CSP in two unrelated middlewares. `IFRAME_ORIGINS` is copied into `frame-ancestors` after CSV splitting, while production CSP is assembled with a second hand-written merge. This creates four failure classes:

1. Invalid or injected iframe values can reach a response header.
2. Production wildcard iframe configuration logs a warning and silently changes behavior instead of stopping startup.
3. CSP tightening is an all-or-nothing source edit with no observable rollout state.
4. The UI contains an inline bootstrap script, and the built application contains legacy dynamic `Function(...)` paths, so immediately enforcing a strict policy can break authenticated or lazy-loaded flows.

The production edge currently has a single CSP owner at the app layer. This batch preserves that ownership contract.

## 2. Decision

Implement staged CSP governance rather than immediately enforcing a strict policy:

-   Parse `IFRAME_ORIGINS` as a typed, origin-only configuration and fail startup on invalid values.
-   Build CSP from one structured policy module.
-   Keep enforcement at `compat` by default.
-   Add stricter candidate modes through `Content-Security-Policy-Report-Only`.
-   Add a bounded, rate-limited same-origin report receiver that logs only sanitized fields.
-   Move the UI's explicit inline bootstrap into a same-origin static file.
-   Treat remaining dynamic-code bundle findings as an enforcement blocker until browser evidence covers the affected lazy-loaded flows.

Rejected alternatives:

-   **Iframe-only patch:** reduces header injection risk but leaves CSP rollout and duplicated assembly debt.
-   **Immediate strict enforcement:** has unacceptable outage risk because the current bundle still contains runtime-generated function paths and the UI styling stack uses inline styles.

## 3. Iframe Origin Contract

`IFRAME_ORIGINS` remains a comma-separated operator setting, but every entry must satisfy one of these forms:

-   `'self'`
-   standalone `'none'`
-   exact `https://host[:port]` origin
-   `http://localhost[:port]`, `http://127.0.0.1[:port]`, or `http://[::1][:port]` outside production only
-   `*` outside production only

Normalization rules:

-   Empty or unset configuration becomes `'self'`.
-   URLs are normalized with the platform `URL` parser and emitted as exact origins.
-   Duplicates are removed while preserving first occurrence.
-   `'none'` cannot be combined with another source.

Fail-fast rejections:

-   Bare `self` or `none`, unsupported quoted CSP keywords, control characters, newline, or semicolon.
-   Empty CSV elements, malformed URLs, credentials, query, fragment, or a non-root path.
-   Non-HTTPS remote origins in production.
-   Wildcard in production.
-   Any exact-origin hostname containing a literal wildcard or a wildcard produced by URL percent-normalization, in every environment.

Errors identify the invalid configuration class but never echo the submitted value.

## 4. CSP Policy Modes

`CSP_ENFORCEMENT_MODE` accepts:

| Mode            | `script-src`                           | `style-src`              | Purpose                                 |
| --------------- | -------------------------------------- | ------------------------ | --------------------------------------- |
| `compat`        | `'self' 'unsafe-inline' 'unsafe-eval'` | `'self' 'unsafe-inline'` | Current behavior and default            |
| `no-eval`       | `'self' 'unsafe-inline'`               | `'self' 'unsafe-inline'` | First candidate: detect dynamic code    |
| `strict-script` | `'self'`                               | `'self' 'unsafe-inline'` | Second candidate: remove inline scripts |
| `strict`        | `'self'`                               | `'self'`                 | Final candidate: remove inline styles   |

`CSP_REPORT_ONLY_MODE` accepts the same modes plus `off`, which is the default. A report-only mode must be strictly stronger than the enforced mode; otherwise startup fails. This prevents misleading observation configurations.

The enforced policy always includes validated `frame-ancestors`. The report-only candidate omits `frame-ancestors`, because embedding remains governed by the enforced policy and report-only framing behavior is not an enforcement substitute.

Both policies retain the current baseline directives:

-   `default-src 'self'`
-   `img-src 'self' data: blob:`
-   `connect-src 'self' ws: wss:`
-   `font-src 'self'`
-   `manifest-src 'self'`
-   `base-uri 'self'`
-   `form-action 'self'`

## 5. Report Receiver

When report-only mode is enabled, the server emits:

-   `Content-Security-Policy-Report-Only`
-   an absolute same-origin `Reporting-Endpoints` URL derived from validated `APP_URL`
-   both `report-to flowise-csp` and the compatibility `report-uri` directive

`POST /api/v1/security/csp-report` is registered before the global 50 MB JSON parser and has its own controls:

-   accepts `application/csp-report`, `application/reports+json`, and `application/json`
-   maximum body size 16 KiB
-   in-memory IP rate limit
-   returns `204` for valid report envelopes
-   returns `400` for malformed JSON and `413` for oversized bodies
-   never requires authentication, creates product data, or calls an external service

At most the first ten Reporting API envelopes are examined. One accepted request emits at most one warning whose only argument is one-line JSON containing the fixed event name and sanitized report array. Logged data is allowlisted to directive, disposition, status code, and document/blocked origins only. Query strings, fragments, credentials, URL paths, request body, user agent, cookies, source snippets, arbitrary fields, and logger metadata are excluded.

Reporting API delivery is best effort and may be delayed by the browser. `APP_URL` is required when report-only mode is enabled; remote endpoints must use HTTPS, while HTTP loopback is accepted only for isolated local acceptance. Because the endpoint uses IP rate limiting, report-only startup also rejects unrestricted `TRUST_PROXY=true`; operators must use `false`, an explicit hop count, or an explicit trusted proxy policy. Numeric hop counts must be finite, non-negative integers and are rejected during startup otherwise.

## 5.1 Request Boundary Closure

-   Production session cookies are always secure, even if `SECURE_COOKIES=false` is supplied. Non-production retains explicit true/false and HTTPS `APP_URL` fallback behavior.
-   `/api/v1/auth/resolve` is POST-only. Other methods receive a bounded `405`, `Allow: POST`, and no internal error details.
-   Missing production `CORS_ORIGINS` is logged during startup validation only. Request-time CORS option construction is a pure configuration read.

## 6. Middleware Ordering

The server configuration order becomes:

1. Resolve and set `trust proxy`.
2. Validate iframe, CSP, `APP_URL`, and report/proxy environment settings.
3. Install the combined CSP, iframe, and direct-deployment fallback header middleware.
4. Register the bounded CSP report route.
5. Register global request body parsers.
6. Register CORS and cookies.
7. Continue with request logging, sanitization, authentication, and API routing.

This ordering ensures the report endpoint cannot consume the global 50 MB body allowance, rate limiting sees the configured client IP model, and every early report response retains the direct-deployment security headers.

## 7. Rollout And Rollback

This batch completes only local L2 acceptance. Production remains unchanged.

Future production rollout must be separately authorized and use these independent gates:

1. Deploy code with `CSP_ENFORCEMENT_MODE=compat`, `CSP_REPORT_ONLY_MODE=no-eval`.
2. Observe sanitized violations across unauthenticated and authenticated flows for an agreed window.
3. Remove or replace confirmed dynamic-code dependencies, then promote enforcement to `no-eval` while observing `strict-script`.
4. After all inline scripts are eliminated, promote enforcement to `strict-script` while observing `strict`.
5. Address style nonces/hashes or styling architecture before enforcing `strict`.

Rollback is configuration-first: set report-only to `off` and enforcement to the last known-good weaker mode, then restart. Code rollback is required only if header generation or the report route itself is defective.

## 8. Acceptance Criteria

-   Invalid iframe and CSP mode configurations fail before request handling.
-   CSP values are assembled by one tested module without string-merging middleware.
-   Report-only headers are absent by default and correct when explicitly enabled.
-   Report ingestion is bounded, rate-limited, sanitized, and unauthenticated by design.
-   Reporting API arrays are capped at ten examined envelopes and one one-line JSON warning per request.
-   Production cookie, auth method, trust-proxy numeric, and startup-only CORS warning boundaries have focused tests.
-   `packages/ui/index.html` contains no executable inline script.
-   Server unit tests, TypeScript, focused lint, UI tests, UI build, static security checks, and `git diff --check` pass.
-   An isolated local production-mode HTTP smoke verifies enforced/report-only headers and report response codes.
-   Dynamic `Function(...)` findings are recorded as a blocker, not misreported as fixed.
-   `production_write=false`; no deployment, provider request, or secret read occurs.

## 9. Standards References

-   W3C Content Security Policy Level 3: <https://www.w3.org/TR/CSP/>
-   MDN `frame-ancestors`: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors>
-   MDN CSP Report-Only: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy-Report-Only>
