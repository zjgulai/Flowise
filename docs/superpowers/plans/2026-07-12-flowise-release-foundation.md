---
title: Flowise release foundation implementation plan
date: 2026-07-12
status: in_progress
scope: local release provenance and atomic source history only
production_write: false
provider_call: false
secrets_read: false
---

# Flowise Release Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current Flowise 3.1.3 dirty working-tree snapshot into a traceable, immutable release artifact contract without deploying it or calling an external provider.

**Architecture:** Preserve the existing work on `codex/flowise-release-foundation-20260712`, classify it into independently reviewable commits, then add a dependency-free Node release-manifest tool and CI/Docker provenance gates. Production state remains observational evidence only; a future deploy must consume an immutable image reference and the generated manifest.

**Tech Stack:** Git, Node.js `24.18.0`, pnpm `10.26.0`, Bash, Docker/BuildKit, Docker Compose, GitHub Actions, Node built-in `node:test`.

## Global Constraints

-   Work only in `/Users/pray/project/FlowAgentic/flowise` on branch `codex/flowise-release-foundation-20260712`.
-   Do not use a worktree because repository `AGENTS.md` requires the current branch unless the user explicitly requests a worktree.
-   Never run `git add .`, `git reset --hard`, `git clean`, broad checkout, or destructive cleanup.
-   Treat every pre-existing modified or untracked file as user-owned until its concern is classified.
-   Do not read or print `.env`, `.env.production`, PEM, key, token, credential, database, or customer-data values.
-   Keep `production_write=false`, `production unchanged`, `provider_call=false`, and `secrets_read=false` throughout this plan.
-   Do not SSH-write, deploy, restart containers, send mail, create production test data, or call DeepSeek, Kimi, OpenAI, or any other provider.
-   Do not add a package dependency; release tooling must use Node built-ins and existing shell tools.
-   Every Node/pnpm verification must fail fast unless `node --version` is exactly `v24.18.0` and `pnpm --version` is exactly `10.26.0`. The current Node 22/pnpm 11 shell is not release evidence.
-   Keep `.kiro/plan/findings.md` as the current-fact source, `.kiro/plan/task_plan.md` as execution state, and `.kiro/plan/progress.md` as append-only evidence history.
-   Historical root reports are not release inputs. `ADAPTATION_REPORT.md` remains unstaged until a separate redaction task.
-   A stable manifest may be generated only from a clean checkout of the committed branch. The current local checkout may retain classified historical/non-release files; any local manifest produced before isolation must use `--allow-dirty` and remain explicitly non-stable.
-   Stage 0 proves source/toolchain/artifact traceability, not bit-for-bit image rebuilds: Alpine package repositories and build timestamps remain outside the pinned input set and must not be described as fully reproducible.
-   Tests run against the full working tree unless the report explicitly says the staged commit was tested in isolation.

---

### Task 1: Establish The Release Source Boundary And Atomic Inventory

**Files:**

-   Create: `drafts/analysis/flowise-release-atomic-commit-plan-draft-20260712.md`
-   Create: `scripts/verify-release-source.sh`
-   Modify: `.gitignore`
-   Modify: `.dockerignore`
-   Stage: `docs/superpowers/plans/2026-07-12-flowise-release-foundation.md`

**Interfaces:**

-   Consumes: current `git status`, `git diff --name-status`, and `git ls-files --others --exclude-standard`.
-   Produces: an exact path inventory used by Tasks 2-5 and a reusable source-boundary gate used by CI in Task 6.

-   [x] **Step 1: Install and activate the exact local verification toolchain**

Use the existing nvm installation to install Node `24.18.0`, then activate pnpm `10.26.0` through Corepack. This is a local environment action, not a repository dependency change.

Run:

```bash
node --version
pnpm --version
```

Expected exactly: `v24.18.0` and `10.26.0`. Stop if either differs.

-   [x] **Step 2: Write the failing source-boundary gate**

Create `scripts/verify-release-source.sh` with checks that fail unless Git and Docker ignore `.codegraph/`, `.playwright-cli/`, `output/`, `test_reports/`, `.superpowers/`, and `tmp/`; fail if a tracked path matches a private-key extension or a non-example/non-template env file; and verify `.env.production.template` remains eligible for explicit staging. The script must print paths only, never file contents.

-   [x] **Step 3: Run the gate and verify RED**

Run:

```bash
bash scripts/verify-release-source.sh
```

