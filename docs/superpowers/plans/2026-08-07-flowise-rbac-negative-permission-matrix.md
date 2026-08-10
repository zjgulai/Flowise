---
title: Gate H3 RBAC 负向权限矩阵与第二 run-scoped member 双重清理方案
date: 2026-08-07
last_updated: 2026-08-10
status: l1_contract_ported_l4_pending
scope: local_permissioncheck_contract_and_future_authorized_e2e
evidence_grade: L1 middleware contract; L4 route and member evidence pending
---

# 目标

为 Gate H3 设计第二个 run-scoped member 的负向权限矩阵验收方案，证明非 Owner 角色
无法执行越权操作。管理员通过不能替代越权证明——必须用受限 member 身份实测拒绝路径。

本文档同时保存已落地的 L1 `PermissionCheck` middleware 合同与未来 L4 E2E 规格，
不涉及生产写入、Provider 调用或 registry 操作。L1 测试不能替代真实 route、session、
workspace membership、数据库 side effect 或 reaper 的 L4 证据。

---

# 一、权限系统结构（源码基础）

## 1.1 角色层级

```
isOrganizationAdmin=true
  └─ 绕过所有 checkPermission，assertWorkspaceBelongsToActiveOrganization 仍生效
GeneralRole.OWNER   (workspace + organization 双重 owner)
  └─ 拥有全量 open-source 权限集
GeneralRole.MEMBER  (自定义权限集，由 Role.permissions JSON 数组定义)
  └─ 仅拥有 role.permissions 中声明的权限
```

-   `PermissionCheck.checkPermission(p)`: 未登录 → 403；org admin → pass；permissions 含 p → pass；否则 403
-   `PermissionCheck.checkAnyPermission(ps)`: 同上，任一权限命中即 pass
-   `assertWorkspaceRoleAssignmentAllowed`: actor 只能授予自身权限子集，不能提权

## 1.2 Open-source 有效权限集（`isOpenSource=true`）

以下权限在 open-source 部署下对自定义角色有效：

```
chatflows:     view, create, update, duplicate, delete, export, import, config, domains
agentflows:    view, create, update, duplicate, delete, export, import, config, domains
tools:         view, create, update, delete, export
assistants:    view, create, update, delete
credentials:   view, create, update, delete
               (credentials:share 仅 Enterprise/Cloud)
variables:     view, create, update, delete
apikeys:       view, create, update, delete
documentStores: view, create, update, delete, add-loader, delete-loader, preview-process, upsert-config
executions:    view, update, delete
templates:     marketplace, custom, custom-delete, toolexport, flowexport
               (templates:custom-share 仅 Enterprise/Cloud)
```

## 1.3 企业独占权限（`isOpenSource=false`，open-source 下不生效）

```
datasets:      view, create, update, delete
evaluators:    view, create, update, delete
evaluations:   view, create, update, delete, run
workspace:     view, create, update, add-user, unlink-user, delete, export, import
users:         manage
roles:         manage
sso:           manage (仅 Enterprise)
logs:          view   (仅 Enterprise)
loginActivity: view   (仅 Enterprise)
```

---

# 二、第二 run-scoped member 设计

## 2.1 成员身份

| 字段     | 值                                          |
| -------- | ------------------------------------------- |
| 角色名   | `rbac-test-member-<run_id>`                 |
| 权限集   | **最小只读子集**（见 2.2）                  |
| 状态     | ACTIVE                                      |
| 归属     | 与 Owner 同一 workspace/organization        |
| 生命周期 | run 开始创建，验收后立即清理（双重 reaper） |

## 2.2 最小只读权限集（member 拥有）

```json
[
    "chatflows:view",
    "agentflows:view",
    "tools:view",
    "assistants:view",
    "credentials:view",
    "variables:view",
    "apikeys:view",
    "documentStores:view",
    "executions:view",
    "templates:marketplace",
    "templates:custom"
]
```

**明确不授予**：任何 `:create`、`:update`、`:delete`、`:duplicate`、`:import`、`:export`、`:config`、`:domains`、`:share`、`workspace:*`、`users:manage`、`roles:manage`

---

# 三、负向权限矩阵

对每个需要权限的路由，用 member 身份发起请求，期望返回 403 Forbidden。

## 3.1 写操作否定测试

