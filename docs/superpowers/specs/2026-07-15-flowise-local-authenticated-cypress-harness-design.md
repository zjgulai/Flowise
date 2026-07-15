---
title: Flowise local authenticated Cypress harness design
date: 2026-07-15
status: implemented_local_l2
scope: isolated local owner login plus API key and variable browser CRUD
evidence_ceiling: L2 local authenticated browser acceptance
production_write: false
provider_call: false
smtp_send: false
secrets_read: false
---

# Flowise Local Authenticated Cypress Harness Design

**Date:** 2026-07-15
**Status:** implemented and locally verified
**Batch:** E0 phase 1
**Evidence ceiling:** L2 local authenticated browser acceptance
**Boundary:** `local_only`, `database_write=local-test-only`, `provider_call=false`, `smtp_send=false`, `production_write=false`, `secrets_read=false`

## 1. Problem Statement

The repository has Cypress specifications for API keys and variables, but both suites are entirely commented out because no authenticated test setup exists. The Cypress support layer is still the generated placeholder, and the current local `e2e` command can start Flowise against the developer's normal database path. Enabling the old suites as-is would therefore either fail at sign-in or risk changing a developer-owned database.

This batch must restore a deterministic authenticated browser path without using an existing account, reading `.env`, connecting to production, or invoking providers.

## 2. Decision

Use a fail-closed local runner with a fresh SQLite database and a synthetic Open Source owner for every run:

1. A Node runner creates a unique operating-system temporary directory and selects an unused loopback port.
2. It starts the source server with SQLite, authentication files, and application URL scoped to that directory and port.
3. Cypress generates a run-scoped synthetic identity, registers it through the public Open Source account endpoint, and logs in through the real authentication endpoint.
4. Cypress preserves the authenticated browser state with `cy.session` and drives the actual API-key and variable pages through the UI.
5. The runner stops the server and deletes the temporary directory on success, test failure, signal, or startup failure.

The runner is the supported entry point for these authenticated specifications. Direct execution without the isolation marker fails before product data is changed.

Rejected alternatives:

-   **UI registration and login before every test:** exercises more pixels but duplicates setup, slows the suite, and makes CRUD failures harder to diagnose.
-   **Reuse an existing local account or database:** creates credential-handling and data-contamination risk and cannot satisfy the local-only evidence boundary.

## 3. Components

### 3.1 Isolated runner

Add a repository-tracked Node script under `packages/server/cypress/scripts/` and expose it as the server package's authenticated E2E command. It uses only Node built-ins and existing package commands.

The runner must:

-   create its state with `fs.mkdtemp` under `os.tmpdir()`;
-   allocate a loopback-only port and set `APP_URL` to the matching `http://127.0.0.1:<port>` origin;
-   set `DATABASE_TYPE=sqlite`, `DATABASE_PATH`, and `SECRETKEY_PATH` to the temporary directory;
-   set an explicit isolation marker consumed by Cypress;
-   start Flowise through the repository's `pnpm oclif-dev` source CLI, wait for `/api/v1/ping`, and enforce a bounded startup timeout;
-   run only the authenticated E0 specifications unless the caller supplies a narrower Cypress specification filter;
-   forward test exit status without printing the synthetic password or generated authentication material;
-   terminate the child process tree and remove the temporary directory in a single idempotent cleanup path.

Port allocation has a small bind-release race. If startup reports an occupied port, the run fails visibly; it does not silently fall back to port 3000 or an existing service.

### 3.2 Cypress configuration and authentication commands

`packages/server/cypress.config.ts` owns run-scoped test metadata and the base URL. The synthetic email uses the reserved `.invalid` domain, and the generated password exists only in the Cypress process environment for the life of the isolated run.

The support layer adds two commands:

-   `ensureLocalOwner`: checks `/api/v1/auth/resolve`; it registers the synthetic owner only when the isolated database has no organization. Any other redirect or registration response fails the test.
-   `loginAsLocalOwner`: uses `cy.session` to call `/api/v1/auth/login` and validates the session by reading the synthetic user through the authenticated `/api/v1/user` endpoint.