Expected: non-zero with missing generated-artifact ignore rules; no secret values printed.

-   [x] **Step 4: Add minimal ignore rules**

Add exact generated-artifact rules to `.gitignore` and `.dockerignore`. Add a generic private env rule to `.gitignore` with explicit allow-list entries for `*.example` and the reviewed root `.env.production.template`. Do not ignore formal `docs/`, `.kiro/`, or `drafts/analysis/` sources.

-   [x] **Step 5: Run the gate and verify GREEN**

Run:

```bash
bash scripts/verify-release-source.sh
git check-ignore -v .codegraph/codegraph.db .playwright-cli output test_reports ai_video.pem
template_ignore_status=0
git check-ignore .env.production.template || template_ignore_status=$?
test "$template_ignore_status" -eq 1
```

Expected: source gate exits `0`; generated paths and ignored PEM are reported; `.env.production.template` is not ignored.

-   [x] **Step 6: Write the exact atomic inventory**

Populate the draft with explicit path lists and these commit groups:

1. release source boundary and plan;
2. Chinese UI plus authentication-entry fixes;
3. Node 24 production build/runtime baseline;
4. DeepSeek/Kimi Provider 5A;
5. CSP/request security Batch 6B;
6. release provenance and CI;
7. current-state documentation.

Mark `packages/ui/index.html`, auth views, `packages/server/src/index.ts`, `packages/server/src/utils/XSS.ts`, `XSS.test.ts`, `docker-compose.prod.yml`, `.env.production.template`, `scripts/verify-security.sh`, and `pnpm-lock.yaml` as patch-staging candidates.

-   [x] **Step 7: Verify and commit Task 1**

Run:

```bash
git diff --check
git diff --cached --name-status
git diff --cached --check
```

Stage only the five Task 1 files by explicit path and commit:

```bash
git commit -m "chore(repo): define the release source boundary"
```

---

### Task 2: Capture The Chinese UI And Authentication Entry As Reviewed Sub-Units

**Files:**

-   Modify: exact UI/auth paths listed under Task 2 in `drafts/analysis/flowise-release-atomic-commit-plan-draft-20260712.md`
-   Test: `packages/ui/src/utils/genericHelper.test.js`
-   Test: `packages/ui/src/utils/xmlTagUtils.test.js`
-   Verify: authentication contracts in `scripts/verify-security.sh`

**Interfaces:**

-   Consumes: Task 1 exact inventory.
-   Produces: Chinese menus, forms, dialogs, canvas surfaces, responsive authentication pages, and controlled open-source registration behavior in independently reviewable commits.

-   [x] **Step 1: Review the candidate UI diff for executable-identifier translation and mixed concerns**

Search the candidate diff for translated API/property identifiers, fixed `480px` auth widths, Rewardful markers, and non-display string changes. Patch-stage security/bootstrap changes in `packages/ui/index.html` for Task 5 instead of this task.

-   [x] **Step 2: Repair executable-identifier, behavior, selector, and copy blockers before staging**

Before any Task 2 path is staged, restore executable identifiers such as `save邀请`, `show邀请Dialog`, `edit邀请`, and `btn_confirm邀请User` to their reviewed English contracts. Preserve the existing sign-in input `name`/selector contract instead of translating or repurposing it. Restore `toolAgentFlow.js` `systemMessage` behavior unless a later non-localization task explicitly owns that behavior change. Make the `permanently delete` instruction, placeholder, and validation contract consistent. Correct broken mixed copy such as `变量s`, `运行time`, `参数s`, `登录 With`, and mixed `and`/`do not match` fragments. Stop if the candidate diff still contains any executable-identifier translation, selector drift, behavior-prompt drift, or broken mixed-language copy.

-   [x] **Step 3: Stage, verify, and commit exactly one sub-unit at a time**

Use explicit paths for pure translation files and `git add -p` for mixed auth/index files. Process the five sub-units in this order: theme/chrome, shared UI utilities/components, core flow surfaces, management/data surfaces, and authentication entry. Do not stage `packages/ui/package.json`, `packages/ui/vite.config.js`, `pnpm-lock.yaml`, or `/global.js` in this task.

For each sub-unit, start with an empty index, stage only that sub-unit, run the covering verification under Node `24.18.0` and pnpm `10.26.0`, inspect `git diff --cached`, commit exactly one message from the ordered list below, then require an empty index before starting the next sub-unit:

