---
title: AGENTS.md
purpose: Codex guidance for this Flowise fork/localization repo
scope: whole repository
---

# AGENTS.md

## Startup Context

-   Before Docker, deploy, auth, security, provider-node, or production-smoke work, read `docs/audits/flowise-production-adversarial-audit-20260710.md`.
-   Before changing DeepSeek or Kimi nodes, read `docs/ops/flowise-provider-nodes-maintenance-20260710.md`; the root provider guides are historical snapshots.
-   Before changing CSP, iframe embedding, security-header ownership, or report-only rollout, read `docs/ops/flowise-security-headers-csp-20260710.md`.
-   Before non-trivial remediation or release work, read `.kiro/plan/task_plan.md` and `.kiro/plan/progress.md`; update them when a batch completes, fails, or changes direction.
-   Treat local code inspection, local build, container health, login/session proof, provider calls, deploy, and production writes as separate evidence layers.
-   Do not call Deepseek, Kimi, OpenAI, or other external providers without explicit owner authorization.
-   Do not read or print secret values from `.env`, `.env.production`, Docker env, or server files. Env key names may be inspected when needed.
-   This repo may have a dirty worktree. Check `git status --short --branch` before writes and do not overwrite unrelated user changes.

## Current Production Boundary

-   The production app is `https://flowise.lute-tlz-dddd.top/`.
-   July 12 read-only L3 verification confirmed HTTPS `/api/v1/ping` returns `pong`, the public app port `3000` is refused, and the container publishes only `172.20.0.1:3000` for the private proxy path.
-   Production still runs the July 10 `linux/amd64` image `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9`. Tasks 4-6 are reviewed local source/config commits and were not deployed by the July 12 Stage 0 work.
-   Preserve `production_write=false`, `provider_call=false`, and `secrets_read=false` wording when reporting read-only audit work.