| 路由                                | 方法   | 所需权限              | member 期望 | 测试类型 |
| ----------------------------------- | ------ | --------------------- | ----------- | -------- |
| `POST /api/v1/chatflows`            | POST   | chatflows:create      | 403         | 负向     |
| `PUT /api/v1/chatflows/:id`         | PUT    | chatflows:update      | 403         | 负向     |
| `DELETE /api/v1/chatflows/:id`      | DELETE | chatflows:delete      | 403         | 负向     |
| `POST /api/v1/agentflows`           | POST   | agentflows:create     | 403         | 负向     |
| `DELETE /api/v1/agentflows/:id`     | DELETE | agentflows:delete     | 403         | 负向     |
| `POST /api/v1/tools`                | POST   | tools:create          | 403         | 负向     |
| `DELETE /api/v1/tools/:id`          | DELETE | tools:delete          | 403         | 负向     |
| `POST /api/v1/credentials`          | POST   | credentials:create    | 403         | 负向     |
| `PUT /api/v1/credentials/:id`       | PUT    | credentials:update    | 403         | 负向     |
| `DELETE /api/v1/credentials/:id`    | DELETE | credentials:delete    | 403         | 负向     |
| `POST /api/v1/variables`            | POST   | variables:create      | 403         | 负向     |
| `DELETE /api/v1/variables/:id`      | DELETE | variables:delete      | 403         | 负向     |
| `POST /api/v1/apikey`               | POST   | apikeys:create        | 403         | 负向     |
| `DELETE /api/v1/apikey/:id`         | DELETE | apikeys:delete        | 403         | 负向     |
| `POST /api/v1/document-store`       | POST   | documentStores:create | 403         | 负向     |
| `DELETE /api/v1/document-store/:id` | DELETE | documentStores:delete | 403         | 负向     |

## 3.2 管理操作否定测试

| 路由                               | 方法   | 所需权限              | member 期望 | 备注           |
| ---------------------------------- | ------ | --------------------- | ----------- | -------------- |
| `POST /api/v1/organization-user`   | POST   | users:manage          | 403         | 添加组织成员   |
| `PUT /api/v1/organization-user`    | PUT    | users:manage          | 403         | 修改成员角色   |
| `DELETE /api/v1/organization-user` | DELETE | users:manage          | 403         | 移除成员       |
| `POST /api/v1/workspace-user`      | POST   | workspace:add-user    | 403         | 添加工作区成员 |
| `DELETE /api/v1/workspace-user`    | DELETE | workspace:unlink-user | 403         | 移除工作区成员 |
| `POST /api/v1/workspace`           | POST   | workspace:create      | 403         | 创建工作区     |
| `PUT /api/v1/workspace`            | PUT    | workspace:update      | 403         | 更新工作区     |
| `DELETE /api/v1/workspace/:id`     | DELETE | workspace:delete      | 403         | 删除工作区     |
| `POST /api/v1/role`                | POST   | roles:manage          | 403         | 创建角色       |
| `PUT /api/v1/role`                 | PUT    | roles:manage          | 403         | 更新角色       |
| `DELETE /api/v1/role`              | DELETE | roles:manage          | 403         | 删除角色       |
| `POST /api/v1/user`                | POST   | users:manage          | 403         | 创建用户       |

## 3.3 跨工作区访问否定测试

| 场景                               | 期望    | 机制                                       |
| ---------------------------------- | ------- | ------------------------------------------ |
| 访问非 activeWorkspace 的 chatflow | 403/404 | tenant scope filter                        |
| 工作区删除其他 org 的工作区        | 403     | assertWorkspaceBelongsToActiveOrganization |
| 角色授予超出自身权限的权限         | 403     | assertWorkspaceRoleAssignmentAllowed       |
| Owner 降级为非 OWNER 操作          | 403     | assertWorkspaceOwnerMutationAllowed        |

## 3.4 只读允许验证（正向对照）

| 路由                      | 方法 | 所需权限         | member 期望 | 备注         |
| ------------------------- | ---- | ---------------- | ----------- | ------------ |
| `GET /api/v1/chatflows`   | GET  | chatflows:view   | 200         | 确认只读有效 |
| `GET /api/v1/credentials` | GET  | credentials:view | 200         | 确认只读有效 |
| `GET /api/v1/variables`   | GET  | variables:view   | 200         | 确认只读有效 |