```bash
test -z "$(git diff --cached --name-only)"
# Explicit git add paths and/or git add -p for one sub-unit only.
pnpm --filter flowise-ui test --runInBand
pnpm --filter flowise-ui build
bash scripts/verify-security.sh
git diff --cached --check
git diff --cached --name-status
# Commit the one verified sub-unit here.
test -z "$(git diff --cached --name-only)"
```

Expected: the covering UI tests/build and static authentication contracts pass for each staged unit. Report any existing Vite chunk warning separately. A test run against the full working tree is not isolated staged-commit proof and must be labeled accordingly.

-   [x] **Step 4: Complete the five ordered atomic commits and independent-review closure**

Use these messages one at a time in the Step 3 stage → verify → commit → empty-index loop: `feat(ui): localize the application chrome`, `feat(ui): localize shared interface components`, `feat(ui): localize core flow workflows`, `feat(ui): localize management and data surfaces`, and `fix(auth): localize and stabilize authentication entry`. Never stage all five groups before issuing the first commit, and never issue consecutive commit commands against one shared staged set. The independent review found residual visible mixed-language copy in three already-owned paths; close it in the narrow `fix(ui): complete localization review` commit, rerun the same gates, and require re-review approval. The six commits still touch exactly 162 unique Task 2 paths.

---

### Task 3: Capture The Node 24 Production Runtime Baseline

**Files:**

-   Modify: `.dockerignore`
-   Modify: `Dockerfile`
-   Modify: `packages/ui/package.json`
-   Modify: `packages/ui/vite.config.js`
-   Modify: `pnpm-lock.yaml`

**Interfaces:**

-   Consumes: current Node 24 build fixes and the Task 1 source boundary.
-   Produces: a reviewed Docker build context, the existing Node 24 multi-stage image/build baseline, clean-workspace dependency layout, direct non-root runtime entrypoint, and UI resolver/dependency compatibility fixes.

-   [x] **Step 1: Keep this commit limited to image/build inputs**

Keep Compose, env template, cross-cutting verification scripts, Provider configuration, CSP configuration, release-manifest/OCI labels, exact Node tag/digest, and exact repository toolchain changes for Task 6. Stage only the reviewed Docker context, current floating Node 24 multi-stage build, clean-workspace dependency layout, direct Node/Oclif runtime, dependency pins, and Vite resolver fix. This Task 3 commit is a build baseline, not immutable release provenance.

-   [x] **Step 2: Repair and prove the Docker build-context boundary**

Preserve the six Task 1 generated-artifact rules. Replace root-only env/key/log patterns with recursive rules for nested `.env*`, private-key extensions, SSH key names, macOS artifacts, logs, and `.turbo/`; remove duplicate patterns. Keep only root exclusions that are proven not to be build inputs, and keep `LICENSE.md` available if a root Markdown exclusion remains. Verify by path only that nested secret-like/log probes are ignored; do not read any candidate file contents.

-   [x] **Step 3: Review lockfile ownership**

Stage exactly three `pnpm-lock.yaml` importer hunks: the two `flowise-embed*` specifier pins and the UI `zod` importer. The already-resolved package/snapshot entries require no additional hunk. Leave the other 72 current lockfile hunks unstaged; they include libc/deprecation metadata and actual axios/debug, Prettier, and axe-core graph drift. Do not regenerate or hand-edit the generated lockfile. Verify the cached zero-context lock diff has exactly three hunks and corresponds to `packages/ui/package.json`.

-   [x] **Step 4: Close Dockerfile scope before staging**

Use exact `COPY pnpm-lock.yaml ./`. Remove unsupported image-size claims. Do not create `/usr/src/flowise/.flowise` until Task 6 aligns it with Compose volume, `HOME`, `DATABASE_PATH`, and `SECRETKEY_PATH`. Keep `.npmrc` available for the frozen builder install but ensure it does not enter the final runtime image. Leave the base-image digest and OCI labels to Task 6.

-   [ ] **Step 5: Verify the staged runtime baseline in isolation — non-Docker gates passed; Docker registry/network blocked**

Under Node `24.18.0` and pnpm `10.26.0`, start with an index containing exactly the five Task 3 paths. Materialize `HEAD` plus only the cached Task 3 patch in a temporary directory (not a Git worktree), then run:

```bash
pnpm install --frozen-lockfile
pnpm --filter flowise-ui test --runInBand
pnpm --filter flowise-ui build
pnpm build:docker
docker buildx build --check --platform linux/amd64 .
docker buildx build --platform linux/amd64 --target builder .
git diff --cached --check
```

