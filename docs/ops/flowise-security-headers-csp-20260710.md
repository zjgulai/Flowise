# Flowise CSP And Iframe Operations Guide

**Updated:** 2026-07-12
**Applies to:** FlowAgentic Flowise fork
**Current production state:** Stage 0 source not deployed; fresh public L3 is recorded below

## Stage 0 Source Evidence (2026-07-12)

-   The reviewed source commit is `137256127d42e787faaa0292e56bb8d4da75ace6`.
-   Final local verification passed `127/127` focused server tests, `65/65` UI tests, and `52/52` static security checks; TypeScript, focused ESLint, and the UI production build also passed.
-   Independent review found that the report router preceded the application security-header middleware. The fix installs the combined fallback/CSP middleware before the receiver, so early `204`, `400`, `413`, and `415` report responses share the header boundary; the regression suite passed and the fix was independently re-reviewed.
-   This Stage 0 source has not been deployed. Production promotion remains gated on explicit authorization and the observation/rollback procedure below.

## Fresh Production L3 Observation (2026-07-12)

-   The read-only public edge smoke passed `14/14`: the sign-in response contained exactly one HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, and CSP header.
-   The same response had `0` Content-Security-Policy-Report-Only headers and `0` Reporting-Endpoints headers; its enforced CSP still contained `'unsafe-eval'` and no reporting directive.
-   These observations support only the current public read-only contract. They provide no evidence that the Stage 0 Batch 6B source or report-only rollout has reached production.

## Header Ownership

-   Nginx edge owns `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy`.
-   The Flowise app owns `Content-Security-Policy`, `Content-Security-Policy-Report-Only`, and `Reporting-Endpoints`.
-   The app retains direct-deployment fallback headers. The Flowise Nginx location hides duplicate upstream fallback headers at the edge.
-   The app installs its combined CSP/iframe/direct-deployment fallback middleware before the report receiver, so early report and parser responses retain the same header contract.

Do not add CSP to the shared Nginx configuration. It would recreate split ownership and make application rollout modes impossible to audit.

## Environment Contract

```dotenv
APP_URL=https://flowise.example.com
TRUST_PROXY=1
IFRAME_ORIGINS="'self'"
CSP_ENFORCEMENT_MODE=compat
CSP_REPORT_ONLY_MODE=off
```

`APP_URL` is required when report-only mode is enabled. It is used to emit an absolute same-origin Reporting API endpoint. Remote URLs must use HTTPS; HTTP loopback is accepted only for isolated local testing.

`TRUST_PROXY=true` is rejected when report-only mode is enabled because unrestricted proxy trust makes IP rate limiting bypassable. Use `false`, an explicit hop count such as `1`, or an explicit trusted subnet/policy matching the deployment topology. Numeric hop counts must be finite, non-negative integers; values such as `Infinity`, `NaN`, `1.5`, and `-1` fail during startup.

## Iframe Sources

Accepted production values:

```dotenv
IFRAME_ORIGINS="'self'"
IFRAME_ORIGINS="'none'"
IFRAME_ORIGINS="'self',https://embed.example.com,https://admin.example.com:8443"
```

The server normalizes exact origins and removes duplicates. Startup fails for:

-   production wildcard
-   bare `self` or `none`
-   unsupported quoted keywords
-   semicolon, newline, control characters, or empty CSV entries
-   URL credentials, path, query, or fragment
-   literal or URL-normalized hostname wildcards such as `https://*.example.com` or `https://%2a.example.com`
-   remote HTTP origins
-   `'none'` or wildcard combined with another source

The error identifies the rule but does not echo the submitted setting.

## CSP Modes

| Mode            | Script policy        | Style policy  | Use                         |
| --------------- | -------------------- | ------------- | --------------------------- |
| `compat`        | self + inline + eval | self + inline | current enforcement         |
| `no-eval`       | self + inline        | self + inline | first report-only candidate |
| `strict-script` | self                 | self + inline | second candidate            |
| `strict`        | self                 | self          | final candidate             |

`CSP_REPORT_ONLY_MODE` also accepts `off`. A report-only mode must be strictly stronger than the enforcement mode, or startup fails.

Recommended first production observation configuration after explicit deploy authorization:

