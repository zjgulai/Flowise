# Flowise Bootstrap Observed-State Recovery Amendment

Status: local implementation and verification complete; CI artifact and
production execution pending

Scope: one recovery-only completion for production bootstrap run
`20260728T171644Z-4914e862`; commands and field names are English, operational
requirements are normative.

Frozen local wrapper SHA-256 prefix: `32578dd`. This short content-digest prefix
identifies the locally verified implementation only; it is not a Git revision,
a self-bound CI artifact or sufficient production authority.

## Decision

本 amendment 允许 wrapper 在一个已经完成 Flowise recreate、但尚未写出
`bootstrap-complete-receipt.json` 的精确中断态中，采用已经运行且经完整语义验证的
hardened baseline。流程固定为：

1. `snapshot-bootstrap-recovery` 在 deploy lock 下执行两次完整只读观察，输出一个
   secret-free `recovery_snapshot_sha256`；
2. `complete-bootstrap-recovery` 重新执行两次完整观察，对 snapshot 做 CAS，并且只写
   immutable completion receipt 与 terminal journal；
3. 完成 fresh production L3 后，才允许进入普通 `prepare -> cutover`。

这不是一次新的 runtime transition。completion 不 recreate 容器，不安装或恢复配置，
不加载镜像，不写数据库，也不调用 provider。Docker Compose label 只作为 opaque
evidence 被精确绑定；授权来自 requested Compose hash、完整 semantic projection、完整
environment HMAC、镜像与 live files、sidecars、network、database、persistent key 和
三条 ping 的联合验证。

这是对原规范 “post-write interruption 必须恢复到 legacy，禁止 forward resume” 的
书面、窄化例外。例外只覆盖本文件定义的一个 run、一个 phase、一个容器与一组精确
证据，不扩展到其他 run、其他 phase、未来相似故障或通用 forward resume。

## Incident evidence boundary

以下是 2026-07-28 中断后的已观察生产证据，不是可重用授权，也不包含凭据：

| Evidence                            | Observed value                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| interrupted run                     | `20260728T171644Z-4914e862`                                                             |
| journal                             | `operation=bootstrap`, `state=in_progress`, `phase=hardened_recreate_intent`            |
| write markers                       | `live_write_started=true`, `hardened_recreate_started=true`, `rollback_attempted=false` |
| source bundle release               | `git-56196c3cb4a3123f657614274a2227071920ba01`                                          |
| source bundle digest                | `sha256:61f511a2887afd75da2a2e2ab0bc94399c9c4af944a98920f4bb76c00a98c924`               |
| transition permit digest            | `sha256:a8afbf9ca32ef4cc9ead605a81f8624db1cf5538e0a23cccb2e46a3b76f0ada3`               |
| bootstrap prepare receipt digest    | `sha256:51402626a07b4b573e17b058e27a6e0df02dd7b34016df465f571ace949e6f2c`               |
| frozen local wrapper SHA-256 prefix | `32578dd` (local evidence only; not a deployable artifact identity)                     |
| active Flowise image                | `flowise-chinese:git-c947339b7033c930be37591918f59c7725800bbe`                          |
| active image config digest          | `sha256:a8f38dca92292711a781432dc7700218273eececa331446d0678251cf6fe2067`               |
| current Flowise container ID        | `953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39`                      |
| PostgreSQL container ID             | `326fc99b16037b719a664b7ecbf9f6ee57f5b4d3cebf1395c65066319f514492`                      |
| Nginx container ID                  | `0a468dd7d2dd55b05c3804fb67eea62801c83bf431d8f8587ed431bbb4a1f0eb`                      |
| requested Compose service hash      | `8642827174f0ca74dd1a6fc5a8334f116eafe97f9386c1610d5719555e9d3200`                      |
| observed Compose label              | `d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86`                      |
| Compose implementation              | `Docker Compose version v2.27.1`                                                        |
| seccomp canonical digest            | `sha256:8bc9daff33eb5909c662dad46e9600c6cdfcf4327e84e30b94395176738d27cf`               |
| full runtime projection digest      | `sha256:41b684e72f394cb90b84c863a2732ea1b489ca646d1f37f1004becd575ccd874`               |
| live file state                     | `HHH`, byte-for-byte equal to `bootstrap-prepare-receipt.json.hardened_active.files`    |
| migrations                          | `59`; exact inventory and name-only digests documented below                            |
| runtime state                       | Flowise, PostgreSQL and Nginx `running` and `healthy`; Flowise restart count `0`        |
| connectivity                        | private, reverse-proxy and public ping paths passed                                     |

The July 29 recovery attempt re-read the database in a read-only transaction
and confirmed the current four-field database fingerprint is byte-for-byte
equal to `bootstrap-prepare-receipt.json.baseline.database`. The earlier table
had mislabeled the timestamp-and-name inventory digest as the name-only digest;
the two authorities are intentionally distinct. This correction does not
authorize a database write or weaken the exact baseline comparison.

-   ordered timestamp-and-name inventory digest:
    `sha256:a30f16eb1af7cb810e97cd45df464e97255d9bc8a2d9aaabbac8787b4396b5b6`;
-   ordered-name digest:
    `sha256:2b3bbc851e962ef6a317697f851890ebe5e9b193ebfe50aacf47446fcdf0cbb5`.

The production observation also showed the Docker Engine representation of
`SecurityOpt` differs from the Compose source representation:

-   `no-new-privileges` is observed as `no-new-privileges:true`;
-   `seccomp=/opt/flowise/docker/seccomp/chromium.json` is observed as
    `seccomp=<inline JSON>`.