Hash `pnpm-lock.yaml` before and after the frozen install and require equality. If disk headroom remains safe, build/load a uniquely tagged local final image and verify under `--network none` that runtime Node is `v24.18.0`, UID is non-root, the direct server entrypoint exists, and `/usr/src/flowise/.npmrc` is absent. Run `scripts/verify-security.sh` separately as full-dirty-worktree auxiliary evidence only. Do not push or deploy. Compose/env/provenance assertions remain owned by Task 6.

-   [x] **Step 6: Commit Task 3 and close review findings**

```bash
git commit -m "build(docker): establish the Node 24 production runtime"
```

The implementation commit is `51e802e`; independent review required the follow-up `e6d2587` source-boundary fix for standard RSA/DSA/ECDSA/Ed25519 key names, then approved the code range. Docker build/runtime smoke remains unverified because both configured builders failed before Dockerfile evaluation at registry metadata/DNS connectivity.

---

### Task 4: Capture Provider 5A Without A Live Provider Call

**Files:**

-   Modify: `packages/components/models.json`
-   Modify: `packages/components/src/httpSecurity.ts`
-   Modify: `packages/components/src/httpSecurity.test.ts`
-   Modify: `packages/components/nodes/chatmodels/Deepseek/Deepseek.ts`
-   Create: `packages/components/credentials/KimiApi.credential.ts`
-   Create: `packages/components/nodes/chatmodels/ChatKimi/ChatKimi.ts`
-   Create: `packages/components/nodes/chatmodels/ChatKimi/ChatKimi.test.ts`
-   Create: `packages/components/nodes/chatmodels/ChatKimi/kimi.svg`
-   Create: `packages/components/nodes/chatmodels/Deepseek/Deepseek.test.ts`
-   Create: `packages/components/nodes/chatmodels/ProviderCatalog.test.ts`
-   Create: `packages/components/nodes/chatmodels/providerUtils.ts`
-   Create: `packages/components/nodes/chatmodels/providerUtils.test.ts`
-   Create: `docs/ops/flowise-provider-nodes-maintenance-20260710.md`

**Interfaces:**

-   Consumes: existing HTTP/header security helpers and credentials schema.
-   Produces: required credentials, per-hop HTTPS/official-origin enforcement, credential-header isolation, default SSRF protection, deterministic timeout/retry behavior, and only the DeepSeek/Kimi model capabilities that the current transport can safely support.

-   [x] **Step 1: Write failing transport and Provider contract tests**

Add offline RED tests for HTTPS downgrade, cross-origin 301/302/303/307/308 redirects, credential/body forwarding, same-origin redirects, `100.64.0.0/10`, IPv6 unspecified `::`, Provider auth-header override in any casing, 429/500 single-attempt behavior, temperature/token bounds, and compiled node metadata. Tests must mock or use local fixtures only and must never call DeepSeek, Kimi, OpenAI, or a production endpoint.

-   [x] **Step 2: Implement minimal fail-closed transport policy**

Extend `secureFetch` with an optional per-request policy while preserving existing callers. Provider requests must revalidate every redirect before the next request, require HTTPS, remain on the configured Provider origin, and keep the default private/non-public address deny list even if the generic global check is disabled. Add CGNAT/metadata and IPv6-unspecified coverage. Provider Base Options must reject `Authorization`, `X-Api-Key`, and other credential-bearing headers case-insensitively. Keep SDK retries disabled so a 429/500 response is a single transport attempt.

-   [x] **Step 3: Fail closed on unsupported reasoning and ambiguous pricing**

Do not advertise thinking-only models or toggles until `reasoning_content` survives response and subsequent tool/agent request serialization. Existing saved configurations that request unsupported thinking must fail with an explicit local error; non-thinking Kimi K2.5/K2.6 and DeepSeek V4 requests must send the provider's explicit disabled form where supported. Use `max_completion_tokens` for Kimi K2 models rather than deprecated `max_tokens`. Remove new DeepSeek price fields instead of emitting values into the repository's unresolved mixed-unit cost paths; record that pricing normalization is deferred rather than returning a wrong cost. Bound DeepSeek temperature to the documented range.

-   [x] **Step 4: Stage only the expanded Provider concern**

