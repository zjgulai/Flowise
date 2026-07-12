---
title: Flowise release atomic commit inventory
date: 2026-07-12
status: draft
snapshot_phase: before_task_1_staging
snapshot_head: bb773ffa710bd22639c4ba2643413a0ea2b679d3
production_write: false
provider_call: false
secrets_read: false
---

# Flowise Release Atomic Commit Inventory

## Snapshot and counting contract

This inventory describes the local source snapshot after the Task 1 source-boundary rules and gate were added, but before any Task 1 path was staged. Counts are path counts, not hunk counts. Ignored directory counts are the collapsed entries printed by Git, not recursive file counts.

| Fact                               | Snapshot value                              |
| ---------------------------------- | ------------------------------------------- |
| Branch                             | `codex/flowise-release-foundation-20260712` |
| HEAD                               | `bb773ffa710bd22639c4ba2643413a0ea2b679d3`  |
| Tracked working-tree modifications | 175 paths, all status `M`                   |
| Eligible untracked source paths    | 50 paths, including this inventory          |
| Ignored status entries             | 27 collapsed paths                          |
| Staged paths                       | 0                                           |

The snapshot was acquired with these commands:

```bash
git branch --show-current
git rev-parse HEAD
git status --short --branch
git diff --name-status
git ls-files --others --exclude-standard
git diff --name-only | wc -l
git ls-files --others --exclude-standard | wc -l
git status --short --ignored
git status --short --ignored | awk '$1 == "!!" { count += 1 } END { print count }'
git diff --cached --name-status
```

Coverage arithmetic:

-   Tracked: Task 1 `2` + UI/auth `161` + Node 24 `4` + Provider 5A `2` + CSP/request security `6` = `175`.
-   Eligible untracked: Task 1 `3` + Provider 5A `9` + CSP/request security `8` + release provenance `4` + current-state documentation `10` + historical/deferred `16` = `50`.
-   Ignored: generated/private collapsed entries = `27`.

## 1. Release source boundary and plan

-   [M, Task 1 owns only the six exact generated-artifact boundaries] `.dockerignore`
-   [M] `.gitignore`
-   [untracked] `drafts/analysis/flowise-release-atomic-commit-plan-draft-20260712.md`
-   [untracked] `scripts/verify-release-source.sh`
-   [untracked] `docs/superpowers/plans/2026-07-12-flowise-release-foundation.md`

Commit: `chore(repo): define the release source boundary`.

Task 1 preserves the base `.dockerignore` entries and owns only these additions: `.codegraph/`, `.playwright-cli/`, `output/`, `test_reports/`, `.superpowers/`, and `tmp/`. The pre-existing broad build-context diff is not part of Task 1. After the Task 1 amend it is replayed exactly into the working tree, remains unstaged, and is assigned to Task 3 for independent review/classification. The replayed diff includes the pre-existing key/env/OS/log/Markdown/assets/images/metrics/i18n/tooling exclusions and the pre-existing removal/reordering of base build/env entries; Task 3 must review the actual `.dockerignore` patch before accepting any of it.

## 2. Chinese UI plus authentication-entry fixes

The snapshot contains 161 tracked modifications under `packages/ui/src/`, plus Chinese metadata hunks in the shared patch-stage path `packages/ui/index.html`. Task 2 must split them into independently reviewable theme/chrome, shared component, core-flow, management/data, and authentication-entry commits. For unique snapshot arithmetic, `packages/ui/index.html` is counted once in group 5.

### Theme and application chrome

-   [M, patch-stage, shared with group 5] `packages/ui/index.html`
-   [M] `packages/ui/src/assets/scss/_themes-vars.module.scss`
-   [M] `packages/ui/src/config.js`
-   [M] `packages/ui/src/layout/MainLayout/Header/ProfileSection/index.jsx`
-   [M] `packages/ui/src/layout/MainLayout/ViewHeader.jsx`
-   [M] `packages/ui/src/menu-items/agentsettings.js`
-   [M] `packages/ui/src/menu-items/customassistant.js`
-   [M] `packages/ui/src/menu-items/dashboard.js`
-   [M] `packages/ui/src/menu-items/settings.js`

### Shared UI components and utilities