```dotenv
CSP_ENFORCEMENT_MODE=compat
CSP_REPORT_ONLY_MODE=no-eval
```

Do not set enforcement to `no-eval` yet. The local login page produced a real `script-src` report-only violation from the main UI bundle's dynamic code path. The build also contains legacy `Function(...)` fallbacks across four chunks. The responsible dependency path must be removed or proven unreachable across authenticated lazy-loaded workflows before promotion.

Do not set enforcement to `strict` until the Emotion/MUI inline-style strategy is replaced with nonces, hashes, or another tested compatible mechanism.

## Report Receiver

Endpoint:

```text
POST /api/v1/security/csp-report
```

Controls:

-   registered before the global 50 MB body parser
-   accepts `application/csp-report`, `application/reports+json`, and `application/json`
-   16 KiB body limit
-   120 requests per minute per resolved client IP
-   `204` for accepted report envelopes
-   `400` for malformed JSON
-   `413` for oversized bodies
-   `415` for unsupported media types

The receiver examines at most the first ten Reporting API envelopes per request and emits at most one warning. The warning's only argument is a one-line JSON message containing a fixed event name and an array of sanitized reports. This keeps directive, disposition, status code, document origin, and blocked origin or a known special value such as `eval` or `inline` in the actual message preserved by the production formatter. Paths, query strings, fragments, credentials, source snippets, source files, cookies, user agents, arbitrary fields, and logger metadata are excluded.

## Request Boundaries

-   Production always uses secure session cookies; `SECURE_COOKIES=false` cannot downgrade that policy. Non-production retains the explicit override and HTTPS `APP_URL` fallback.
-   `/api/v1/auth/resolve` accepts POST only. GET, HEAD, and other methods return a bounded `405` with `Allow: POST` and no internal field names.
-   A missing production `CORS_ORIGINS` value is warned once during startup validation. Request-time CORS option creation performs no repeated configuration logging.

Browser delivery is best effort and may be delayed. A console violation or `ReportingObserver` entry proves generation, not successful server delivery. Production acceptance must confirm fresh sanitized server log entries during the agreed observation window.

## Local Verification

```bash
pnpm --filter flowise exec jest --runInBand \
  src/utils/XSS.test.ts \
  src/utils/csp.test.ts \
  src/utils/cspReport.test.ts \
  src/enterprise/middleware/passport/authSecurityPolicy.test.ts
pnpm --filter flowise exec tsc --noEmit
pnpm --filter flowise exec eslint \
  src/utils/XSS.ts src/utils/csp.ts src/utils/cspReport.ts src/index.ts \
  src/enterprise/middleware/passport/authSecurityPolicy.ts \
  src/enterprise/middleware/passport/index.ts \
  --max-warnings 0
pnpm --filter flowise-ui build
bash scripts/verify-security.sh
docker compose --env-file .env.production.template -f docker-compose.prod.yml config --quiet
git diff --check
```

Manual report receiver smoke:

```bash
curl -i \
  -H 'Content-Type: application/csp-report' \
  --data '{"csp-report":{"effective-directive":"script-src","blocked-uri":"eval"}}' \
  http://127.0.0.1:PORT/api/v1/security/csp-report
```

Expected status is `204`. Never include a real token, URL query, credential, or user identifier in a manual fixture.

## Production Promotion Gates

1. Obtain explicit deployment authorization and define the observation window.
2. Back up current Compose/env configuration without printing values.
3. Deploy code with `compat` enforcement and `no-eval` report-only.
4. Verify HTTPS headers, public auth flows, authenticated workflows, lazy code viewers, editor pages, uploads, and console state.
5. Confirm the report endpoint receives sanitized browser-generated entries and remains below rate/body limits.
6. Classify every violation by route and dependency; do not log raw report bodies.
7. Remove root causes, rebuild, and repeat report-only observation.
8. Promote exactly one enforcement level per authorized change with a separate rollback checkpoint.

## Rollback

Configuration rollback is preferred:

```dotenv
CSP_ENFORCEMENT_MODE=compat
CSP_REPORT_ONLY_MODE=off
```

Restart only the Flowise service, then verify HTTPS `/api/v1/ping`, `/signin`, header cardinality, browser console, and container restart count. Code rollback is needed only if policy construction, iframe parsing, or the receiver itself is defective.