Stage the 13 paths listed above, including the required Kimi SVG and shared HTTP security source/tests. Update the Provider maintenance document to describe the actual fail-closed redirect/thinking/pricing contract, but leave current production deployment-state synchronization for Task 7. Do not stage CSP, unrelated Docker, Compose/env, static-gate scripts, root provider guides, real credentials, or compiled output.

-   [x] **Step 5: Run Provider L2 gates**

Run:

```bash
pnpm --filter flowise-components exec jest nodes/chatmodels/providerUtils.test.ts nodes/chatmodels/Deepseek/Deepseek.test.ts nodes/chatmodels/ChatKimi/ChatKimi.test.ts nodes/chatmodels/ProviderCatalog.test.ts src/httpSecurity.test.ts src/headerValidation.test.ts --runInBand
pnpm --filter flowise-components exec eslint nodes/chatmodels/providerUtils.ts nodes/chatmodels/Deepseek/Deepseek.ts nodes/chatmodels/ChatKimi/ChatKimi.ts src/httpSecurity.ts --max-warnings 0
pnpm --filter flowise-components exec tsc --noEmit
pnpm --filter flowise-components build
bash scripts/verify-security.sh
git diff --cached --check
```

Run a compiled-load smoke that instantiates node metadata only; never call `init`, `invoke`, `stream`, or model-list Provider endpoints. Expected: offline/local tests, lint, typecheck, build, static gate, and compiled metadata smoke pass; `provider_call=false` and `secrets_read=false` remain true.

-   [x] **Step 6: Commit Task 4**

```bash
git commit -m "feat(provider): harden DeepSeek and add Kimi models"
```

---

### Task 5: Capture CSP And Request-Security Batch 6B

**Files:**

-   Modify: `packages/server/src/enterprise/middleware/passport/index.ts`
-   Create: `packages/server/src/enterprise/middleware/passport/authSecurityPolicy.ts`
-   Create: `packages/server/src/enterprise/middleware/passport/authSecurityPolicy.test.ts`
-   Modify: `packages/server/src/index.ts`
-   Modify: `packages/server/src/services/chatflows/index.test.ts`
-   Modify: `packages/server/src/utils/XSS.ts`
-   Modify: `packages/server/src/utils/XSS.test.ts`
-   Create: `packages/server/src/utils/csp.ts`
-   Create: `packages/server/src/utils/csp.test.ts`
-   Create: `packages/server/src/utils/cspReport.ts`
-   Create: `packages/server/src/utils/cspReport.test.ts`
-   Patch-stage: `packages/ui/index.html`
-   Patch-stage: `packages/ui/src/views/auth/register.jsx`
-   Create: `packages/ui/public/global.js`
-   Create: `docs/ops/flowise-security-headers-csp-20260710.md`
-   Create: `docs/superpowers/specs/2026-07-10-flowise-csp-iframe-governance-design.md`
-   Create: `docs/superpowers/plans/2026-07-10-flowise-csp-iframe-governance.md`

**Interfaces:**

-   Consumes: Task 3 runtime baseline and Task 2 UI shell.
-   Produces: controlled auth/cookie method boundaries, exact iframe-origin fail-fast, bounded trust-proxy parsing, structured CSP modes, one-line bounded sanitized report telemetry, and same-origin UI bootstrap.

-   [x] **Step 1: Write failing request-boundary and telemetry tests**

Add RED tests for production `SECURE_COOKIES=false`, GET/HEAD/POST auth-resolve behavior, hostname/percent-encoded iframe wildcards, non-finite/non-integer/negative `TRUST_PROXY`, actual one-line CSP log contents, Reporting API arrays above the envelope limit, and repeated missing-CORS access. Tests must prove the real production formatter-independent message contains only sanitized fields and that one request emits at most one bounded warning.

-   [x] **Step 2: Implement exact auth, iframe, proxy, and CORS boundaries**

Move the secure-cookie decision and auth-resolve POST-only middleware into the small tested `authSecurityPolicy` module. Production must always use secure cookies regardless of a false override; non-production keeps the explicit/local behavior. Reject every `IFRAME_ORIGINS` hostname containing a literal or percent-normalized wildcard. Parse numeric trust-proxy values only when finite, non-negative integers and keep the CSP report validator fail-closed. Emit the production missing-CORS warning during startup validation only, not once per request.

-   [x] **Step 3: Bound and serialize CSP report telemetry**

Limit Reporting API envelopes to at most ten sanitized reports and emit at most one logger call per accepted request. Put the sanitized directive/origin/disposition/status data in the actual bounded JSON message string so the existing Winston formatter preserves it; never include paths, queries, fragments, samples, credentials, or arbitrary fields. Preserve the body-size, media-type, parser-error, and per-IP request-rate limits.

