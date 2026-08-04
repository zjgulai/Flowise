# 历史 Provider 凭据关账清单（脱敏）

状态：`OPEN / production promotion NO-GO`
事件编号：`SEC-HIST-PROVIDER-001`
适用范围：Git 历史中可达、当前树已删除但尚无 Provider 侧吊销证明的疑似凭据
禁止事项：不得把原始值、完整指纹、账户标识、账单明细或内部工单链接写入 Git、日志、截图或公开 Playbook。
关联本地候选：G1-E `0388dad97ac41f2f101864503906fe7bb04450bf` 已通过当前树秘密扫描与本地安全复核；此代码候选 GO 不构成历史事件关账或生产放行证据。

## 已确认事实

-   当前源码树与本地候选的已知 Provider token 格式扫描命中为 `0`。
-   早期 Git 对象仍可通过历史引用到达；“当前文件已删除”不能证明凭据已失效。
-   本地代码扫描无法证明 Provider 侧吊销、轮换、异常使用或账单处置状态。
-   本轮没有读取生产秘密、没有尝试使用历史值、没有调用 Provider，也没有改写或推送 Git 历史。

## 所有者／Provider 侧必需回执

以下材料只能存放在受控工单或秘密管理系统；仓库仅记录脱敏状态与受控参考编号。

1. **凭据归属确认**
    - Provider 名称与受控账户参考编号。
    - 凭据所有者与安全复核人。
    - 由安全渠道生成的不可逆短指纹；不得提交原始值。
2. **吊销或轮换证明**
    - Provider 控制台／API 的吊销时间、状态和受控回执编号。
    - 如采用轮换，新凭据仅进入生产秘密存储；仓库不得记录新值或可逆材料。
    - 用不含凭据的只读状态核验确认旧凭据不可再用；禁止从本仓库自动尝试历史值。
3. **使用与账单核查**
    - 核查区间、审计人、异常请求／费用结论和处置编号。
    - 如存在异常，关联安全事件响应、费用争议和影响评估；公开材料只保留结论等级。
4. **暴露面核查**
    - 检查 fork、镜像、制品、CI 缓存、备份和发布包是否包含相关 Git 对象或明文副本。
    - 对发现的副本逐项记录清理或隔离回执；不得仅以主仓库扫描结果替代。

## Git 历史治理（吊销后单独决策）

历史重写不能替代 Provider 吊销。只有完成上节回执后，才能在新的书面授权下决定是否重写历史。若执行，必须先完成：

-   枚举所有分支、标签、fork、镜像仓库与活跃克隆。
-   冻结写入并通知协作者，保存不可公开的取证副本和回滚方案。
-   在隔离副本演练过滤规则，验证目标对象不可达且非目标历史不漂移。
-   协调 force-push、标签替换、缓存清理和所有克隆重新拉取。
-   重跑 current tree、全历史、制品和镜像秘密扫描并保存脱敏回执。

本文件不授权历史重写、force-push、删除标签、清理 fork 或销毁取证副本。

## 生产放行判定

只有以下项目全部为 `PASS`，安全负责人才能把本事件从生产阻断项中移除：

-   [ ] 归属与不可逆指纹已确认。
-   [ ] Provider 侧旧凭据已吊销，或有可核验的既往吊销证明。
-   [ ] 如需轮换，新凭据已进入受保护运行时并完成最小权限验证。
-   [ ] 使用与账单审计已完成，异常项均有处置结论。
-   [ ] fork／制品／缓存／备份暴露面已核查并完成处置。
-   [ ] 安全复核人签署受控回执编号。
-   [ ] 仓库只记录脱敏结论，不包含秘密或账户细节。

在清单全部关闭前：`production promotion = NO-GO`。

## 脱敏回执模板

```yaml
incident_id: SEC-HIST-PROVIDER-001
provider_ref: CONTROLLED-REF-ONLY
owner_ref: CONTROLLED-REF-ONLY
fingerprint_ref: ONE-WAY-SHORT-REF
revocation_status: pending | confirmed
revoked_at: null
rotation_status: not-required | pending | confirmed
billing_audit_status: pending | confirmed
exposure_audit_status: pending | confirmed
security_reviewer_ref: CONTROLLED-REF-ONLY
receipt_ref: CONTROLLED-REF-ONLY
public_safe_summary: pending
```

`receipt_ref` 只允许不含内部域名、账号、Token、Key、URL 参数或可逆凭据材料的受控编号。