The commands must reject execution when the isolation marker is absent. They do not accept external usernames or passwords and do not read `.env`.

### 3.3 API-key and variable specifications

Restore the two existing suites as independent, restartable CRUD scenarios. Every created name includes the run identifier, and each suite deletes the object it creates.

The API-key scenario verifies:

-   authenticated navigation to `/apikey`;
-   empty initial state in the isolated database;
-   create with an explicit non-admin permission;
-   row visibility without revealing or copying the generated key;
-   rename through the edit dialog;
-   delete and return to the empty state.

The variable scenario verifies:

-   authenticated navigation to `/variables`;
-   empty initial state;
-   create a synthetic static variable;
-   row visibility;
-   rename and replace its synthetic value;
-   delete and return to the empty state.

Selectors prefer existing stable element IDs and accessible titles. Table-row assertions locate the run-scoped name rather than relying on row position or seed counts.

## 4. Data Flow

The only write path is:

`temporary SQLite -> synthetic owner/org/workspace -> synthetic API key or variable -> UI cleanup -> temporary directory deletion`

No production hostname, production database, existing local account, provider node, SMTP server, API-key reveal control, clipboard, or external service is part of the flow.

The owner account is not deleted through product APIs because deleting the isolated database is the stronger and simpler cleanup boundary.

## 5. Failure Handling

-   A missing isolation marker, unexpected existing organization, non-loopback base URL, or failed session validation aborts the suite before CRUD actions.
-   Startup and ping waits are time-bounded, are cancelled when a competing server/signal outcome wins, and include available server exit metadata in the failure report.
-   Cypress failures preserve the nonzero exit code while cleanup still runs.
-   Cleanup tolerates an already-exited server or already-removed directory and never targets a path that was not created by the current runner.
-   Any child-process or temporary-directory cleanup failure forces a nonzero final exit and cannot emit `cleanup ... status=complete`.
-   Secrets and synthetic passwords are not printed. Failure diagnostics use only an allowlisted reason plus run ID, phase, exit code, and sanitized signal metadata.

## 6. Test Strategy

Implementation follows a red-to-green sequence:

1. Record the current failure/absence baseline: the authenticated specifications contain no runnable tests.
2. Add focused tests for runner guards and cleanup decisions where they can run without starting Flowise.
3. Add authentication commands and restore one API-key scenario.
4. Run that scenario against the isolated source server until green.
5. Restore and run the variable scenario.
6. Run both specifications together to prove shared registration/session behavior and independent CRUD cleanup.
7. Run focused type/lint checks and `git diff --check`.

Browser acceptance is L2 because all state is synthetic and local. A green local run does not prove production authentication, production permissions, deployment correctness, provider execution, or SMTP delivery.

## 7. Scope Boundaries

Included in E0 phase 1:

-   isolated local server lifecycle;
-   synthetic Open Source owner registration and login;
-   API-key UI CRUD without key reveal or clipboard interaction;
-   variable UI CRUD;
-   local L2 evidence and project-state synchronization.

Excluded and separately authorized later:

-   production deployment or production browser login;
-   production database or account writes;
-   member/RBAC scenarios;
-   chatflow, Agentflow, document-store, or credential CRUD;
-   provider selection that causes an external request;
-   SMTP, password reset delivery, invitations, or verification email;
-   Git commit, push, merge, or CI-run claims.

## 8. Acceptance Criteria

-   One documented command creates an isolated test server, runs both authenticated specifications, and always cleans its temporary state.
-   Running the authenticated commands without the isolation marker or against a non-loopback origin fails closed before registration.
-   No existing account, `.env`, developer SQLite database, production service, provider, or SMTP service is accessed.
-   API-key and variable create, read, update, and delete paths pass through the browser UI.
-   Created records use run-scoped names and both pages return to their isolated empty states.
-   The generated API key is never revealed, copied, logged, or used for an API request.
-   Focused automated checks and `git diff --check` pass.
-   Final reporting uses `local_only`, `database_write=local-test-only`, `provider_call=false`, `smtp_send=false`, and `production_write=false` literally.