-   [x] **Step 4: Stage only request/CSP/security code and docs**

Patch-stage `passport/index.ts` so the unsafe cookie override is replaced by the tested safe policy and only the auth boundary is otherwise changed. Patch-stage `packages/ui/index.html` to exclude Task 2 metadata but include third-party cleanup and `/global.js`; include the exact `register.jsx` `data-rewardful` removal. Keep release-provenance additions for Task 6 out. Update the CSP spec/plan/ops contract to the actual wildcard/proxy/envelope/log behavior without claiming production deployment.

-   [x] **Step 5: Run CSP/request gates**

Run:

```bash
pnpm --filter flowise exec jest --runInBand src/utils/XSS.test.ts src/utils/csp.test.ts src/utils/cspReport.test.ts src/services/chatflows/index.test.ts src/enterprise/middleware/passport/authSecurityPolicy.test.ts
pnpm --filter flowise exec tsc --noEmit
pnpm --filter flowise exec eslint src/utils/XSS.ts src/utils/csp.ts src/utils/cspReport.ts src/index.ts src/enterprise/middleware/passport/authSecurityPolicy.ts src/enterprise/middleware/passport/index.ts --max-warnings 0
pnpm --filter flowise-ui test --runInBand
pnpm --filter flowise-ui build
bash scripts/verify-security.sh
git diff --cached --check
```

Expected: tests/build/static gates pass. Preserve `production unchanged`; do not enable production report-only or enforcement.

-   [x] **Step 6: Commit Task 5**

```bash
git commit -m "feat(security): add controlled CSP and request boundaries"
```

---

### Task 6: Implement The Immutable Release Provenance Contract With TDD

**Files:**

-   Modify: `package.json`
-   Modify: `.nvmrc`
-   Modify: `.npmrc`
-   Modify: `Dockerfile`
-   Create/Modify: `docker-compose.prod.yml`
-   Create/Modify: `.env.production.template`
-   Create/Modify: `scripts/verify-security.sh`
-   Create: `scripts/verify-production-edge.sh`
-   Create: `scripts/release-manifest.mjs`
-   Create: `scripts/release-manifest.test.mjs`
-   Modify: `.github/workflows/main.yml`
-   Modify: `.github/workflows/test_docker_build.yml`
-   Modify: `.github/workflows/publish-package.yml`
-   Modify: `.github/workflows/docker-image-ecr.yml`

**Interfaces:**

-   CLI generate: `node scripts/release-manifest.mjs generate --distribution offline_archive --image-tag <unique-tag> --image-config-digest <sha256:id> --archive <path> --platform linux/amd64 --out <path> [--allow-dirty]`.
-   CLI verify: `node scripts/release-manifest.mjs verify --manifest <path> --image-tag <unique-tag> --image-config-digest <sha256:id> --archive <path> [--require-clean]`.
-   Manifest v1: `schema_version`, `release_id`, `created_at`, `source`, `toolchain`, `inputs`, `image`, and `boundaries`; it contains key names/hashes only and never environment values.
-   Offline image identity: unique Git-derived tag, Docker image config digest, compressed archive SHA-256, archive byte count, and target platform are separate required fields. None may be described as a registry RepoDigest.
-   Docker image: OCI `source`, `revision`, `version`, and `created` labels injected by explicit build args.

-   [x] **Step 1: Write failing release-manifest unit tests**

Using `node:test`, cover canonical JSON, 40-character Git revision validation, rejection of `latest` and non-unique tags, rejection of unauthorized dirty state, clean/dirty source-invariant exclusivity, patch-hash mismatch, image-config/archive mismatch, toolchain mismatch, and absence of env values from the manifest. Add a credential-bearing Git remote fixture and require repository URL normalization to reject or remove username/password, query, and fragment data. Add an env-template fixture whose value side contains a unique sentinel; require key-only sorted hashing and assert the sentinel is absent from both manifest output and logs.

-   [x] **Step 2: Run tests and verify RED**

```bash
node --test scripts/release-manifest.test.mjs
```

Expected: failure because the release-manifest module/API does not exist.

-   [x] **Step 3: Implement the minimal generator/verifier**