-   [M] `packages/ui/src/ui-component/array/ArrayRenderer.jsx`
-   [M] `packages/ui/src/ui-component/button/ThumbsDownButton.jsx`
-   [M] `packages/ui/src/ui-component/button/ThumbsUpButton.jsx`
-   [M] `packages/ui/src/ui-component/cards/MCPItemCard.jsx`
-   [M] `packages/ui/src/ui-component/dialog/AgentflowGeneratorDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ChatFeedbackContentDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ChatflowConfigurationDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ConditionDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ExportAsTemplateDialog.jsx`
-   [M, patch-stage] `packages/ui/src/ui-component/dialog/InviteUsersDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ManageScrapedLinksDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/NodeInfoDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/NvidiaNIMDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/PromptLangsmithHubDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/SaveChatflowDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ShareWithWorkspaceDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/TagDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ViewLeadsDialog.jsx`
-   [M] `packages/ui/src/ui-component/dialog/ViewMessagesDialog.jsx`
-   [M] `packages/ui/src/ui-component/extended/AllowedDomains.jsx`
-   [M] `packages/ui/src/ui-component/extended/AnalyseFlow.jsx`
-   [M] `packages/ui/src/ui-component/extended/FollowUpPrompts.jsx`
-   [M] `packages/ui/src/ui-component/extended/Leads.jsx`
-   [M] `packages/ui/src/ui-component/extended/McpServer.jsx`
-   [M] `packages/ui/src/ui-component/extended/OverrideConfig.jsx`
-   [M] `packages/ui/src/ui-component/extended/PostProcessing.jsx`
-   [M] `packages/ui/src/ui-component/extended/ScheduleStatusBadge.jsx`
-   [M] `packages/ui/src/ui-component/extended/SpeechToText.jsx`
-   [M] `packages/ui/src/ui-component/extended/TextToSpeech.jsx`
-   [M] `packages/ui/src/ui-component/grid/DataGrid.jsx`
-   [M] `packages/ui/src/ui-component/json/JsonEditor.jsx`
-   [M] `packages/ui/src/ui-component/markdown/CodeBlock.jsx`
-   [M] `packages/ui/src/ui-component/picker/WeekDaysPicker.jsx`
-   [M] `packages/ui/src/ui-component/table/DocumentStoreTable.jsx`
-   [M] `packages/ui/src/ui-component/table/ExecutionsListTable.jsx`
-   [M] `packages/ui/src/ui-component/table/MCPServersTable.jsx`
-   [M] `packages/ui/src/ui-component/table/MarketplaceTable.jsx`
-   [M] `packages/ui/src/ui-component/table/Table.jsx`
-   [M] `packages/ui/src/ui-component/table/ToolsListTable.jsx`
-   [M] `packages/ui/src/ui-component/toolbar/Toolbar.js`
-   [M] `packages/ui/src/utils/genericHelper.js`
-   [M] `packages/ui/src/utils/genericHelper.test.js`
-   [M] `packages/ui/src/utils/validation.js`
-   [M] `packages/ui/src/utils/xmlTagUtils.js`
-   [M] `packages/ui/src/utils/xmlTagUtils.test.js`

### Core flow and assistant surfaces

