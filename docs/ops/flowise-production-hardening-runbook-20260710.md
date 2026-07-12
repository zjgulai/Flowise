---
title: Flowise production hardening runbook
date: 2026-07-10
production_write: authorized_changes_recorded
provider_call: false
secrets_read: false
last_verified: 2026-07-12
---

# Flowise Production Hardening Runbook

This runbook is a gated execution checklist for the July 10 audit remediation. It is not an authorization record by itself.

## Boundaries

-   Do not print `.env.production` values or Docker env values. Env key names only.
-   Do not call Deepseek, Kimi, OpenAI, or other providers.
-   Do not restart, rebuild, or replace production containers without explicit owner authorization.
-   Keep local config validation, production read-only smoke, authorized deployment, and production acceptance as separate evidence layers.

## Verified Production Topology

-   Public 80/443 owner: Docker container `ai_video_nginx`.
-   Flowise Nginx upstream: `172.20.0.1:3000` on private Docker bridge `lighthouse_ai_video_net`.
-   Flowise production bind: `FLOWISE_BIND_IP=172.20.0.1`; never use `0.0.0.0`.
-   Compose also preserves `lighthouse_ai_video_net` through `FLOWISE_PROXY_NETWORK`.
-   A localhost bind is valid only for a host-native reverse proxy. With the current containerized proxy it causes external 502 even when the Flowise container is healthy.

### Fresh L3 Read-Only Observation (2026-07-12)

The following metadata was observed at `2026-07-12T10:51:01Z` on `VM-0-16-ubuntu` without reading Docker `Config.Env`, logs, databases, credentials, or secret files:

-   `flowise-chinese` was `running` and container-health `healthy`, with restart count `0`, restart policy `always`, and Node `v24.18.0`.
-   Its configured reference remained the legacy mutable `flowise-chinese:latest`; the observed image ID was `sha256:3c66e08b50562ab856328d669b611d000ccee6c9467f1560b7b8b4ba0b86fad9` on `linux/amd64`.
-   The Flowise image had no RepoDigest and no standard OCI revision/source/version labels. The image ID fingerprints the observed runtime only; it does not prove a link to a local Git revision or Task 6 manifest.
-   Docker inspect and the host listener table showed Flowise bound only to `172.20.0.1:3000`. PostgreSQL remained bound to `127.0.0.1:5432`; Nginx owned public `80/443` and was `running` and container-health `healthy`.
-   `/opt/flowise/backups` existed with `authorized-hardening-20260710092411` and `authorized-node24-20260710T053915Z`. The shared Nginx backup directory also existed with the recorded Flowise header-owner files.
-   Backup evidence is limited to `backup_state=exists_not_checksum_or_restore_verified`.

Container health is not login, workflow, provider, database, or restore acceptance. This observation preserved `production_write=false`, `provider_call=false`, `secrets_read=false`, and `production unchanged`.

## Flowise Edge Header Contract

-   Nginx owns `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, and `Referrer-Policy` on the public TLS edge.
-   Flowise owns `Content-Security-Policy` and keeps its four direct-deploy security headers as a fallback when no edge proxy is present.
-   The Flowise Nginx `location /` uses `proxy_hide_header` for the four upstream fallback headers, so each public response contains exactly one copy. This matches the Nginx directive semantics documented in the [official proxy module reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_hide_header).
-   Verify the deployed contract without credentials or provider calls:

```bash
bash scripts/verify-production-edge.sh https://flowise.lute-tlz-dddd.top
```

The shared proxy mounts `/opt/ai-video/deploy/lighthouse/nginx.conf` as a single read-only file. Replacing that host file with a new inode and sending `nginx -s reload` does not update the running bind mount. Use one of these safe paths:

1. Edit the existing host file in place, run container `nginx -t`, then reload.
2. For an atomically replaced file, validate a candidate with `nginx -t -c`, then run Compose `up -d --no-deps --force-recreate nginx` so the container mounts the new inode.

Because this Nginx serves multiple products, every Flowise edge change must also check `https://video.lute-tlz-dddd.top/health`. Never use `--remove-orphans` as part of this scoped operation.

Historical Batch 6A rollback evidence from the authorized 2026-07-10 change:

-   Original config SHA256: `befd714c5cfd521a69666fd3eb3f991fb98dd996dc3814fbb22862b9a83306ef`.
-   Deployed config SHA256: `7a67c22f303dbe0b0c6a80c8839b25d6d5d01bb8e62bbaec0df0326c0f802b23`.
-   Backup: `/opt/ai-video/deploy/lighthouse/backups/nginx.conf.20260710T080129Z.flowise-header-owner-recreate`.

These hashes and the backup path are historical rollback evidence only. They are not fresh checksum verification and do not establish that a restore has been exercised.

## Preflight: Read-Only

Run the Task 6 source and immutable-release contract checks from the reviewed repository state:

```bash
bash scripts/verify-release-source.sh
pnpm test:release
bash scripts/verify-security.sh
docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet
```