Use only `node:crypto`, `node:fs`, `node:path`, `node:child_process`, and `node:url`. Clean releases require `tracked_patch=null` and `untracked=[]`; dirty releases require the inverse representation with an explicit patch hash and only explicitly allow-listed untracked release-input hashes. Never recursively read arbitrary untracked files, and reject secret-like paths before any file read. `--allow-dirty` must produce a `dirty-<shortsha>-<patch12>` release id and must never emit a stable/latest image reference.

-   [x] **Step 4: Add failing static release-contract checks**

Extend `scripts/verify-security.sh` to require exact Node `24.18.0`, pnpm `10.26.0`, `packageManager`, `engine-strict=true`, a digest-pinned Node base, OCI labels, an explicit unique non-latest Compose image, and the release generator/test scripts. Run the gate before config edits and confirm these new checks fail.

-   [x] **Step 5: Implement exact toolchain, Docker, Compose, and CI config**

Pin `.nvmrc`, `packageManager`, pnpm engine, and the Node base image to the reviewed `24.18.0` Alpine tag plus registry index digest. Production Compose must have no build fallback and must require a Git-derived `FLOWISE_IMAGE`; env preflight must reject `latest` and non-unique tags. Make `POSTGRES_IMAGE` explicit without claiming a database upgrade or conflating its identity with the Flowise app release. CI must use frozen install, run release tests/static gates, inject OCI args, and build from the repository root Dockerfile without pushing. Align every workflow that performs a root install with Node `24.18.0`; keep the upstream DockerHub `docker/Dockerfile` lane explicitly outside this fork-release contract.

-   [!] **Step 6: Run GREEN verification — source/config GREEN; Docker registry metadata externally blocked**

```bash
node --test scripts/release-manifest.test.mjs
bash scripts/verify-release-source.sh
bash scripts/verify-security.sh
pnpm install --frozen-lockfile
docker compose --env-file .env.production.template -f docker-compose.prod.yml config --quiet
git diff --cached --check
```

Then build a local `linux/amd64` candidate with explicit OCI args and a unique dirty tag, inspect labels/runtime Node, stream `docker save` through deterministic gzip settings to a local archive, and record the image config digest, archive SHA-256, archive byte count, and platform in an explicitly dirty/non-stable manifest. Verify every field against the local image/archive. The stable-manifest path is verified in a synthetic clean Git fixture and later in CI from a clean checkout. Do not push or deploy the image.

Source/config verification completed at commit `699b59b1c08413e0785a9732c2dfe4c020b4a331`: release tests `18/18`, static security gate `95/95`, source gate, Compose render, and clean-clone frozen install passed. The single Docker attempt stopped before Dockerfile evaluation while resolving the pinned base-image registry index, so no candidate image, archive, or actual manifest exists:

```text
docker_build_verified=false
builder_image_verified=false
final_image_loaded=false
runtime_smoke_verified=false
actual_archive_manifest_verified=false
production unchanged
```

-   [x] **Step 7: Commit Task 6**

```bash
git commit -m "chore(release): add immutable build provenance"
```

---

### Task 7: Synchronize Current State And Close Stage 0

**Files:**

-   Modify: `docs/superpowers/plans/2026-07-12-flowise-release-foundation.md`
-   Modify: `AGENTS.md`
-   Modify: `.kiro/plan/findings.md`
-   Modify: `.kiro/plan/task_plan.md`
-   Modify: `.kiro/plan/progress.md`
-   Modify: `docs/audits/flowise-production-adversarial-audit-20260710.md`
-   Modify: `docs/ops/flowise-production-hardening-runbook-20260710.md`
-   Modify: `docs/ops/flowise-provider-nodes-maintenance-20260710.md`
-   Modify: `docs/ops/flowise-security-headers-csp-20260710.md`

**Interfaces:**

-   Consumes: reviewed commits and fresh local/production evidence.
-   Produces: one current-fact entry, one task-status entry, append-only evidence history, and operation contracts without duplicate current-status documents.

-   [x] **Step 1: Update only verified current facts**

Record the current branch, exact HEAD/commit range, fresh dirty counts, production image fingerprint, current L3 observation date, Batch 5A/6B deployment state, release provenance result, and backup state `exists_not_checksum_or_restore_verified`. Preserve July 10 L4 evidence as historical authorized change.

