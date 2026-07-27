# Flowise Legacy Runtime Hardening Transition

Status: implementation complete; production execution pending
Scope: one-time transition from the verified legacy `c947339b...` runtime to
the repository hardening contract before the next application release.

## Decision

The current production runtime is healthy, but it predates the hardened
Compose contract. The normal release wrapper intentionally supports only
`hardened -> hardened` transitions, so the current `legacy -> hardened`
transition must be represented explicitly.

The approved release sequence is:

1. Snapshot the exact legacy state, then issue and verify a one-time transition
   permit against that snapshot and the new application candidate deployment
   bundle.
2. Freeze the legacy image and live configuration before the first live write.
3. Recreate only Flowise with the same `c947339b...` image and the hardened
   runtime configuration.
4. Verify the hardened baseline and produce immutable receipts.
5. Run a fresh production L3 check.
6. Use the existing strict `prepare -> cutover` path to consume the image
   archive from that same new application candidate bundle.

Manual Docker or Compose hardening is not an accepted alternative.

## Current evidence boundary

The read-only L3 snapshot observed:

-   active revision:
    `c947339b7033c930be37591918f59c7725800bbe`
-   active image config:
    `sha256:a8f38dca92292711a781432dc7700218273eececa331446d0678251cf6fe2067`
-   live Compose file SHA-256:
    `sha256:58c8e22c41730697dfdcedbfeb752db0ebc3dbc907d88d1bf5437ae6d837cf92`
-   live environment file SHA-256:
    `sha256:eb57ffc8d1fef179bde0bce708d86f402ba28271577e6d434e323a5d0094e5b8`
-   live seccomp profile: absent
-   runtime Compose label:
    `0f71f7b9d64eea1c53b7f71a9c468409ad451dbb4d1d37f41c1312f7774c9863`
-   current Compose calculation:
    `d9136d2d...31512`
-   database migrations: 59, ordered-name digest
    `sha256:a30f16eb1af7cb810e97cd45df464e97255d9bc8a2d9aaabbac8787b4396b5b6`

The historical candidate Compose bytes are identical to the current live
Compose bytes. A secret-free semantic projection matches the running
container except that Compose omits `user` while the image resolves it to
`node`. The old runtime label cannot be reproduced with the current Compose
2.27.1 calculation, so that mismatch may be accepted only by an exact permit
that binds both hashes and the full semantic projection.

This snapshot is evidence input, not a reusable authorization. All values must
be refreshed immediately before the transition.

The legacy journal inventory contains 18 run directories and 41 control JSON
files. The exact observed top-level key signatures are:

-   1 `candidate-manifest-attempt.json`: `boundaries`, `created_at`, `image`,
    `inputs`, `release_id`, `schema_version`, `source`, `toolchain`;
-   3 `compose-cutover-status.json`: `candidate_compose_sha256`,
    `live_compose_sha256`, `phase`, `production_write`, `provider_call`,
    `release_id`, `rollback_compose_sha256`, `run_id`, `state`, `updated_at`;
-   15 `cutover-status.json`: `after`, `before`, `database_before`, `effects`,
    `key_continuity`, `migration_up_executed`, `migrations_unchanged`,
    `operator_database_write`, `phase`, `production_database_write`,
    `provider_call`, `release_id`, `run_id`, `state`, `updated_at`;
-   4 `post-acceptance-rollback-*.json`: `after`, `before`,
    `migration_up_executed`, `migrations_unchanged`, `operator_database_write`,
    `production_database_write`, `provider_call`, `run_id`, `state`,
    `updated_at`;
-   15 successful `prepare-status.json`: `after`, `artifacts`, `before`,
    `candidate_image_id`, `candidate_smoke`, `container_recreated`, `database`,
    `key_continuity`, `phase`, `production_database_write`, `provider_call`,
    `release_id`, `rollback_smoke`, `run_id`, `state`, `updated_at`;