-   [M] `packages/ui/src/views/agentexecutions/ExecutionDetails.jsx`
-   [M] `packages/ui/src/views/agentexecutions/NodeExecutionDetails.jsx`
-   [M] `packages/ui/src/views/agentexecutions/ShareExecutionDialog.jsx`
-   [M] `packages/ui/src/views/agentexecutions/index.jsx`
-   [M] `packages/ui/src/views/agentflows/index.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/AgentFlowNode.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/Canvas.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/EditNodeDialog.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/IterationNode.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/MarketplaceCanvas.jsx`
-   [M] `packages/ui/src/views/agentflowsv2/StickyNote.jsx`
-   [M] `packages/ui/src/views/assistants/custom/AddCustomAssistantDialog.jsx`
-   [M] `packages/ui/src/views/assistants/custom/CustomAssistantConfigurePreview.jsx`
-   [M] `packages/ui/src/views/assistants/custom/CustomAssistantLayout.jsx`
-   [M, patch-stage] `packages/ui/src/views/assistants/custom/toolAgentFlow.js`
-   [M] `packages/ui/src/views/assistants/index.jsx`
-   [M] `packages/ui/src/views/assistants/openai/AssistantDialog.jsx`
-   [M] `packages/ui/src/views/assistants/openai/LoadAssistantDialog.jsx`
-   [M] `packages/ui/src/views/assistants/openai/OpenAIAssistantLayout.jsx`
-   [M] `packages/ui/src/views/canvas/AddNodes.jsx`
-   [M] `packages/ui/src/views/canvas/CanvasHeader.jsx`
-   [M] `packages/ui/src/views/canvas/CanvasNode.jsx`
-   [M] `packages/ui/src/views/canvas/CredentialInputHandler.jsx`
-   [M] `packages/ui/src/views/canvas/NodeInputHandler.jsx`
-   [M] `packages/ui/src/views/canvas/NodeOutputHandler.jsx`
-   [M] `packages/ui/src/views/canvas/StickyNote.jsx`
-   [M] `packages/ui/src/views/canvas/index.jsx`
-   [M] `packages/ui/src/views/chatflows/APICodeDialog.jsx`
-   [M] `packages/ui/src/views/chatflows/EmbedChat.jsx`
-   [M] `packages/ui/src/views/chatflows/ShareChatbot.jsx`
-   [M] `packages/ui/src/views/chatflows/index.jsx`
-   [M] `packages/ui/src/views/chatmessage/AgentExecutedDataCard.jsx`
-   [M] `packages/ui/src/views/chatmessage/AgentReasoningCard.jsx`
-   [M] `packages/ui/src/views/chatmessage/ChatMessage.jsx`
-   [M] `packages/ui/src/views/chatmessage/ChatPopUp.jsx`
-   [M] `packages/ui/src/views/chatmessage/ValidationPopUp.jsx`

### Management and data surfaces

-   [M, patch-stage] `packages/ui/src/views/account/index.jsx`
-   [M] `packages/ui/src/views/apikey/APIKeyDialog.jsx`
-   [M] `packages/ui/src/views/apikey/index.jsx`
-   [M] `packages/ui/src/views/credentials/AddEditCredentialDialog.jsx`
-   [M] `packages/ui/src/views/credentials/CredentialInputHandler.jsx`
-   [M] `packages/ui/src/views/credentials/CredentialListDialog.jsx`
-   [M] `packages/ui/src/views/credentials/index.jsx`
-   [M] `packages/ui/src/views/datasets/AddEditDatasetDialog.jsx`
-   [M] `packages/ui/src/views/datasets/DatasetItems.jsx`
-   [M] `packages/ui/src/views/datasets/index.jsx`
-   [M] `packages/ui/src/views/docstore/AddDocStoreDialog.jsx`
-   [M] `packages/ui/src/views/docstore/ComponentsListDialog.jsx`
-   [M] `packages/ui/src/views/docstore/DeleteDocStoreDialog.jsx`
-   [M] `packages/ui/src/views/docstore/DocStoreAPIDialog.jsx`
-   [M] `packages/ui/src/views/docstore/DocStoreInputHandler.jsx`
-   [M] `packages/ui/src/views/docstore/DocumentLoaderListDialog.jsx`
-   [M] `packages/ui/src/views/docstore/DocumentStoreDetail.jsx`
-   [M] `packages/ui/src/views/docstore/ExpandedChunkDialog.jsx`
-   [M] `packages/ui/src/views/docstore/LoaderConfigPreviewChunks.jsx`
-   [M] `packages/ui/src/views/docstore/UpsertHistoryDetailsDialog.jsx`
-   [M] `packages/ui/src/views/docstore/VectorStoreConfigure.jsx`
-   [M] `packages/ui/src/views/docstore/index.jsx`
-   [M] `packages/ui/src/views/evaluations/CreateEvaluationDialog.jsx`
-   [M] `packages/ui/src/views/evaluations/EvalsResultDialog.jsx`
-   [M] `packages/ui/src/views/evaluations/EvaluationResult.jsx`
-   [M] `packages/ui/src/views/evaluations/index.jsx`
-   [M] `packages/ui/src/views/evaluators/AddEditEvaluatorDialog.jsx`
-   [M] `packages/ui/src/views/evaluators/SamplePromptDialog.jsx`
-   [M] `packages/ui/src/views/evaluators/evaluatorConstant.js`
-   [M] `packages/ui/src/views/evaluators/index.jsx`
-   [M] `packages/ui/src/views/files/index.jsx`
-   [M] `packages/ui/src/views/marketplaces/MarketplaceCanvas.jsx`
-   [M] `packages/ui/src/views/marketplaces/MarketplaceCanvasHeader.jsx`
-   [M] `packages/ui/src/views/marketplaces/index.jsx`
-   [M] `packages/ui/src/views/roles/CreateEditRoleDialog.jsx`
-   [M] `packages/ui/src/views/roles/index.jsx`
-   [M] `packages/ui/src/views/schedule/ScheduleHistoryDrawer.jsx`
-   [M] `packages/ui/src/views/schedule/ScheduleHistoryFAB.jsx`
-   [M] `packages/ui/src/views/serverlogs/index.jsx`
-   [M, patch-stage] `packages/ui/src/views/tools/CustomMcpServerDialog.jsx`
-   [M] `packages/ui/src/views/tools/HowToUseFunctionDialog.jsx`
-   [M] `packages/ui/src/views/tools/PasteJSONDialog.jsx`
-   [M] `packages/ui/src/views/tools/ToolDialog.jsx`
-   [M] `packages/ui/src/views/tools/index.jsx`
-   [M, patch-stage] `packages/ui/src/views/users/EditUserDialog.jsx`
-   [M, patch-stage] `packages/ui/src/views/users/index.jsx`
-   [M] `packages/ui/src/views/variables/AddEditVariableDialog.jsx`
-   [M, patch-stage] `packages/ui/src/views/variables/HowToUseVariablesDialog.jsx`
-   [M] `packages/ui/src/views/variables/index.jsx`
-   [M] `packages/ui/src/views/vectorstore/UpsertHistoryDialog.jsx`
-   [M] `packages/ui/src/views/vectorstore/UpsertResultDialog.jsx`
-   [M] `packages/ui/src/views/vectorstore/VectorStoreDialog.jsx`
-   [M] `packages/ui/src/views/vectorstore/VectorStorePopUp.jsx`
-   [M] `packages/ui/src/views/webhooklistener/WebhookListenerDrawer.jsx`
-   [M] `packages/ui/src/views/webhooklistener/WebhookListenerFAB.jsx`
-   [M] `packages/ui/src/views/workspace/AddEditWorkspaceDialog.jsx`
-   [M] `packages/ui/src/views/workspace/EditWorkspaceUserRoleDialog.jsx`
-   [M, patch-stage] `packages/ui/src/views/workspace/WorkspaceUsers.jsx`
-   [M] `packages/ui/src/views/workspace/index.jsx`