Before deployment, run the value-safe env preflight against the actual production env file. It validates the required values without printing them, rejects `latest`, requires `FLOWISE_IMAGE` to use a unique Git-derived release tag, and requires a separate explicit non-`latest` `POSTGRES_IMAGE`. The same Flowise tag must be supplied to manifest verification:

```bash
bash scripts/verify-security.sh /path/to/.env.production
```

For an offline image release, verify the prebuilt archive and manifest from an isolated clean checkout at the manifest revision before transferring or loading anything:

```bash
node scripts/release-manifest.mjs verify \
  --manifest /path/to/release-manifest.json \
  --image-tag flowise-chinese:git-<40-lowercase-git-sha> \
  --image-config-digest sha256:<64-lowercase-hex> \
  --archive /path/to/flowise-image.tar.gz \
  --require-clean
```

This CLI verifies canonical manifest bytes, current source/input hashes, the archive SHA-256/byte count, and equality with the caller-supplied image config digest. It does **not** parse the archive, load an image, inspect the real image config, or inspect OCI labels/platform. Passing the same incorrect but well-formed config digest to both manifest generation and verification is not artifact proof.

After the CLI check, load the archive only into an isolated local Docker environment and compare the loaded artifact itself. Do not perform this load on production during read-only preflight.

```bash
image_ref='flowise-chinese:git-<40-lowercase-git-sha>'
revision='<40-lowercase-git-sha>'
expected_config_digest='sha256:<64-lowercase-hex>'
expected_source='https://reviewed.example/repository.git'

docker load --input /path/to/flowise-image.tar.gz
test "$(docker image inspect --format '{{.Id}}' "$image_ref")" = "$expected_config_digest"
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image_ref")" = 'linux/amd64'
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image_ref")" = "$expected_source"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_ref")" = "$revision"
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image_ref")" = "git-$revision"
test -n "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.created"}}' "$image_ref")"
```

The image ID must equal the manifest config digest; the loaded tag, platform, source, revision, and version must match the manifest/source contract. Manifest v1 does not bind the OCI `created` label to a separate expected field, so this check can require and record that label but cannot claim the CLI cryptographically compared its value. Keep `actual_archive_manifest_verified=false` until the CLI check and this real load/inspect layer both pass. An image ID, archive checksum, tag, or static Dockerfile label check alone is not an equivalent substitute.

Check required env key names before any restart. Do not print or inspect values.

```bash
ssh tencent-lighthouse 'cd /opt/flowise && for key in FLOWISE_IMAGE POSTGRES_IMAGE POSTGRES_PASSWORD JWT_AUTH_TOKEN_SECRET JWT_REFRESH_TOKEN_SECRET EXPRESS_SESSION_SECRET TOKEN_HASH_SECRET; do grep -q "^${key}=" .env.production || exit 1; done'
```

For `IFRAME_ORIGINS`, Compose strips ordinary shell quotes from `.env` values. Use this exact value for same-origin framing:

```bash
IFRAME_ORIGINS="'self'"
```

For `CUSTOM_MCP_ALLOWED_COMMANDS`, an explicit empty value blocks all stdio MCP commands. Add command names only after reviewing each production MCP server definition.

```bash
CUSTOM_MCP_ALLOWED_COMMANDS=
```

```bash
ssh tencent-lighthouse 'date -Is; docker ps --filter name=flowise; docker inspect flowise-chinese --format "{{json .NetworkSettings.Ports}}"; docker exec flowise-chinese node -v'
curl -fsS https://flowise.lute-tlz-dddd.top/api/v1/ping
curl -i https://flowise.lute-tlz-dddd.top/api/v1/auth/resolve
curl -m 5 http://flowise.lute-tlz-dddd.top:3000/api/v1/ping
```

Historical expectations before the Node 24 and private-bind hardening:

-   HTTPS `/api/v1/ping` returns `pong`.
-   Direct IP `3000` may still return `pong` until the port binding or firewall is fixed.
-   `GET /api/v1/auth/resolve` may return `500` until the new image is deployed.

## Authorized Deployment Steps

Only run this section after explicit owner approval for production writes.

1. Back up compose/env and record sanitized container/image metadata. Preserve the already verified immutable rollback reference, archive, and manifest; do not create or depend on a `latest` rollback tag.

```bash
ssh tencent-lighthouse 'cd /opt/flowise && backup=/opt/flowise/backups/authorized-node24-$(date -u +%Y%m%dT%H%M%SZ) && umask 077 && mkdir -p "$backup" && cp -p docker-compose.prod.yml .env.production "$backup"'
```

1. Build and validate `linux/amd64` locally. The dependency install must remain `pnpm install --frozen-lockfile`; do not add a fallback.

1. Stream `docker save | gzip` directly to `/opt/flowise/releases/` while calculating local SHA256. Recalculate SHA256 remotely and require an exact match before `docker load`.