旧 validator 将 label 与 requested hash 强制相等，并按原始字符串比较
`SecurityOpt`，所以它既不能证明当前 hardened runtime，也不能安全完成旧式自动
rollback。不得把该 validator failure 解释为运行态不安全，也不得忽略它；本流程必须
用修正后的完整语义合同重新证明状态。

## Unique eligible pre-state

两个 recovery 命令只接受同时满足下列全部条件的状态。任一条件不符都必须在第一笔
control write 前失败：

1. `run_id` 必须精确为 `20260728T171644Z-4914e862`。run directory 必须是
   root-owned mode `0700` 非 symlink 目录；所有 control files 必须是 root-owned mode
   `0600`、`nlink=1`、non-empty 且不超过 16 GiB 的 non-symlink regular files。
2. Journal 必须是 canonical JSON，且 key set 精确为 `schema_version`, `policy`,
   `operation`, `state`, `phase`, `run_id`, `permit_digest`,
   `target_bundle_digest`, `target_bundle_release_id`,
   `active_legacy_release_id`, `live_write_started`,
   `hardened_recreate_started`, `rollback_attempted`,
   `bootstrap_prepare_receipt_sha256`, `updated_at`。其中必须满足
   `operation=bootstrap`, `state=in_progress`,
   `phase=hardened_recreate_intent`, `live_write_started=true`,
   `hardened_recreate_started=true`, `rollback_attempted=false`，release IDs、digests
   与 timestamp 必须有效且互相绑定。不得存在 unknown、failure、rollback 或 terminal
   marker。
3. `bootstrap-prepare-receipt.json` 必须存在且 immutable；
   `bootstrap-complete-receipt.json` 与 `bootstrap-rollback-receipt.json` 必须不存在，
   除非进入本文件定义的 crash-resume 或 terminal-idempotent 分支。
4. Journal、prepare receipt、transition permit 和 source bundle 必须互相绑定同一
   `run_id`、permit digest、target/source bundle digest、legacy release、prepare
   receipt digest 和 frozen archive。unknown keys、non-canonical JSON、unsafe metadata
   或 digest drift 均拒绝。
5. Recovery bundle 必须由新的 CI artifact 自绑定验证；其 revision、bundle digest、
   manifest、wrapper bytes 和 release readiness 必须互相一致。Recovery bundle 与
   source bundle 分开绑定，不能用路径相同替代 digest 相等。
6. Flowise 当前 container ID 必须等于显式参数和 snapshot 中的精确 ID；它必须继续
   运行 `c947339b...` image tag 与精确 image config digest。PostgreSQL 与 Nginx 的 ID、
   image、health 和 network attachments 必须与 permit/prepare baseline 相同。
7. Live state 必须为 `HHH`：seccomp、Compose 和 environment bytes 分别精确等于
   prepare receipt 的 `hardened_active.files`；不得接受 `LLL`、部分 prefix、unknown
   bytes 或候选 image。
8. Requested Compose service hash 必须等于 prepare receipt 的
   `hardened_active.compose_config_hash`。当前 container label 必须等于显式参数和
   snapshot 的 exact opaque value。两者允许不同，但都必须是 64 位 lowercase hex，
   且不得由其中一个推导或替代另一个。
9. 完整 hardened semantic projection 必须匹配 Compose contract；完整 runtime
   projection digest 也必须稳定。环境变量 key set 必须完全一致，canonical full
   image-plus-Compose environment 的 HMAC-SHA256 必须匹配 receipt；HMAC key 仍为既有
   32-byte persistent key，值不得输出或落入 control artifacts。
10. Network names、NetworkIDs、Flowise 与两个 sidecar 的 attachment 必须与 baseline
    相同；database migration count、ordered-name digest 与 runtime identity 必须相同；
    persistent key continuity 与 private/proxy/public ping 必须全部通过。
11. 除本 run 外，current deployment journals 与 legacy release-scoped journals 必须
    没有 unresolved、unknown 或 unsafe state。本 run 是唯一允许的 unresolved run；
    任何第二个 unresolved run 都拒绝。
12. 不得存在并发 release wrapper、container replacement、live-file writer 或相关
    drift。所有观察和 control writes 必须在同一 deploy lock 下完成。

路径、ID 和 hash 的命令行参数只是 operator-supplied expectations，不是授权。wrapper
必须从受控文件和 live state 独立重建同一证据并逐项比较。

### Exact run topology and existing-only lock

每次 snapshot、completion、crash-resume 与 terminal replay 都必须枚举整个 incident
run tree，不跟随 symlink。除 run root 外，目录集合必须精确为：

```text
legacy
legacy/docker
legacy/docker/seccomp
hardened_active
hardened_active/docker
hardened_active/docker/seccomp
target_bundle
target_bundle/docker
target_bundle/docker/seccomp
```

基础文件集合必须精确为：

```text
journal.json
bootstrap-prepare-receipt.json
legacy/.env.production
legacy/docker-compose.prod.yml
legacy/image.tar.gz
hardened_active/.env.production
hardened_active/docker-compose.prod.yml
hardened_active/docker/seccomp/chromium.json
target_bundle/.env.production
target_bundle/docker-compose.prod.yml
target_bundle/docker/seccomp/chromium.json
```

Snapshot 要求基础集合且 completion receipt 不存在；completion 分类阶段只允许基础集合
或再加唯一的 `bootstrap-complete-receipt.json`，随后按 interrupted、receipt-written 或
terminal 分支收紧为 absent/present。任何额外目录、临时文件、第二份 receipt、symlink、
特殊文件或 metadata drift 都失败。

