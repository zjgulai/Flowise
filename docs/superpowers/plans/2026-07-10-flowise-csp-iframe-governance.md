# Flowise CSP And Iframe Governance Implementation Plan

> **For agentic workers:** execute in order with test-driven development. The repository is dirty; stay on the current branch, preserve unrelated changes, and do not commit, deploy, read secrets, or call a model provider.

**Goal:** Replace permissive iframe parsing and hand-merged CSP with fail-fast configuration, staged policies, bounded report-only telemetry, and locally verified rollout controls.

**Architecture:** `XSS.ts` owns validated iframe sources, a focused `csp.ts` owns deterministic policy construction and trust-proxy parsing, and a focused `cspReport.ts` owns the public report receiver. `authSecurityPolicy.ts` owns the production cookie and auth-resolve method boundaries. `App.config()` resolves all security configuration before installing middleware. The UI bootstrap becomes a same-origin static script. Production enforcement defaults to the existing compatible policy.

**Tech Stack:** TypeScript, Express, Jest, Supertest, existing `express-rate-limit`, Vite/React, shell security gates.

## Global Constraints

-   `provider_call=false`, `secrets_read=false`, `production_write=false`.
-   Do not alter the production server, Docker containers, Nginx, database, or provider configuration.
-   Do not add dependencies or modify the lockfile.
-   Never print environment values or raw CSP report payloads.
-   Preserve the current Nginx/app header ownership contract.
-   Every implementation task starts with a test that fails for the intended missing behavior.

## Task 1: Fail-Fast Iframe Configuration

**Files:**

-   Modify: `packages/server/src/utils/XSS.ts`
-   Modify: `packages/server/src/utils/XSS.test.ts`

-   [x] Replace permissive iframe tests with the explicit origin contract.
-   [x] Add RED cases for bare/unsupported keywords, separators/control characters, empty CSV elements, path/query/fragment/credentials, remote HTTP, wildcard production use, and `'none'` combinations.
-   [x] Add GREEN cases for default `'self'`, standalone `'none'`, normalized HTTPS origins, ports, deduplication, mixed `'self'` plus origins, and local HTTP outside production.
-   [x] Implement a parser using `URL`, exact origin comparison, generic errors, and stable deduplication.
-   [x] Make production wildcard and invalid values throw rather than warn or silently fall back.
-   [x] Preserve existing CORS behavior and tests.
-   [x] Reject literal and URL-normalized hostname wildcards in every environment.
-   [x] Emit the missing-production-CORS warning during startup validation only.

**Targeted verification:**

```bash
pnpm --filter flowise exec jest --runInBand src/utils/XSS.test.ts
```

## Task 2: Structured CSP Modes

**Files:**

-   Create: `packages/server/src/utils/csp.ts`
-   Create: `packages/server/src/utils/csp.test.ts`

-   [x] Add RED tests for `compat`, `no-eval`, `strict-script`, and `strict` directive sets.
-   [x] Add RED tests for invalid enforcement/report-only modes and non-stricter report candidates.
-   [x] Add RED tests for missing/invalid report `APP_URL` and unrestricted `TRUST_PROXY=true`.
-   [x] Add RED tests proving default report-only is absent and enabled report-only includes reporting directives without weakening enforced `frame-ancestors`.
-   [x] Implement typed mode parsing, strictness ordering, deterministic directive serialization, and header generation.
-   [x] Keep `compat`/`off` as defaults.
-   [x] Parse numeric `TRUST_PROXY` values only when finite, non-negative integers.

**Targeted verification:**

```bash
pnpm --filter flowise exec jest --runInBand src/utils/csp.test.ts
```

## Task 3: Bounded CSP Report Receiver

**Files:**

-   Create: `packages/server/src/utils/cspReport.ts`
-   Create: `packages/server/src/utils/cspReport.test.ts`

-   [x] Add RED Supertest cases for legacy CSP envelopes and Reporting API arrays.
-   [x] Verify valid payloads return `204` and only sanitized allowlisted fields reach the logger.
-   [x] Verify query, fragment, source sample, cookies, and arbitrary payload fields never reach logs.
-   [x] Verify malformed JSON returns `400`, oversized input returns `413`, unsupported methods do not succeed, and a bounded rate limit is installed.
-   [x] Implement the router with a 16 KiB route-local parser and existing `express-rate-limit`.
-   [x] Support the three required media types without accepting arbitrary text.
-   [x] Examine at most ten Reporting API envelopes and aggregate them into one one-line JSON warning per request.

**Targeted verification:**

```bash
pnpm --filter flowise exec jest --runInBand src/utils/cspReport.test.ts
```

## Task 4: Server Integration And UI Bootstrap

**Files:**

-   Create: `packages/server/src/enterprise/middleware/passport/authSecurityPolicy.ts`
-   Create: `packages/server/src/enterprise/middleware/passport/authSecurityPolicy.test.ts`
-   Modify: `packages/server/src/enterprise/middleware/passport/index.ts`
-   Modify: `packages/server/src/index.ts`
-   Modify: `packages/ui/index.html`
-   Modify: `packages/ui/src/views/auth/register.jsx`
-   Create: `packages/ui/public/global.js`
-   Modify: `.env.production.template`
-   Modify: `docker-compose.prod.yml`