-   3 failed `prepare-status.json`, each matching one of the three exact observed
    shapes: (`artifacts`, `before`, `candidate_image_id`, `database`, `error`,
    `phase`, `release_id`, `run_id`, `state`, `updated_at`), (`artifacts`,
    `before`, `database`, `error`, `phase`, `release_id`, `run_id`, `state`,
    `updated_at`), or (`error`, `phase`, `release_id`, `run_id`, `state`,
    `updated_at`).

Every control file was observed as a root-owned mode `0600` regular file with
one hard link, and every containing run directory as root-owned mode `0700`.
These shapes and counts describe the observed inventory only. The permit must
also bind a canonical whole-document inventory digest so a structurally valid
but modified history still fails closed.

## Transition permit

The transition command must require a canonical JSON permit that is:

-   a root-owned, mode `0600`, non-symlink regular file with one hard link;
-   supplied with its exact SHA-256 digest;
-   bound to one `run_id`;
-   bound to the exact target deployment bundle digest, revision and image tag;
-   separately bound to the active legacy image tag, revision and image config
    digest;
-   bound to all three managed container IDs;
-   bound to the exact internal and reverse-proxy network names and Docker
    NetworkIDs; the Flowise attachment must match PostgreSQL on the internal
    network and Nginx on the reverse-proxy network;
-   bound to the runtime label hash and current live Compose calculation;
-   bound to live environment, Compose and seccomp state digests;
-   bound to a secret-free runtime projection digest;
-   bound to the complete sorted runtime environment key set and an HMAC-SHA256
    of the canonical full image-plus-Compose environment. The persistent
    32-byte Flowise key is the HMAC key; no environment value or HMAC key may be
    written to the permit, receipt, journal or command output;
-   bound to the database migration count and ordered-name digest.
-   bound to an allowlisted, read-only inventory of legacy release-scoped
    journals under `/opt/flowise/releases/git-*/deployments/`, with zero
    unresolved rollback states. The exact permit and receipt object is named
    `legacy_journal_inventory` and contains sorted unique `root_paths`,
    `root_count`, `run_count`, `control_count`,
    `canonical_inventory_sha256`, and `unresolved_rollback_count`.

Unknown keys, missing keys, non-canonical JSON, a reused run, or any observed
state drift must fail before a production write.

### Supported snapshot and issuance workflow

Operators must not construct the permit by hand. The production wrapper owns a
two-command, fail-closed workflow:

```bash
sudo -n -- python3 scripts/flowise-production-release.py snapshot-transition \
    --bundle-dir /root/flowise-release \
    --run-id 20260727T120000Z-0123abcd

sudo -n -- python3 scripts/flowise-production-release.py issue-transition-permit \
    --bundle-dir /root/flowise-release \
    --run-id 20260727T120000Z-0123abcd \
    --expected-snapshot-sha256 sha256:<snapshot-digest>
```

`snapshot-transition` is read-only. It verifies the exact bundle and observes
the complete legacy runtime, database and journal state twice under the deploy
lock. Its output is a strict secret-free summary and a digest of the full
permit candidate plus the current-journal inventory; it never returns Docker
inspect documents, environment values, Compose bytes, the persistent key,
migration names or journal documents.

`issue-transition-permit` repeats the complete observation. It writes nothing
unless the new snapshot digest equals `--expected-snapshot-sha256`. The permit
is published exactly once at
`/opt/flowise/transition-permits/<run_id>.json` beneath a root-owned mode
`0700` non-symlink directory. The file is canonical JSON, root-owned mode
`0600`, has one hard link, cannot replace an existing path, and is immediately
round-trip verified by the existing permit consumer. Issuance writes only this
control artifact; it does not recover journals, load an image, alter live
configuration, recreate a container or write the database.