### Authentication entry — patch-stage candidates

-   [M] `packages/ui/src/layout/AuthLayout/index.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/confirm-email-change.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/expired.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/forgotPassword.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/loginActivity.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/rateLimited.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/register.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/resetPassword.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/signIn.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/ssoConfig.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/unauthorized.jsx`
-   [M, patch-stage] `packages/ui/src/views/auth/verify-email.jsx`
-   [M, patch-stage] `packages/ui/src/views/organization/index.jsx`

## 3. Node 24 production build/runtime baseline

-   [M after Task 1 amend, unstaged review/classification only] `.dockerignore` — pre-existing broad build-context diff excluding the six Task 1 boundaries; do not stage it without independent evidence.
-   [M] `Dockerfile`
-   [M] `packages/ui/package.json`
-   [M] `packages/ui/vite.config.js`
-   [M, patch-stage] `pnpm-lock.yaml`

Commit: `build(docker): establish the Node 24 production runtime`.

## 4. DeepSeek/Kimi Provider 5A

-   [M] `packages/components/models.json`
-   [M] `packages/components/nodes/chatmodels/Deepseek/Deepseek.ts`
-   [untracked] `packages/components/credentials/KimiApi.credential.ts`
-   [untracked] `packages/components/nodes/chatmodels/ChatKimi/ChatKimi.test.ts`
-   [untracked] `packages/components/nodes/chatmodels/ChatKimi/ChatKimi.ts`
-   [untracked] `packages/components/nodes/chatmodels/ChatKimi/kimi.svg`
-   [untracked] `packages/components/nodes/chatmodels/Deepseek/Deepseek.test.ts`
-   [untracked] `packages/components/nodes/chatmodels/ProviderCatalog.test.ts`
-   [untracked] `packages/components/nodes/chatmodels/providerUtils.test.ts`
-   [untracked] `packages/components/nodes/chatmodels/providerUtils.ts`
-   [untracked] `docs/ops/flowise-provider-nodes-maintenance-20260710.md`