两个 recovery 命令先做 frozen scope 校验，再以 existing-only 方式打开
`/run/lock/flowise-production-release/deploy.lock`。lock parent、mode、ownership、文件
identity 与 `O_NOFOLLOW` 必须通过；命令不得创建 lock directory 或 lock file。获取已有
lock 后才读取 incident context 并验证上述 topology，因此 scope 或 topology failure 都
不能借 recovery 路径创建 lock 对象。

## Runtime hash and security-option contract

长期 hardened runtime 合同改为三元绑定：

```text
requested_compose_config_hash
observed_runtime_config_hash
semantic_runtime_projection_sha256
```

-   `requested_compose_config_hash` 来自受控 bundle 的 Compose render/hash，是 intended
    configuration evidence；
-   `observed_runtime_config_hash` 是 Docker inspect 中 Compose config-hash label 的原始
    值，是 opaque provenance evidence；必须记录和 CAS，但不得要求它等于 requested
    hash；
-   `semantic_runtime_projection_sha256` 来自受严格 schema 限制的完整 hardened runtime
    projection，是实际授权依据。完整 projection 还必须单独 digest-bound，防止 stable
    projection 排除字段产生盲区。

### Exact normalized Docker surfaces

Opaque label 只在下面的完整合同同时通过时才被允许。`Config.Env` 先由 image
environment 加 Compose service overlay 重建并作 exact map/HMAC 校验；`Config.Labels`
先按 16 个 exact keys 和 values 校验，然后二者才从 `Config` 的 canonical comparison
中移除。`Path` 必须精确为 `docker-entrypoint.sh`，`Args` 必须精确为
`["node", "packages/server/bin/run", "start"]`。`Hostname` 必须先等于当前 64 位
container ID 的前 12 位，再替换为 sentinel；`Image` 则替换为本次经验证的 exact image
tag。

归一后的 `Config` 必须是以下 17-key、value- and type-exact object：

```json
{
    "AttachStderr": true,
    "AttachStdin": false,
    "AttachStdout": true,
    "Cmd": ["node", "packages/server/bin/run", "start"],
    "Domainname": "",
    "Entrypoint": ["docker-entrypoint.sh"],
    "ExposedPorts": { "3000/tcp": {} },
    "Healthcheck": {
        "Interval": 30000000000,
        "Retries": 3,
        "StartPeriod": 60000000000,
        "Test": ["CMD", "curl", "-fsS", "http://localhost:3000/api/v1/ping"],
        "Timeout": 10000000000
    },
    "Hostname": "__CURRENT_ID_PREFIX__",
    "Image": "flowise-chinese:git-c947339b7033c930be37591918f59c7725800bbe",
    "OnBuild": null,
    "OpenStdin": false,
    "StdinOnce": false,
    "Tty": false,
    "User": "1000:1000",
    "Volumes": null,
    "WorkingDir": "/usr/src/flowise"
}
```

唯一允许的 Healthcheck 表示归一是：仅当 `StartInterval` 的 Python runtime type 精确为
原生 `int` 且值为 `0` 时删除该字段；`false`、`0.0`、字符串 `"0"` 或任意其他新增
字段均不归一。其余字段经过 canonical JSON bytes 比较，因此 `null`、空 list、空
object、空 string、boolean 与 integer 不可互换。

归一后的 `HostConfig` 必须是以下 66-key、value- and type-exact object；唯一语义化字段
是 `SecurityOpt`：

```json
{
    "AutoRemove": false,
    "Binds": null,
    "BlkioDeviceReadBps": null,
    "BlkioDeviceReadIOps": null,
    "BlkioDeviceWriteBps": null,
    "BlkioDeviceWriteIOps": null,
    "BlkioWeight": 0,
    "BlkioWeightDevice": null,
    "CapAdd": null,
    "CapDrop": ["ALL"],
    "Cgroup": "",
    "CgroupParent": "",
    "CgroupnsMode": "private",
    "ConsoleSize": [0, 0],
    "ContainerIDFile": "",
    "CpuCount": 0,
    "CpuPercent": 0,
    "CpuPeriod": 0,
    "CpuQuota": 0,
    "CpuRealtimePeriod": 0,
    "CpuRealtimeRuntime": 0,
    "CpuShares": 0,
    "CpusetCpus": "",
    "CpusetMems": "",
    "DeviceCgroupRules": null,
    "DeviceRequests": null,
    "Devices": null,
    "Dns": null,
    "DnsOptions": null,
    "DnsSearch": null,
    "ExtraHosts": [],
    "GroupAdd": null,
    "IOMaximumBandwidth": 0,
    "IOMaximumIOps": 0,
    "Init": true,
    "IpcMode": "private",
    "Isolation": "",
    "Links": null,
    "LogConfig": {
        "Config": {
            "labels": "service_name,environment",
            "max-file": "3",
            "max-size": "10m"
        },
        "Type": "json-file"
    },
    "MaskedPaths": [
        "/proc/asound",
        "/proc/acpi",
        "/proc/kcore",
        "/proc/keys",
        "/proc/latency_stats",
        "/proc/timer_list",
        "/proc/timer_stats",
        "/proc/sched_debug",
        "/proc/scsi",
        "/sys/firmware",
        "/sys/devices/virtual/powercap"
    ],
    "Memory": 4294967296,
    "MemoryReservation": 2147483648,
    "MemorySwap": 8589934592,
    "MemorySwappiness": null,
    "Mounts": [
        {
            "Source": "flowise_flowise_data",
            "Target": "/usr/src/flowise/.flowise",
            "Type": "volume",
            "VolumeOptions": {}
        }
    ],
    "NanoCpus": 2000000000,
    "NetworkMode": "flowise_flowise_network",
    "OomKillDisable": null,
    "OomScoreAdj": 0,
    "PidMode": "",
    "PidsLimit": 512,
    "PortBindings": {
        "3000/tcp": [{ "HostIp": "172.20.0.1", "HostPort": "3000" }]
    },
    "Privileged": false,
    "PublishAllPorts": false,
    "ReadonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
    "ReadonlyRootfs": true,
    "RestartPolicy": { "MaximumRetryCount": 0, "Name": "always" },
    "Runtime": "runc",
    "SecurityOpt": {
        "no_new_privileges": true,
        "seccomp_canonical_sha256": "sha256:8bc9daff33eb5909c662dad46e9600c6cdfcf4327e84e30b94395176738d27cf"
    },
    "ShmSize": 67108864,
    "Tmpfs": {
        "/dev/shm": "rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=1777",
        "/tmp": "rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777",
        "/usr/src/flowise/packages/server/logs": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700"
    },
    "UTSMode": "",
    "Ulimits": null,
    "UsernsMode": "",
    "VolumeDriver": "",
    "VolumesFrom": null
}
```