Treat every failed `issue-transition-permit` attempt as permanently consuming
its `run_id`. If failure occurs after publication begins, the wrapper preserves
the fixed destination as a durable, unreadable mode `000` tombstone; the
no-overwrite contract then rejects reuse with
`TRANSITION_PERMIT_ALREADY_EXISTS`. Do not chmod, delete or reuse that path.
Generate a new `run_id`, run a fresh `snapshot-transition`, and issue against
the new exact snapshot digest.

The resulting `permit_sha256` and fixed `permit_path` are the only values passed
to `bootstrap --transition-permit ... --transition-permit-sha256 ...`.
Bootstrap still performs its own fresh preflight and final pre-write CAS; permit
issuance does not weaken or bypass those checks.

## Bootstrap state machine

### Pre-write

Before the first live write, the wrapper must:

-   verify the deployment bundle and permit;
-   verify container health, active image identity, sidecar identity, key
    continuity, read-only database fingerprint and all three ping paths;
-   verify both the current deployment journal root and the legacy
    release-scoped journal inventory contain no unresolved, unknown or unsafe
    rollback state;
-   prove the legacy runtime matches the permitted semantic projection;
-   prove the runtime has no extra or missing environment entries and that both
    network attachments match the permit-bound sidecar NetworkIDs;
-   freeze and verify the active image archive;
-   freeze the legacy environment, Compose and seccomp-absence state;
-   stage the hardened Compose/seccomp configuration while retaining the active
    `c947339b...` image tag;
-   prove the staged configuration is identical to the bundle candidate except
    for the image tag;
-   prove the bootstrap did not load or start the target candidate image archive;
-   create every run, role, `docker` and `docker/seccomp` directory as a
    root-owned, mode `0700`, non-symlink directory and revalidate the full path
    chain before every staged or archived read;
-   write an immutable bootstrap-prepare receipt and an in-progress journal.

### Forward transition

The only allowed live write order is:

1. seccomp profile;
2. Compose file;
3. environment file;
4. recreate only the `flowise` service using `--no-deps`, `--no-build`,
   `--pull never`, `--force-recreate` and `--wait`.

Success requires:

-   the image revision and config digest remain `c947339b...`;
-   the complete hardened runtime contract passes;
-   PostgreSQL and Nginx identities remain unchanged;
-   the persistent key remains continuous without exposing its value;
-   the database fingerprint is unchanged;
-   private, proxy and public ping paths pass;
-   live file hashes match the staged hardened files.

The terminal receipt status is `complete_hardened_baseline`.

### Rollback and recovery

Any failure or interruption after the first live write must enter one
receipt-bound, idempotent `legacy_frozen_v1` restoration transaction. It must
not call the normal hardened rollback validator.

The live file classifier uses the ordered tuple `(seccomp, Compose,
environment)`, with `L` for the frozen legacy bytes and `H` for the staged
hardened bytes. Exactly six prefixes are recoverable: `LLL`, `HLL`, `HHL`,
`HHH`, `LHH` and `LLH`. The impossible mixed states `LHL` and `HLH`, unknown
bytes, candidate/unknown images, unbound journals and mismatched receipt pairs
must be rejected before a write.

Recovery must persist `state=rolling_back`, the exact file step and a
digest-bound recreate-window marker. The marker binds the operation, run,
bootstrap-prepare receipt, pre-recreate Flowise container ID and, for explicit
rollback, the bootstrap-complete receipt. A missing Flowise container is
recoverable only inside that authenticated recreate window. PostgreSQL and
Nginx must remain present, healthy and identical throughout.

If no replacement container has yet been observed, the same transaction may
resume the remaining file steps and its one Flowise recreate. If a new
container ID has already been observed, recovery may only finish validation
and write the terminal receipt; it must never recreate again. A new container
that is stopped, unhealthy or fails ping enters terminal manual intervention
rather than causing a second recreate. A caught restore failure likewise
enters terminal manual intervention and is never retried automatically.