-   [x] Resolve `trust proxy` before report-route registration.
-   [x] Resolve iframe and CSP configuration once, before global body parsers.
-   [x] Derive an absolute same-origin Reporting API endpoint from validated `APP_URL`.
-   [x] Reject report-only startup when proxy trust is unrestricted.
-   [x] Register the report router before the global 50 MB parsers.
-   [x] Install the combined security-header middleware before the report router so early report and parser responses retain the fallback header contract.
-   [x] Replace the two CSP middlewares and hand-written merge with deterministic generated headers.
-   [x] Retain direct-deployment HSTS/XFO/XCTO/Referrer fallback behavior.
-   [x] Externalize the global compatibility bootstrap into `/global.js` and remove executable inline HTML.
-   [x] Add non-secret CSP mode keys with safe defaults to template and Compose.
-   [x] Keep production cookies secure despite a false override and make auth resolve POST-only through focused tested helpers.
-   [x] Remove the remaining registration Rewardful marker.

## Task 5: Static And Runtime Acceptance

**Files:**

-   Modify: `scripts/verify-security.sh`
-   Modify: `docs/ops/flowise-security-headers-csp-20260710.md`

-   [x] Add static gates for exact CSP env keys, iframe defaults, no inline HTML script, report body limit, route ordering, and no production wildcard fallback.
-   [x] Document mode semantics, report privacy, rollout gates, rollback, and known dynamic-code blockers.
-   [x] Run all three focused server suites together.
-   [x] Run server TypeScript and focused ESLint.
-   [x] Run full server Jest if focused suites pass.
-   [x] Run UI Jest and production build.
-   [x] Scan built HTML for inline executable scripts and built JS for `eval`/`Function` patterns; record findings without weakening the test.
-   [x] Run `bash scripts/verify-security.sh`, Compose template render, and `git diff --check`.
-   [x] Start an isolated local production-mode HTTP fixture and verify default and report-only headers plus report `204/400/413` behavior.

**Commands:**

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
pnpm --filter flowise test -- --runInBand
pnpm --filter flowise-ui test -- --runInBand
pnpm --filter flowise-ui build
bash scripts/verify-security.sh
docker compose --env-file .env.production.template -f docker-compose.prod.yml config --quiet
git diff --check
```

## Task 6: Adversarial Closeout

**Files:**

-   Modify: `docs/audits/flowise-production-adversarial-audit-20260710.md`
-   Modify: `.kiro/plan/task_plan.md`
-   Modify: `.kiro/plan/findings.md`
-   Modify: `.kiro/plan/progress.md`

-   [x] Re-test injection, clickjacking, oversized telemetry, sensitive-log, and downgrade scenarios.
-   [x] Record exact RED/GREEN evidence and any residual bundle/style blockers.
-   [x] Mark Batch 6B local L2 status without claiming production observation or deployment.
-   [x] Preserve Batch 4 identity blocker and Batch 5 provider-call boundary.
-   [x] Record `production unchanged`, `provider_call=false`, `secrets_read=false`.

## Execution Outcome

-   TDD RED proved the parser, CSP policy module, and report receiver contracts were missing before implementation; all focused suites turned GREEN after the scoped changes.
-   Server verification passed: 33/33 suites and 967/967 tests, `tsc --noEmit`, focused ESLint, and the server build.
-   UI verification passed: 2/2 suites and 65/65 tests plus the production build (21176 modules). Existing large-chunk and dynamic/static import warnings remain Batch 7 debt.
-   Security and packaging checks passed: 52/52 static checks, Compose template render, and `git diff --check`.
-   An isolated production-mode HTTP fixture emitted `compat` enforcement, `no-eval` report-only, exact `frame-ancestors`, and an absolute Reporting API endpoint. The receiver returned `204` for an accepted report, `400` for malformed JSON, and `413` for oversized input.
-   Browser acceptance rendered `/signin` without console errors or warnings and generated a real report-only `script-src` violation observable through `ReportingObserver`. Automatic browser POST delivery was not observed on the local HTTP fixture and is not claimed.
-   The production UI bundle still contains eight dynamic `Function("return this")` occurrences across four chunks plus a regenerator fallback. This blocks enforcement promotion to `no-eval` until the responsible paths are removed or proven unreachable across authenticated lazy-loaded workflows.
-   Boundary: `production unchanged`, `provider_call=false`, `secrets_read=false`, `production_write=false`.

## Production Promotion Gates (Not Authorized In This Batch)

-   [ ] Owner authorizes deployment and a report observation window.
-   [ ] Deploy `compat` enforcement plus `no-eval` report-only.
-   [ ] Verify CSP report volume, log redaction, authenticated product flows, lazy code rendering, and browser console.
-   [ ] Promote one mode at a time with an explicit rollback checkpoint.
-   [ ] Never promote `strict` until the style injection strategy is implemented and verified.