Exact label map 包含 Compose 的 `config-hash`, `container-number`, `depends_on`,
`image`, `oneoff`, `project`, `project.config_files`, `project.environment_file`,
`project.working_dir`, `replace`, `service`, `version`，以及 OCI 的 `created`,
`revision`, `source`, `version`。其 values 分别绑定 observed opaque hash、exact image
config digest、受控 `/opt/flowise` 路径、被替换 container ID、Compose `2.27.1` 与已验证
image provenance；任何 extra/missing label 都拒绝。

`SecurityOpt` 必须先规范化再进入 semantic projection：

1. `no-new-privileges`、`no-new-privileges:true` 与
   `no-new-privileges=true` 统一为 canonical boolean
   `no_new_privileges=true`；缺失、`false`、重复或冲突值均拒绝。
2. Compose source 中的受控 `seccomp=<path>` 由 live-file validator 读取 profile
   bytes；Docker Engine 返回的 runtime `seccomp=<inline JSON>` 由 runtime normalizer
   解析。两侧执行 strict JSON object/duplicate-key validation 后都以 canonical JSON
   SHA-256 表示；
   runtime 中的 path form 不被接受，也不得按路径字符串或原始 JSON whitespace 比较。
3. Seccomp profile 必须与 live hardened file 和 bundle profile 三方等价。额外
   `SecurityOpt`、重复 seccomp、invalid JSON 或 profile semantic drift 均拒绝。
4. 规范化只处理已列出的 Docker 表示差异；不得删除、忽略或宽松接受其他 runtime
   字段。

该三元合同同时用于本次 recovery 和后续普通 hardened validation。它修复 hash/label
的证据语义，不创建 global `ignore config hash` 开关。

`allow_opaque_config_hash=True` 仅出现在以下五条 hardened 路径，且每条路径都必须同时
传入 `require_candidate_hardening=True`、`require_exact_environment=True`、完整 resolved
Compose contract、从 verified image config environment 加 Compose overlay 构造的 exact
container environment，以及 verified `expected_image` provenance：

1. normal `prepare` preflight 的 active rollback baseline；
2. cutover failure 的 rollback recreate validation；
3. legacy bootstrap 的 hardened forward recreate validation；
4. 本 amendment 的 recovery observation；
5. normal cutover 的 candidate recreate validation。

任何第六条 caller、缺少 exact environment/Compose/image authority 的 caller，或只检查
label、hash、health 的 caller 都不在允许范围内。该开关只取消 requested hash 与 opaque
label 的相等要求，不取消 observed label 的格式/精确绑定，也不跳过上述 17-key Config、
66-key HostConfig、labels、process、mount、network、environment 与 image 验证。

## Recovery authority bindings

Recovery snapshot 和 completion receipt 必须把以下对象作为一个不可拆分的授权图绑定：

-   recovery bundle：path-independent bundle digest、release ID、revision、image tag、
    wrapper digest；
-   source bundle：bundle digest、release ID、revision、image tag 和 manifest-bound
    wrapper digest；
-   transition permit：fixed path、canonical document digest、run ID 和 source bundle
    binding；
-   bootstrap prepare receipt：fixed path、canonical digest、policy、run ID、legacy、
    hardened active、target bundle、baseline 与 frozen archive binding；
-   journal：fixed path、pre-completion canonical digest、exact state/phase/markers；
-   runtime：expected/current Flowise container ID、pre-recreate Flowise ID、sidecar IDs、
    active image identity、requested hash、observed label、semantic projection digest、
    full projection digest 和 HHH live-file hashes；
-   continuity：environment key set/HMAC、network identity、database fingerprint、
    persistent key continuity、container health 和三条 ping；
-   inventory：本 run 之外的 current/legacy journal inventory 与
    `unresolved_rollback_count=0`。

任何单项都不能独立授权 adoption。尤其不得把 “healthy”、`HHH`、label、container ID、
ping 或 `bootstrap-prepare-receipt.json` 的单独存在当作完成证明。

## Two-phase workflow

### Phase 1: `snapshot-bootstrap-recovery`

Canonical CLI:

```bash
sudo -n -- python3 /opt/flowise/candidates/git-RECOVERY_REVISION/scripts/flowise-production-release.py \
    snapshot-bootstrap-recovery \
    --bundle-dir /opt/flowise/candidates/git-RECOVERY_REVISION \
    --source-bundle-dir /opt/flowise/candidates/git-56196c3cb4a3123f657614274a2227071920ba01 \
    --run-id 20260728T171644Z-4914e862 \
    --transition-permit /opt/flowise/transition-permits/20260728T171644Z-4914e862.json \
    --transition-permit-sha256 sha256:a8afbf9ca32ef4cc9ead605a81f8624db1cf5538e0a23cccb2e46a3b76f0ada3 \
    --bootstrap-prepare-receipt-sha256 sha256:51402626a07b4b573e17b058e27a6e0df02dd7b34016df465f571ace949e6f2c \
    --expected-current-flowise-container-id 953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39 \
    --expected-observed-runtime-config-hash d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86
```