The exact legacy image, seccomp absence, Compose and environment bytes,
complete environment binding, network identity, database fingerprint,
persistent key, sidecar identities and all three ping paths must pass before
terminalization. If the live runtime is already the exact complete legacy
state after a crash, recovery writes only the missing immutable receipt and
terminal journal state.

An explicit bootstrap rollback remains available after successful bootstrap
and before application cutover. Fresh and resumed invocations must bind the
exact journal policy, permit, target bundle, active legacy release, prepare
receipt and complete receipt. A stopped or unhealthy Flowise may be restored;
missing Flowise requires the authenticated recreate window. Receipt or journal
drift is always a zero-write rejection.

### Isolated Docker evidence

The repository integration harness uses throwaway local images, containers,
volumes and an internal network. It exercises the production wrapper's real
Compose render/hash/recreate/inspect and live-file install/remove helpers. It
must prove the legacy image remains active, the target archive is neither
loaded nor started, hardening materializes, both rollback paths restore the
legacy files, only Flowise is recreated, sidecar IDs stay fixed and cleanup
leaves zero fixture residue. Root ownership, canonical permits, immutable
receipts, database fingerprints and public ping gates remain covered by the
focused wrapper tests and require fresh production L3 evidence before a live
write.

## Forbidden operations

-   global or implicit `allow legacy` behavior;
-   ignoring Compose config hashes outside the exact transition permit;
-   changing the application image during the bootstrap;
-   registry pull/push, mutable tags or build fallback;
-   PostgreSQL or Nginx recreation;
-   database migration or write;
-   persistent-key generation, rotation or value output;
-   provider, SMTP, flow execution, upload or business-data mutation;
-   firewall, proxy or unrelated host changes;
-   deleting or overwriting receipts, journals or rollback archives.
-   treating the absence of `/opt/flowise/deployments` as proof that legacy
    release-scoped journals are resolved.

## Acceptance checklist

-   [ ] Default hardened release behavior is unchanged.
-   [ ] Missing, malformed, unsafe, stale or tampered permits fail before write.
-   [ ] Snapshot and issuance use separate full observations; a stale or wrong
        snapshot digest produces no permit file.
-   [ ] Permit publication is fixed-path, root-only, atomic, no-overwrite and
        round-trip compatible with the unchanged bootstrap consumer.
-   [ ] Snapshot, issuance output and failure paths contain no environment
        values, persistent key, database password or raw Docker inspection.
-   [ ] Extra legacy Compose/runtime differences fail before write.
-   [ ] Bootstrap success produces immutable prepare and completion receipts.
-   [ ] Forward failure completes one idempotent restoration transaction without
        a zero-recreate or double-recreate crash window.
-   [ ] Pre-write and post-write interruption recovery are covered.
-   [ ] Seccomp absence is restored safely on legacy rollback.
-   [ ] All eight live-file combinations are tested: six legal prefixes and two
        zero-write illegal states.
-   [ ] Missing, stopped and unhealthy Flowise recovery is tested without
        weakening PostgreSQL or Nginx identity and health.
-   [ ] The complete runtime environment HMAC/key set and both sidecar network
        identities are permit- and receipt-bound without exposing values.
-   [ ] Manual bootstrap rollback is exact-journal/receipt-bound and resumable
        only within the same restoration transaction.
-   [ ] A successful bootstrap satisfies the unmodified strict prepare preflight.
-   [ ] Unit tests, an isolated Docker/Compose integration test, security
        verification, Node CI and Docker CI pass on an exact commit SHA.
-   [ ] Buildx and BuildKit versions are pinned and evidence-bound; both Alpine
        stages match their reviewed, exact linux/amd64 transitive package locks.
-   [ ] A new main merge SHA produces and passes release readiness.
-   [ ] Fresh production L3 passes before and after the bootstrap.
-   [ ] The normal application `prepare -> cutover` receipts bind the hardened
        baseline and final candidate.