Verified pre-Task-7 snapshot: branch `codex/flowise-release-foundation-20260712`, base `bb773ffa710bd22639c4ba2643413a0ea2b679d3`, source/config HEAD `699b59b1c08413e0785a9732c2dfe4c020b4a331`, 12 commits and 212 changed paths. Before Task 7 edits the worktree had 2 unstaged tracked paths, 32 untracked files, and an empty index. Public L3 was observed at `2026-07-12T10:48:40Z`; SSH L3 was observed at `2026-07-12T10:51:01Z`. Task 4/5/6 were not deployed by this plan.

-   [x] **Step 2: Correct stale routing statements**

Update `AGENTS.md` so public `3000` is described as closed and reverified on July 12. Fix the erroneous historical full Git SHA. Do not copy volatile production metrics into README or create `CURRENT_STATUS.md`.

-   [x] **Step 3: Keep historical root reports out of the release**

Leave `ADAPTATION_REPORT.md`, `AUDIT_REPORT.md`, `FINAL_*`, legacy deployment/test plans, and other root snapshots unstaged. Record their `historical_sensitive`, `historical_snapshot`, or `deferred` classification in the atomic inventory only. Do not print or propagate credential-like examples.

-   [x] **Step 4: Verify docs and commit Task 7**

```bash
set -euo pipefail
task7_files=(
  docs/superpowers/plans/2026-07-12-flowise-release-foundation.md
  AGENTS.md
  .kiro/plan/findings.md
  .kiro/plan/task_plan.md
  .kiro/plan/progress.md
  docs/audits/flowise-production-adversarial-audit-20260710.md
  docs/ops/flowise-production-hardening-runbook-20260710.md
  docs/ops/flowise-provider-nodes-maintenance-20260710.md
  docs/ops/flowise-security-headers-csp-20260710.md
)
diff -u \
  <(printf '%s\n' "${task7_files[@]}" | LC_ALL=C sort) \
  <(git diff --cached --name-only | LC_ALL=C sort)
test "$(git diff --cached --name-only | wc -l | tr -d ' ')" = 9
if git diff --cached --name-only | rg -n \
  '(^pnpm-lock\.yaml$|^ADAPTATION_REPORT\.md$|^AUDIT_REPORT\.md$|^FINAL_|^docker/Dockerfile\.|^env\.chinese\.template$|\.baiduyun\.uploading\.cfg$)'; then
  exit 1
fi
if rg -n "current branch.*main|Compose image contract.*flowise-chinese:latest|ARG NODE_VERSION=24-alpine" \
  AGENTS.md .kiro/plan/findings.md .kiro/plan/task_plan.md docs/ops; then
  exit 1
fi
rg -n -C 3 "171 (个 )?tracked|27 (个 )?untracked|main\.\.\.origin/main|0\.0\.0\.0:3000|Node 20" \
  .kiro/plan/progress.md .kiro/plan/findings.md docs/audits/flowise-production-adversarial-audit-20260710.md
git diff --check
git diff --cached --check
```

Expected: the first search has no matches; every second-search match is inside an explicitly dated historical or append-only evidence section. The verified base SHA is `bb773ffa710bd22639c4ba2643413a0ea2b679d3`.

Commit:

```bash
git commit -m "docs(ops): align release and production evidence"
```

---

### Task 8: Final Whole-Branch Verification And Review

**Files:**

-   Verify only; no planned source additions.

**Interfaces:**

-   Consumes: Tasks 1-7 commits.
-   Produces: review-ready branch evidence; no merge, push, PR, or deploy.

-   [ ] **Step 1: Verify repository and staged state**

```bash
git status --short --branch
git diff --cached --name-status
git log --oneline --decorate --stat bb773ffa710bd22639c4ba2643413a0ea2b679d3..HEAD
bash scripts/verify-release-source.sh
bash scripts/verify-security.sh
node --test scripts/release-manifest.test.mjs
git diff --check
```

-   [ ] **Step 2: Run full relevant local gates under the pinned toolchain**

```bash
pnpm install --frozen-lockfile
pnpm --filter flowise-components test --runInBand
pnpm --filter flowise exec jest --runInBand
pnpm --filter flowise-ui test --runInBand
pnpm build:docker
```

Run a local `linux/amd64` image/manifest smoke if disk space remains safe. Never delete volumes or unrelated images to create space.

-   [ ] **Step 3: Run final whole-branch code review**

Review the complete branch against this plan. Fix all Critical/Important findings, rerun covering tests, and re-review.

-   [ ] **Step 4: Hand off without external side effects**

Report commit list, verification evidence, remaining ignored/historical files, and next authorization boundary. Do not merge, push, create a PR, deploy, restart, or call a Provider.