该命令必须：

-   verify recovery bundle 和 source bundle；
-   在 deploy lock 下执行两次完整观察，验证两次结果 canonical-equal；
-   验证 unique eligible pre-state 和全部 recovery authority bindings；
-   返回且只返回以下 15 个 secret-free summary fields：`status`, `run_id`,
    `recovery_snapshot_sha256`, `recovery_bundle_sha256`,
    `source_bundle_sha256`, `journal_pre_sha256`,
    `requested_compose_config_hash`, `observed_runtime_config_hash`,
    `semantic_runtime_projection_sha256`, `full_runtime_projection_sha256`,
    `production_runtime_write`, `control_artifact_write`, `database_write`,
    `provider_call`, `secret_value_output`；
-   明确返回 `control_artifact_write=false`, `production_runtime_write=false`,
    `database_write=false`, `provider_call=false`, `secret_value_output=false`。

每一次 observation 对 `.env.production`、`docker-compose.prod.yml` 与
`docker/seccomp/chromium.json` 各调用一次 secure `live_file`，分别要求 mode `0600`,
`0644`, `0644`。同一次 observation 中得到的三组 bytes 和 metadata 必须贯穿后续校验：

1. metadata exact-equal prepare receipt 的 `live_metadata`；
2. raw SHA-256 exact-equal prepare receipt 的 `hardened_active.files`，证明 `HHH`；
3. seccomp canonical digest 必须直接从同一份 `live_seccomp` bytes 计算；
4. 该 digest 必须显式传给 semantic runtime validator 与 full runtime projection；
5. digest 最终还必须等于 frozen
   `sha256:8bc9daff33eb5909c662dad46e9600c6cdfcf4327e84e30b94395176738d27cf`。

同一次 observation 不得为 canonical seccomp 或 runtime validation 再按 pathname 打开
live seccomp；这样 raw `HHH`、canonical seccomp 与 runtime authorization 才绑定到同一
次读取，而不是三个可能漂移的文件版本。第二次 observation 仍必须独立重读全部三份
live files，并与第一次 canonical-equal。

Snapshot stdout 不得包含 environment values、HMAC key、persistent key、database
password、raw Docker inspect、Compose/env/seccomp bytes、migration names、journal/permit/
receipt document 或 frozen archive metadata beyond approved digests/counts。该命令不得写
snapshot file、receipt、journal、permit 或 tombstone。

### Phase 2: `complete-bootstrap-recovery`

Canonical CLI 与 snapshot 完全相同，另加唯一 CAS 参数：

```bash
sudo -n -- python3 /opt/flowise/candidates/git-RECOVERY_REVISION/scripts/flowise-production-release.py \
    complete-bootstrap-recovery \
    --bundle-dir /opt/flowise/candidates/git-RECOVERY_REVISION \
    --source-bundle-dir /opt/flowise/candidates/git-56196c3cb4a3123f657614274a2227071920ba01 \
    --run-id 20260728T171644Z-4914e862 \
    --transition-permit /opt/flowise/transition-permits/20260728T171644Z-4914e862.json \
    --transition-permit-sha256 sha256:a8afbf9ca32ef4cc9ead605a81f8624db1cf5538e0a23cccb2e46a3b76f0ada3 \
    --bootstrap-prepare-receipt-sha256 sha256:51402626a07b4b573e17b058e27a6e0df02dd7b34016df465f571ace949e6f2c \
    --expected-current-flowise-container-id 953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39 \
    --expected-observed-runtime-config-hash d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86 \
    --expected-recovery-snapshot-sha256 sha256:RECOVERY_SNAPSHOT_DIGEST
```

Completion 必须在 deploy lock 下重新执行两次完整观察。两次观察必须相等，且重建的
snapshot digest 必须以 constant-time comparison 等于
`--expected-recovery-snapshot-sha256`。观察一与观察二之间、phase 1 与 phase 2 之间、
receipt write 前的最终 CAS 中出现任何 drift，均零写失败。

## Immutable receipt and terminal journal

### Completion receipt

成功时沿用 fixed path：

```text
/opt/flowise/deployments/20260728T171644Z-4914e862/bootstrap-complete-receipt.json
```

文件必须以 no-overwrite、atomic publish 写入 canonical JSON，并且是 root-owned mode
`0600`、`nlink=1` 的 non-symlink regular file。Publish 使用同目录 exclusive temporary
file 加 no-replace hard-link；destination 已存在时不得覆盖。Publish 后必须立即通过
`_read_existing_bootstrap_recovery_receipt` 重读，并同时比较 exact run directory、parsed
document、canonical bytes 与 SHA-256。任一不一致以
`BOOTSTRAP_RECOVERY_COMPLETE_RECEIPT_ROUNDTRIP_MISMATCH` fail closed，且不得推进
journal。它保持既有 terminal contract：

```text
schema_version=1
operation=bootstrap
state=complete_hardened_baseline
completion_mode=post_interrupt_verified_adoption
```

除既有 `bootstrap_prepare_receipt_sha256`, `permit_digest`, `target_bundle`,
`hardened_active`, `runtime`, `database`, continuity booleans、`provider_call=false` 和
`created_at` 外，receipt 必须包含以下 exact-shape `recovery` object：

