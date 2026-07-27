---
title: Flowise local authenticated Cypress harness implementation plan
date: 2026-07-15
status: completed_local_l2
scope: isolated local owner login plus API key and variable browser CRUD
production_write: false
provider_call: false
smtp_send: false
secrets_read: false
---

# Flowise Local Authenticated Cypress Harness Implementation Plan

**Goal:** Restore runnable authenticated Cypress coverage for API-key and variable CRUD using a fresh local SQLite database on every run.

**Architecture:** A dependency-free Node runner owns a temporary database, authentication directory, loopback port, source-server child process, Cypress child process, and cleanup. Cypress creates one ephemeral Open Source owner through public account APIs, stores the returned login state in the browser session, and drives CRUD through existing UI selectors.

**Evidence ceiling:** L2 local authenticated browser acceptance. `local_only`, `database_write=local-test-only`, `provider_call=false`, `smtp_send=false`, `production_write=false`.

## Task 1: Establish runner RED tests

**Files:**

-   Create: `packages/server/cypress/scripts/local-authenticated-e2e.mjs`
-   Create: `packages/server/cypress/scripts/local-authenticated-e2e.test.mjs`

-   [x] Write tests for loopback URL enforcement, owned temporary-path enforcement, runner argument parsing, bounded process-result handling, cleanup failure propagation, and sanitized diagnostics.
-   [x] Run `node --test cypress/scripts/local-authenticated-e2e.test.mjs` and record the expected RED result before implementation.
-   [x] Implement only the pure helpers needed to turn the focused tests green.

## Task 2: Implement isolated server and Cypress lifecycle

**Files:**

-   Modify: `packages/server/cypress/scripts/local-authenticated-e2e.mjs`
-   Modify: `packages/server/package.json`

-   [x] Create a run ID, OS temporary directory, and unused loopback port.
-   [x] Start `pnpm oclif-dev` with isolated SQLite/auth paths and wait for `/api/v1/ping` with a timeout.
-   [x] Start Cypress with the explicit isolation marker, base URL, run ID, selected specs, and optional browser argument.
-   [x] Preserve Cypress exit status while terminating the server and deleting only the runner-owned temporary directory.
-   [x] Expose `pnpm e2e` as the isolated command and add the focused runner-test command without adding dependencies.

## Task 3: Restore authenticated Cypress support

**Files:**

-   Modify: `packages/server/cypress.config.ts`
-   Modify: `packages/server/cypress/support/commands.ts`
-   Inspect, no change required: `packages/server/cypress/support/e2e.ts`

-   [x] Fail closed unless the isolation marker is set and the base URL is loopback HTTP.
-   [x] Generate the synthetic `.invalid` owner identity inside the Cypress Node process and expose it through a non-logging task.
-   [x] Implement idempotent Open Source owner registration through `/api/v1/auth/resolve` and `/api/v1/account/register`.
-   [x] Implement `cy.session` login through `/api/v1/auth/login`, populate only the existing browser-auth localStorage contract, and validate through `/api/v1/user`.

## Task 4: Restore API-key UI CRUD

**Files:**

-   Modify: `packages/server/cypress/e2e/1-apikey/apikey.cy.js`

-   [x] Replace the commented legacy suite with one run-scoped scenario.
-   [x] Verify empty state, create with a visible non-admin permission, rename, delete, and return to empty state.
-   [x] Never reveal, copy, log, or use the generated API key.
-   [x] Run only this specification against the isolated runner until green.

## Task 5: Restore variable UI CRUD

**Files:**

-   Modify: `packages/server/cypress/e2e/2-variables/variables.cy.js`

-   [x] Replace the commented/skipped legacy suite with one run-scoped static-variable scenario.
-   [x] Verify empty state, create, rename/value replacement, delete, and return to empty state.
-   [x] Run only this specification against the isolated runner until green.

## Task 6: Close local L2 evidence and documentation

**Files:**

-   Modify if required for safe CI parity: `.github/workflows/main.yml`
-   Modify: `.kiro/plan/task_plan.md`
-   Modify: `.kiro/plan/findings.md`
-   Modify: `.kiro/plan/progress.md`

-   [x] Run the runner unit tests under Node `v24.18.0` and pnpm `10.26.0`.
-   [x] Install the local Cypress binary if absent, then run both specs together in Electron and Google Chrome.
-   [x] Run focused syntax/lint/format checks and `git diff --check` without formatting unrelated files.
-   [x] Confirm no runner-owned temporary directory or child process remains.
-   [x] Record exact L2 evidence and retain all production/provider/SMTP boundaries literally.
-   [x] Do not commit, push, merge, deploy, or claim CI execution without separate authorization/evidence.

## Completion Evidence

-   Runner contract tests: `12/12` passed under Node `v24.18.0` and pnpm `10.26.0`.
-   Electron `118`: API key and variable specs `2/2` passed through `pnpm e2e`.
-   Google Chrome `150` headless: API key and variable specs `2/2` passed through `pnpm cypress:ci`.
-   Direct Cypress execution without the isolation marker failed closed before test data creation.
-   A real server-spawn failure produced only the allowlisted `server-spawn-failed` reason, returned `1` immediately, cancelled the losing health-check timer, and completed owned cleanup; injected termination/removal failures force the final exit to nonzero and suppress the success cleanup label.
-   The CI workflow source now provides the same isolated SQLite/loopback contract; no external CI run was performed or claimed.
-   Final state: `local_only`, `database_write=local-test-only`, `provider_call=false`, `smtp_send=false`, `production_write=false`, `production unchanged`, `business_restore_proven=false`.