Commit: `feat(provider): harden DeepSeek and add Kimi models`. The SVG is an explicit Provider asset and must not be left as an orphan after the TypeScript node is committed. `provider_call=false`.

## 5. CSP/request security Batch 6B

-   [M, patch-stage] `packages/server/src/enterprise/middleware/passport/index.ts`
-   [M, patch-stage] `packages/server/src/index.ts`
-   [M, patch-stage] `packages/server/src/services/chatflows/index.test.ts`
-   [M, patch-stage] `packages/server/src/utils/XSS.test.ts`
-   [M, patch-stage] `packages/server/src/utils/XSS.ts`
-   [M, patch-stage] `packages/ui/index.html`
-   [untracked] `packages/server/src/utils/csp.test.ts`
-   [untracked] `packages/server/src/utils/csp.ts`
-   [untracked] `packages/server/src/utils/cspReport.test.ts`
-   [untracked] `packages/server/src/utils/cspReport.ts`
-   [untracked] `packages/ui/public/global.js`
-   [untracked] `docs/ops/flowise-security-headers-csp-20260710.md`
-   [untracked] `docs/superpowers/plans/2026-07-10-flowise-csp-iframe-governance.md`
-   [untracked] `docs/superpowers/specs/2026-07-10-flowise-csp-iframe-governance-design.md`

Commit: `feat(security): add controlled CSP and request boundaries`. `production unchanged`.

## 6. Release provenance and CI

### Current eligible untracked paths

-   [untracked, patch-stage] `.env.production.template`
-   [untracked, patch-stage] `docker-compose.prod.yml`
-   [untracked] `scripts/verify-production-edge.sh`
-   [untracked, patch-stage] `scripts/verify-security.sh`

### Planned Task 6 paths not yet part of this snapshot delta

-   `.nvmrc`
-   `.npmrc`
-   `package.json`
-   `Dockerfile` (a later provenance-only modification after group 3)
-   `.github/workflows/main.yml`
-   `.github/workflows/test_docker_build.yml`
-   `.github/workflows/publish-package.yml`
-   `.github/workflows/docker-image-ecr.yml`
-   `scripts/release-manifest.mjs`
-   `scripts/release-manifest.test.mjs`

Commit: `chore(release): add immutable build provenance`.

## 7. Current-state documentation

-   [untracked] `.kiro/plan/findings.md`
-   [untracked] `.kiro/plan/progress.md`
-   [untracked] `.kiro/plan/task_plan.md`
-   [untracked] `.kiro/steering/planning-context.md`
-   [untracked] `AGENTS.md`
-   [untracked] `docs/audits/flowise-production-adversarial-audit-20260710.md`
-   [untracked] `docs/ops/flowise-production-hardening-runbook-20260710.md`
-   [untracked] `docs/superpowers/plans/2026-07-10-flowise-audit-remediation.md`
-   [untracked] `docs/superpowers/plans/2026-07-10-flowise-production-authorized-deploy.md`
-   [untracked] `docs/superpowers/plans/2026-07-10-flowise-provider-contract-hardening.md`

The Provider and CSP operations documents remain in groups 4 and 5 for their first commits, then may receive verified current-state-only edits in group 7. Commit: `docs(ops): align release and production evidence`.

## Patch-staging register

These paths must be reviewed hunk-by-hunk at the owning task boundary:

-   `.dockerignore` (Task 3 owns only the replayed pre-existing build-context diff; the six Task 1 boundary lines are already committed)
-   `packages/ui/index.html`
-   `packages/ui/src/ui-component/dialog/InviteUsersDialog.jsx`
-   `packages/ui/src/views/account/index.jsx`
-   `packages/ui/src/views/assistants/custom/toolAgentFlow.js`
-   `packages/ui/src/views/auth/confirm-email-change.jsx`
-   `packages/ui/src/views/auth/expired.jsx`
-   `packages/ui/src/views/auth/forgotPassword.jsx`
-   `packages/ui/src/views/auth/loginActivity.jsx`
-   `packages/ui/src/views/auth/rateLimited.jsx`
-   `packages/ui/src/views/auth/register.jsx`
-   `packages/ui/src/views/auth/resetPassword.jsx`
-   `packages/ui/src/views/auth/signIn.jsx`
-   `packages/ui/src/views/auth/ssoConfig.jsx`
-   `packages/ui/src/views/auth/unauthorized.jsx`
-   `packages/ui/src/views/auth/verify-email.jsx`
-   `packages/ui/src/views/organization/index.jsx`
-   `packages/ui/src/views/tools/CustomMcpServerDialog.jsx`
-   `packages/ui/src/views/users/EditUserDialog.jsx`
-   `packages/ui/src/views/users/index.jsx`
-   `packages/ui/src/views/variables/HowToUseVariablesDialog.jsx`
-   `packages/ui/src/views/workspace/WorkspaceUsers.jsx`
-   `packages/server/src/index.ts`
-   `packages/server/src/enterprise/middleware/passport/index.ts`
-   `packages/server/src/services/chatflows/index.test.ts`
-   `packages/server/src/utils/XSS.ts`
-   `packages/server/src/utils/XSS.test.ts`
-   `docker-compose.prod.yml`
-   `.env.production.template`
-   `scripts/verify-security.sh`
-   `pnpm-lock.yaml`