```text
schema_version
completion_mode
run_id
recovery_bundle
source_bundle
authority
runtime
live_files
sidecars
network_identity
database
legacy_journal_inventory_sha256
current_journal_inventory_sha256
key_continuity_verified
runtime_pings_verified
production_runtime_write
database_write
provider_call
secret_value_output
recovery_snapshot_sha256
```

其中：

-   `recovery_bundle` 与 `source_bundle` 均精确包含 `bundle_digest`, `release_id`,
    `revision`, `image_tag`, `image_config_digest`；
-   `authority` 精确包含 `transition_permit_path`,
    `transition_permit_sha256`, `bootstrap_prepare_receipt_sha256`,
    `journal_pre_sha256`；
-   `runtime` 精确包含 `baseline_flowise_container_id`,
    `current_flowise_container_id`, `image_tag`, `image_config_digest`,
    `requested_compose_config_hash`, `observed_runtime_config_hash`,
    `seccomp_canonical_sha256`, `semantic_runtime_projection_sha256`,
    `full_runtime_projection_sha256`；
-   `live_files`, `sidecars`, `network_identity`, `database` 和两个 journal inventory
    digest 必须与 snapshot material 相同；四个 write/secret boundary boolean 必须全为
    `false`，continuity/ping boolean 必须全为 `true`。

不得在 receipt 中保存 environment value、HMAC key、persistent key 或 raw inspection
documents。

### Terminal journal

Receipt round-trip 验证成功后，wrapper 才把既有 journal 原子推进到：

```text
operation=bootstrap
state=complete_hardened_baseline
phase=complete
completion_mode=post_interrupt_verified_adoption
```

Journal 必须保留既有 bootstrap bindings 和 markers，并新增：

-   `bootstrap_complete_receipt_sha256`；
-   `recovery_authority` 必须是以下 exact 20-key object：

    ```text
    completion_mode
    recovery_bundle_digest
    source_bundle_digest
    journal_pre_sha256
    bootstrap_prepare_receipt_sha256
    transition_permit_path
    permit_digest
    recovery_snapshot_sha256
    baseline_flowise_container_id
    current_flowise_container_id
    requested_compose_config_hash
    observed_runtime_config_hash
    semantic_runtime_projection_sha256
    full_runtime_projection_sha256
    live_files_sha256
    sidecars_sha256
    network_identity_sha256
    database_sha256
    legacy_journal_inventory_sha256
    current_journal_inventory_sha256
    ```

-   `completion_mode=post_interrupt_verified_adoption`；
-   fresh `updated_at`。

Terminal key set 必须精确等于 interrupted journal 的 15 个 keys，加上
`bootstrap_complete_receipt_sha256`, `completion_mode`, `recovery_authority`；其中
`state`, `phase`, `updated_at` 是原 key 的受控值更新，不是额外 key。Unknown terminal
field 也必须在任何 write 前拒绝。

在 terminal journal write 前，wrapper 必须再次验证 complete-receipt-present exact
topology，重读 journal preimage，并要求 parsed object 与 canonical bytes 都精确等于内存
中的 authorized preimage；不匹配以
`BOOTSTRAP_RECOVERY_JOURNAL_PREIMAGE_CAS_MISMATCH` 停止。写后再重读 terminal journal，
要求 parsed object 和 canonical bytes round-trip 精确相等，并执行 exact terminal schema
与 receipt pointer 校验。

Terminal receipt validator 必须使用本文件中的 frozen incident constants 建立 static
authority，而不能让 receipt 自己授权自己。它逐层 exact-key 验证 source bundle、permit、
prepare receipt、target/hardened identity、Flowise 与 sidecar IDs、requested/observed
hashes、legacy image config、seccomp canonical digest、full runtime projection、59 条
migrations 与 ordered-name digest、live files、network、database、journal inventories、key
continuity、pings 和所有 zero-write/secret boundaries。只有这份 static authority 通过后，
existing receipt 才能用于 crash-resume 或 terminal replay。

Journal 不得伪造一次新的 recreate，也不得修改旧 permit、prepare receipt、frozen
archive、container label 或先前 marker。

### Crash consistency and idempotency

-   Snapshot 后、completion 前 crash：没有 control write；重新观察。旧 snapshot 只有在
    完整 CAS 仍相等时可继续，否则生成 fresh snapshot。
-   Completion receipt publish 期间 crash：可能没有 destination、可能已发布 exact
    destination，或遗留 exclusive temporary/hard-link evidence；任何额外 temporary、
    `nlink!=1` 或非 exact topology 都必须 fail closed，不能由 recovery 删除、覆盖或复用。
-   Receipt 已写、terminal journal 未写时 crash：重跑相同命令必须先验证 immutable
    receipt 的 exact schema/digest/bindings，再执行 fresh double observation；仅当 receipt、
    live state 和原 journal preimage authority 全部一致时，允许只补 terminal journal。
    不得重写 receipt，不得 recreate 或修改 live files。
-   Receipt 与 terminal journal 均已存在：重跑必须在 fresh validation 后返回同一
    terminal success，文件 bytes/digests 不变。
-   Journal 已 terminal 但 receipt 缺失、receipt digest 不符、出现第二份 receipt、
    receipt 已写但 runtime drift，均进入 manual intervention，零写停止。

首次完成与 receipt-written crash-resume 的 stdout 只包含以下 17 个 fields：

```text
status
completion_mode
run_id
bootstrap_complete_receipt_sha256
recovery_snapshot_sha256
current_flowise_container_id
requested_compose_config_hash
observed_runtime_config_hash
semantic_runtime_projection_sha256
full_runtime_projection_sha256
journal_repaired_after_receipt
idempotent_replay
production_runtime_write
control_artifact_write
database_write
provider_call
secret_value_output
```