1. Validate the private proxy route before cutover with an isolated candidate port. From `ai_video_nginx`, the candidate `/api/v1/ping` must return `pong` through the `172.20.0.1` gateway.

1. Validate Compose config without printing secrets.

```bash
ssh ubuntu@101.34.52.232 'cd /opt/flowise && docker compose --env-file .env.production -f docker-compose.prod.yml config --quiet'
```

1. Apply only reviewed non-secret keys. For the current proxy topology include:

```bash
FLOWISE_BIND_IP=172.20.0.1
FLOWISE_PROXY_NETWORK=lighthouse_ai_video_net
```

1. Load/tag the validated image and restart only Flowise without building or restarting PostgreSQL.

```bash
ssh tencent-lighthouse 'cd /opt/flowise && docker compose --env-file .env.production -f docker-compose.prod.yml up -d --no-deps --no-build flowise'
```

1. Confirm runtime state.

```bash
ssh tencent-lighthouse 'docker ps --filter name=flowise; docker inspect flowise-chinese --format "{{json .NetworkSettings.Ports}}"; docker exec flowise-chinese node -v'
```

Do not print unrestricted production logs. Count only the expected error classes unless a failure requires a separately redacted diagnostic capture.

## Acceptance Checks

```bash
curl -fsS https://flowise.lute-tlz-dddd.top/api/v1/ping
curl -i https://flowise.lute-tlz-dddd.top/api/v1/auth/resolve
curl -m 5 http://flowise.lute-tlz-dddd.top:3000/api/v1/ping
ssh tencent-lighthouse 'curl -fsS http://172.20.0.1:3000/api/v1/ping && docker exec ai_video_nginx wget -qO- http://172.20.0.1:3000/api/v1/ping'
```

Pass criteria:

-   HTTPS `/api/v1/ping` returns `pong`.
-   Direct IP `3000` is unreachable or refused.
-   `docker inspect` shows only `172.20.0.1:3000`, not `0.0.0.0` or `::`.
-   Both gateway and proxy-container upstream checks return `pong`.
-   `GET /api/v1/auth/resolve` returns `405 Method Not Allowed`, not `500`.
-   Browser console on `/signin` has no CSP-blocked Google Fonts or Rewardful messages.
-   Container logs have no Node engine warning and no AppleDouble `._*` permission-denied noise.

## Firewall Fallback

This is not a standing deployment step and must not be run merely because an image build is blocked. The 2026-07-12 L3 observation found the private `172.20.0.1:3000` bind. Apply a host firewall guard in Docker's `DOCKER-USER` chain only when a fresh L3 regression check proves public `3000` exposure and the owner separately authorizes the production firewall write:

```bash
ssh ubuntu@101.34.52.232 'sudo iptables-save > /opt/flowise/backups/authorized-hardening-YYYYMMDDHHMMSS/iptables-before-flowise-3000.rules'
ssh ubuntu@101.34.52.232 'sudo iptables -C DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP 2>/dev/null || sudo iptables -I DOCKER-USER 1 -i eth0 -p tcp --dport 3000 -j DROP'
```

Persist it with a minimal systemd oneshot service:

```bash
sudo systemctl enable --now flowise-firewall.service
systemctl is-active flowise-firewall.service
sudo iptables -S DOCKER-USER
```

Acceptance for the fallback:

-   `curl -fsS https://flowise.lute-tlz-dddd.top/api/v1/ping` returns `pong`.
-   `curl -m 5 http://101.34.52.232:3000/api/v1/ping` times out or fails.
-   `curl http://172.20.0.1:3000/api/v1/ping` on the server still returns `pong`.

## Rollback

Only run rollback after explicit owner approval.

Future rollback checkpoints must retain a prevalidated immutable rollback image reference, its canonical manifest, the matching offline archive, and an env/Compose configuration that names that exact reference. From an isolated clean checkout at the rollback revision, verify the rollback manifest and archive with `release-manifest.mjs verify --require-clean`, then run the env and Compose preflights above. Only after those checks pass may the authorized rollback restore the reviewed configuration and recreate only Flowise with `--no-deps --no-build`.

Do not tag or select `latest` during rollback. Do not generate a manifest after an incident and treat it as pre-cutover rollback proof.

The first migration from the currently observed legacy `flowise-chinese:latest` deployment has no OCI revision label, RepoDigest, or Task 6 manifest. It therefore requires a separately reviewed and explicitly authorized transitional rollback plan before cutover; the historical backup directory and current image ID alone are not sufficient immutable rollback evidence.

After any authorized rollback, rerun the HTTPS edge checks, the external direct-`3000` probe, Docker bind/health inspection, and Node version check. If the rollback reintroduces public `3000`, stop and obtain separate authorization before applying the firewall fallback.

Firewall fallback rollback:

```bash
ssh ubuntu@101.34.52.232 'sudo systemctl disable --now flowise-firewall.service || true; sudo iptables -D DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP || true'
```