## Historical and deferred eligible paths — excluded from Tasks 1-7

-   [historical-sensitive] `ADAPTATION_REPORT.md`
-   [historical-snapshot] `AUDIT_REPORT.md`
-   [historical-snapshot] `DEEPSEEK_GUIDE.md`
-   [historical-snapshot] `FINAL_ACCEPTANCE_REPORT.md`
-   [historical-snapshot] `FINAL_SPRINT_REPORT.md`
-   [historical-snapshot] `KIMI_GUIDE.md`
-   [historical-snapshot] `PRE_DEPLOYMENT_AUDIT_AND_SPRINT_PLAN.md`
-   [historical-snapshot] `TENCENT_DEPLOY.md`
-   [historical-snapshot] `TEST_PLAN.md`
-   [historical-snapshot] `TEST_PLAN_MULTI_AGENT.md`
-   [historical-snapshot] `TEST_REPORT.md`
-   [historical-snapshot] `TRANSLATION_AUDIT.md`
-   [deferred Docker variant] `docker/Dockerfile.local`
-   [deferred Docker variant] `docker/Dockerfile.minimal`
-   [deferred Docker variant] `docker/Dockerfile.node20`
-   [deferred environment template] `env.chinese.template`

No historical or deferred path above may be swept into a release commit.

## Ignored generated/private snapshot entries — excluded from release source

The following 27 collapsed entries are the exact `!!` paths from `git status --short --ignored`. The key-like path was identified by path only; no file content was read.

-   [generated] `.codegraph/`
-   [generated] `.husky/_/`
-   [generated] `.playwright-cli/`
-   [control-plane/generated] `.superpowers/`
-   [private, path-only] `ai_video.pem`
-   [dependency] `node_modules/`
-   [generated evidence] `output/`
-   [generated] `packages/agentflow/.turbo/`
-   [generated] `packages/agentflow/dist/`
-   [dependency] `packages/agentflow/node_modules/`
-   [generated] `packages/api-documentation/.turbo/`
-   [generated] `packages/api-documentation/dist/`
-   [dependency] `packages/api-documentation/node_modules/`
-   [generated] `packages/components/.turbo/`
-   [generated] `packages/components/dist/`
-   [dependency] `packages/components/node_modules/`
-   [generated] `packages/observe/.turbo/`
-   [generated] `packages/observe/dist/`
-   [dependency] `packages/observe/node_modules/`
-   [generated] `packages/server/.turbo/`
-   [generated] `packages/server/dist/`
-   [generated log] `packages/server/logs/`
-   [dependency] `packages/server/node_modules/`
-   [generated] `packages/ui/.turbo/`
-   [generated] `packages/ui/build/`
-   [dependency] `packages/ui/node_modules/`
-   [generated evidence] `test_reports/`

`tmp/` is also an enforced Git/Docker source-boundary rule even though no root `tmp/` entry exists in this snapshot.

## Evidence boundary

-   This is a dirty working-tree inventory, not a stable release manifest.
-   The committed Task 1 `.dockerignore` delta is exactly six boundary lines; the broader pre-existing `.dockerignore` work is restored only as an unstaged Task 3 candidate.
-   Full-worktree tests do not prove a later patch-staged commit is isolated; every group must rerun its own staged checks.
-   `production unchanged`, `production_write=false`, `provider_call=false`, and `secrets_read=false` remain in force.