这两个非 terminal-replay 分支固定 `idempotent_replay=false`,
`control_artifact_write=true`；fresh completion 的
`journal_repaired_after_receipt=false`，receipt-written crash-resume 为 `true`。其余四个
runtime/database/provider/secret boundary values 都为 `false`。

Terminal replay 只包含上述集合去掉 `journal_repaired_after_receipt` 后的 16 个 fields，
固定 `idempotent_replay=true`, `control_artifact_write=false`，其余四个 boundary values
仍为 `false`。stdout 不得输出 receipt/journal document 或 secret-bearing observation。

## Explicit write boundary

该 recovery 的允许写集合只有：

1. 首次成功时创建 `bootstrap-complete-receipt.json`；
2. 首次成功或 receipt-written crash resume 时原子更新同一个 `journal.json` 到 terminal。

禁止写入或调用：

-   Docker/Compose create、start、stop、restart、recreate、label update 或 image load；
-   live `.env.production`、`docker-compose.prod.yml`、seccomp profile 或其他 config；
-   PostgreSQL、migration、volume、persistent key、Nginx、network、firewall 或 proxy；
-   provider、SMTP、flow execution、upload 或业务数据；
-   permit、prepare receipt、frozen archive、旧 bundle、source journal history；
-   自动 fallback rollback。

不得重放旧 `bootstrap`，不得手工执行 `docker compose`，不得手工修改 journal/receipt/
permit/label，也不得为了让 hash 相等而改 label。

## Production execution template

下列模板只在 exact CI artifact、local verification、independent review 与 production
read-only preflight 全部通过后使用。占位符不是授权；执行前必须替换为 artifact 和
phase-1 stdout 中的 exact values。

```bash
set -euo pipefail

recovery_bundle=/opt/flowise/candidates/git-RECOVERY_REVISION
source_bundle=/opt/flowise/candidates/git-56196c3cb4a3123f657614274a2227071920ba01
recovery_run_id=20260728T171644Z-4914e862
transition_permit=/opt/flowise/transition-permits/20260728T171644Z-4914e862.json
transition_permit_sha256=sha256:a8afbf9ca32ef4cc9ead605a81f8624db1cf5538e0a23cccb2e46a3b76f0ada3
bootstrap_prepare_sha256=sha256:51402626a07b4b573e17b058e27a6e0df02dd7b34016df465f571ace949e6f2c
flowise_container_id=953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39
observed_runtime_config_hash=d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86

recovery_snapshot_json="$(sudo -n -- python3 \
    "$recovery_bundle/scripts/flowise-production-release.py" \
    snapshot-bootstrap-recovery \
    --bundle-dir "$recovery_bundle" \
    --source-bundle-dir "$source_bundle" \
    --run-id "$recovery_run_id" \
    --transition-permit "$transition_permit" \
    --transition-permit-sha256 "$transition_permit_sha256" \
    --bootstrap-prepare-receipt-sha256 "$bootstrap_prepare_sha256" \
    --expected-current-flowise-container-id "$flowise_container_id" \
    --expected-observed-runtime-config-hash "$observed_runtime_config_hash")"

recovery_snapshot_sha256="$(printf '%s\n' "$recovery_snapshot_json" | \
    python3 -c 'import json,sys
p=json.load(sys.stdin)
expected={"status":"bootstrap_recovery_snapshot_verified","production_runtime_write":False,"control_artifact_write":False,"database_write":False,"provider_call":False,"secret_value_output":False}
if any(p.get(k) != v for k,v in expected.items()): raise SystemExit("snapshot boundary mismatch")
print(p["recovery_snapshot_sha256"])')"

sudo -n -- python3 "$recovery_bundle/scripts/flowise-production-release.py" \
    complete-bootstrap-recovery \
    --bundle-dir "$recovery_bundle" \
    --source-bundle-dir "$source_bundle" \
    --run-id "$recovery_run_id" \
    --transition-permit "$transition_permit" \
    --transition-permit-sha256 "$transition_permit_sha256" \
    --bootstrap-prepare-receipt-sha256 "$bootstrap_prepare_sha256" \
    --expected-current-flowise-container-id "$flowise_container_id" \
    --expected-observed-runtime-config-hash "$observed_runtime_config_hash" \
    --expected-recovery-snapshot-sha256 "$recovery_snapshot_sha256"
```

不要把 stdout 或 shell trace 发送到公共日志。命令成功后立即执行 fresh read-only L3；
只有 L3 确认 terminal receipt/journal、三个容器 identity/health、HHH files、DB/key/network
continuity 和三条 ping 后，才解除 `prepare` gate。

## Test matrix