---

# 四、双重清理方案

## 4.1 清理对象（精确 run-scoped）

```
1. member user 记录        → DELETE FROM user WHERE id = $member_user_id
2. organization_user 记录  → DELETE FROM organization_user WHERE userId = $member_user_id
3. workspace_user 记录     → DELETE FROM workspace_user WHERE userId = $member_user_id
4. member role 记录        → DELETE FROM role WHERE id = $member_role_id AND name = 'rbac-test-member-{run_id}'
5. 登录 session（如有）    → 撤销 session token
```

## 4.2 双重 reaper 流程

```
reaper_1:
  - 删除上述 5 类对象
  - 记录每类 affected 行数
  - 期望：每类 affected = 1（或 0 若未创建）

reaper_2（幂等验证）:
  - 重复执行同一 DELETE
  - 期望：每类 affected = 0（已被第一次清理）

postcheck:
  - 确认 $member_user_id 不存在于 user 表
  - 确认 $member_role_id 不存在于 role 表（name 匹配）
  - DB fingerprint（total counts）恢复到创建前基线
```

## 4.3 失败停止规则

-   任何负向测试未返回 403 → 立即停止，记录漏洞，不继续执行后续写操作
-   reaper_1 任意对象 affected > 1 → 立即停止，调查意外数据
-   postcheck DB fingerprint 未恢复 → 不声明验收通过

---

# 五、测试身份创建方案

## 5.1 前置条件

-   Owner 身份已登录并持有有效 session
-   `ADMIN_ONLY_MODE=true` 下：Owner 必须先创建 member，member 无法自行注册
-   member 身份通过 Owner API 创建，不使用注册页面

## 5.2 创建步骤（Owner 执行）

```
1. POST /api/v1/role
   body: { name: "rbac-test-member-{run_id}", permissions: [...最小只读集...] }
   → 记录 $member_role_id

2. POST /api/v1/user
   body: { email: "rbac-test-{run_id}@invalid", password: "{random}", ... }
   → 记录 $member_user_id

3. POST /api/v1/organization-user
   body: { organizationId, userId: $member_user_id, roleId: $member_role_id, status: "active" }

4. POST /api/v1/workspace-user
   body: { workspaceId, userId: $member_user_id, roleId: $member_role_id, status: "active" }

5. member 登录，获取 member session token
```

## 5.3 执行边界

-   `provider_call=false`、`smtp_send=false`、`flow_execution=false`
-   member 创建时不写入 credential/API key/Variable/Chatflow/Agentflow/DocumentStore
-   所有 403 测试只发出 HTTP 请求，不操作数据库
-   清理使用 Owner 身份执行，不用 SQL 直接操作

---

# 六、阻断条件（执行前必须满足）

| 阻断项               | 当前状态                                                | 解除条件                                    |
| -------------------- | ------------------------------------------------------- | ------------------------------------------- |
| 当前 main 候选与生产 | 本地 D0 收敛中；历史部署回执不证明当前 main 已部署      | 独立完成 main candidate、发布与 L4 部署门禁 |
| 专用测试账号         | 未授权创建 run-scoped member                            | Owner 明确批准创建、使用并清理测试 member   |
| 隔离 workspace       | 尚无本轮确认的 non-personal acceptance workspace        | 提供或授权创建可清理的 acceptance workspace |
| reaper 与基线回执    | 只有设计，尚无本轮 precheck/reaper/postcheck 持久化回执 | 在授权执行窗绑定 run ID、对象 ID 与基线摘要 |

---

# 七、实现状态

-   `[x]` 权限系统源码审查完成（Permissions.ts / PermissionCheck.ts / membershipMutationGuards.ts）
-   `[x]` 负向权限矩阵设计完成（本文档）
-   `[x]` 双重清理方案设计完成
-   `[x]` `PermissionCheck` / `checkAnyPermission` L1 负向与正向对照测试已前移到当前 main 候选；实际通过数以执行日志为准
-   `[ ]` 当前 main 候选完成独立发布与 L4 部署门禁；历史旧 SHA 的部署回执不得替代
-   `[ ]` 等待 Owner 授权创建 run-scoped member 身份
-   `[ ]` 实际 route/session/member/workspace E2E 负向测试执行
-   `[ ]` 双重 reaper + postcheck 执行