| Area                   | Required positive evidence                                                                            | Required zero-write negative evidence                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| exact scope            | exact run/phase/markers passes                                                                        | other run, phase, state, marker or second unresolved run rejects                           |
| run topology/lock      | exact 9-directory/11-file tree and pre-existing deploy lock pass                                      | extra path, symlink, unsafe metadata or missing lock rejects without creating lock state   |
| authority graph        | recovery/source bundles, permit, receipt and journal all bind                                         | path substitution, digest drift, unknown key, unsafe metadata or missing archive rejects   |
| runtime identity       | exact current Flowise ID, legacy image and fixed sidecars pass                                        | replaced Flowise, image drift, sidecar drift, stopped/unhealthy container rejects          |
| hash semantics         | requested hash + unequal opaque label + semantic projection passes                                    | requested hash drift, label drift or malformed label rejects                               |
| exact Docker surfaces  | 17-key Config, 66-key HostConfig, process and exact labels pass                                       | extra/missing field, type substitution or unapproved normalization rejects                 |
| security normalization | `no-new-privileges:true` and equivalent inline seccomp pass                                           | false/missing/duplicate option, invalid JSON or seccomp semantic drift rejects             |
| environment/key        | exact key set and HMAC, key continuity pass without value output                                      | extra/missing env key, HMAC drift or key drift rejects                                     |
| files                  | one-read raw/canonical seccomp chain and exact `HHH` bytes pass                                       | pathname reopen, `LLL`, partial prefixes, unknown bytes, symlink or metadata drift rejects |
| network/database/ping  | exact NetworkIDs, 59 migrations/digest and all pings pass                                             | attachment, database fingerprint or any ping drift rejects                                 |
| snapshot               | two observations equal, output is secret-free and write-free                                          | first/second observation drift or output leakage rejects                                   |
| completion CAS         | two fresh observations equal phase-1 digest                                                           | stale/wrong snapshot or final pre-write drift rejects with no files created                |
| write boundary         | only immutable completion receipt then terminal journal are written                                   | Docker, config, DB, provider or unrelated control write spy remains zero                   |
| crash after receipt    | exact receipt is reused and only journal is terminalized                                              | receipt collision/tamper or runtime drift rejects                                          |
| idempotency            | terminal rerun returns same receipt/journal digests                                                   | terminal receipt/journal mismatch rejects                                                  |
| existing recovery      | all unrelated interrupted states retain no-forward-resume behavior                                    | no global label/hash bypass and no automatic rollback fallback                             |
| integration            | Compose 2.27.1 reproduces opaque-label inequality and inline seccomp while semantic validation passes | mutated actual runtime is detected even when label remains unchanged                       |

Required verification sequence:

1. focused Python tests for all rows above;
2. full release test suite and static security verifier;
3. isolated Docker/Compose integration with zero fixture residue;
4. type/static checks and `git diff --check`;
5. independent code and security review on the exact diff;
6. exact-SHA Node CI, Docker CI and release-readiness artifact verification;
7. production read-only preflight before either recovery command;
8. fresh production L3 after terminalization and before `prepare`.

Frozen local verification evidence for wrapper SHA-256 prefix `32578dd`:

-   Node release tests: `75/75` passed;
-   Python release/integration tests: `137/137` passed;
-   static security verifier: `337/337` passed;
-   Pyright: `0 errors, 0 warnings`.

These are local implementation gates. They do not prove exact-SHA CI, a
self-bound deployable artifact, production recovery, a new-version deployment
or browser acceptance.

## TODO and gates

-   [x] Implement canonical security-option normalization and three-part runtime
        hash contract without weakening any other hardened field.
-   [x] Implement exact 17-key Config, 66-key HostConfig and five-path opaque-label
        environment/image authority.
-   [x] Implement exact-scope recovery observation, authority graph and double-read
        CAS.
-   [x] Implement single-read live-file bytes, exact run topology and existing-only
        lock behavior.
-   [x] Implement immutable receipt, journal-only completion, crash resume and
        terminal idempotency.
-   [x] Add the complete positive/negative test matrix and isolated Compose 2.27.1
        reproduction.
-   [x] Prove snapshot output contains no secret values or raw evidence documents.
-   [x] Pass the frozen local Node, Python/integration, security and Pyright gates
        listed above.
-   [x] Complete independent code/security review of the frozen local pair
        (`APPROVE`).
-   [ ] Pass PR and exact-commit CI for the release candidate.
-   [ ] Merge exact code and spec, then build a new self-bound CI artifact; no old
        bundle may execute the recovery commands.
-   [ ] Verify the new artifact locally and on the production candidate path.
-   [ ] Re-observe the unique eligible pre-state; any drift closes this amendment.
-   [ ] Run phase 1 and record only approved secret-free digests/counts.
-   [ ] Run phase 2 once against the exact snapshot digest; do not rerun old
        `bootstrap`.
-   [ ] Verify immutable completion receipt and terminal journal bytes, ownership,
        mode, link count and digest.
-   [ ] Pass fresh production L3; only then authorize a new `prepare` run ID.
-   [ ] Execute and accept the new-version production `prepare -> cutover` deployment.
-   [ ] Complete PC-first production browser interaction and end-to-end acceptance;
        mobile remains secondary.

## Acceptance

Recovery is accepted only when all of the following are true:

-   exact unique pre-state and all authority bindings pass twice in both phases;
-   phase 1 reports zero writes and no secret output;
-   phase 2 writes only one immutable completion receipt and one terminal journal
    update;
-   receipt and journal bind the new recovery bundle, old source bundle, permit,
    prepare receipt, journal preimage, container ID, opaque label, requested hash
    and complete runtime evidence;
-   runtime/config/database/provider writes remain zero;
-   receipt-written/journal-missing recovery and terminal idempotency are proven;
-   unrelated interrupted runs still follow the original no-forward-resume rule;
-   fresh production L3 passes before any `prepare` invocation.

## Failure handling and rollback boundary

在第一笔 control write 之前发生任何 failure，结果必须是零写；保留 stdout 中的
secret-free error code，重新调查或重新 snapshot，不自动 rollback。

在 completion receipt 或 terminal journal 已写后发生 failure，必须保留全部 evidence，
停止 `prepare/cutover`，不得删除、chmod、重写或伪造 receipt/journal，也不得自动 fallback
到 legacy。Receipt-written/journal-missing 只按本文件的 exact crash-resume 分支补写
journal。其他 post-control-write 异常进入 manual intervention；任何显式
`bootstrap-rollback` 都属于独立授权和独立验收，不由本 amendment 自动触发。
