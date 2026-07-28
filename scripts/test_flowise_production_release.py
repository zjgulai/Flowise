import copy
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


MODULE_PATH = Path(__file__).with_name("flowise-production-release.py")
SPEC = importlib.util.spec_from_file_location("flowise_production_release", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("production release wrapper module could not be loaded")
RELEASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RELEASE
SPEC.loader.exec_module(RELEASE)


REVISION = "a" * 40
LEGACY_REVISION = RELEASE.LEGACY_BOOTSTRAP_REVISION
ROLLBACK_REVISION = "b" * 40
CANDIDATE_TAG = f"flowise-chinese:git-{REVISION}"
LEGACY_TAG = f"flowise-chinese:git-{LEGACY_REVISION}"
ROLLBACK_TAG = f"flowise-chinese:git-{ROLLBACK_REVISION}"
CANDIDATE_DIGEST = "sha256:" + "1" * 64
LEGACY_DIGEST = "sha256:" + "8" * 64
ROLLBACK_DIGEST = "sha256:" + "2" * 64
LEGACY_SOURCE = "https://github.com/zjgulai/Flowise.git"
LEGACY_CREATED_AT = "2026-07-23T06:09:35Z"
RUN_ID = "20260727T120000Z-deadbeef"
RECOVERY_RUN_ID = "20260728T171644Z-4914e862"
RECOVERY_FLOWISE_ID = "953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39"
FLOWISE_ID = "3" * 64
POSTGRES_ID = "4" * 64
NGINX_ID = "5" * 64
FLOWISE_NETWORK_ID = "6" * 64
PROXY_NETWORK_ID = "7" * 64
TEST_KEY = b"k" * 32
REQUESTED_HARDENED_CONFIG_HASH = "8642827174f0ca74dd1a6fc5a8334f116eafe97f9386c1610d5719555e9d3200"
OBSERVED_HARDENED_CONFIG_HASH = "d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86"
TEST_SECCOMP_DOCUMENT = {"defaultAction": "SCMP_ACT_ERRNO"}
TEST_SECCOMP_INLINE = json.dumps(TEST_SECCOMP_DOCUMENT, sort_keys=True, separators=(",", ":"))
TEST_SECCOMP_DIGEST = RELEASE.sha256_bytes(RELEASE.canonical_json(TEST_SECCOMP_DOCUMENT))
ORIGINAL_LIVE_SECCOMP_CANONICAL_DIGEST = RELEASE._live_seccomp_canonical_digest
LEGACY_ENVIRONMENT = {"FLOWISE_SECRETKEY_OVERWRITE": TEST_KEY.decode()}
HARDENED_ENVIRONMENT = {
    "FLOWISE_SECRETKEY_OVERWRITE": TEST_KEY.decode(),
    "ADMIN_ONLY_MODE": "true",
    "PUBLIC_LOGIN_ENABLED": "true",
    "SECURE_COOKIES": "true",
    "HTTP_SECURITY_CHECK": "true",
    "PATH_TRAVERSAL_SAFETY": "true",
    "CUSTOM_MCP_SECURITY_CHECK": "true",
    "OAUTH2_SECURITY_CHECK": "true",
    "DATABASE_TYPE": "postgres",
    "DATABASE_HOST": "postgres",
    "DATABASE_PORT": "5432",
    "DATABASE_NAME": "flowise",
    "DATABASE_USER": "flowise",
    "DATABASE_PASSWORD": "test-password",
    "DATABASE_PATH": "/usr/src/flowise/.flowise",
    "DATABASE_SSL": "false",
    "DATABASE_REJECT_UNAUTHORIZED": "true",
    "CORS_ALLOW_CREDENTIALS": "false",
    "DISABLE_FLOWISE_TELEMETRY": "true",
    "SHOW_COMMUNITY_NODES": "false",
    "ALLOW_BUILTIN_DEP": "false",
}


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


def recovery_topology_stub(receipt_present):
    """Model only the receipt-state branch while topology itself is tested separately."""

    def validate(_run_dir, *, complete_receipt):
        present = bool(receipt_present() if callable(receipt_present) else receipt_present)
        if complete_receipt == "absent" and present:
            raise RELEASE.DeployError("BOOTSTRAP_RECOVERY_TOPOLOGY_COMPLETE_RECEIPT_UNEXPECTED")
        if complete_receipt == "present" and not present:
            raise RELEASE.DeployError("BOOTSTRAP_RECOVERY_TOPOLOGY_COMPLETE_RECEIPT_MISSING")
        return present

    return validate


def write_config_archive(
    archive_path,
    *,
    image_tag,
    config,
    config_name_style="classic",
    config_name=None,
    config_copies=1,
    config_is_file=True,
    config_member_type=None,
    config_pax_headers=None,
    manifest_member_type=None,
    manifest_is_pax_sparse=False,
    include_alternate_alias=False,
):
    config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
    config_hex = hashlib.sha256(config_bytes).hexdigest()
    if config_name is None:
        config_name = (
            f"blobs/sha256/{config_hex}" if config_name_style == "containerd" else f"{config_hex}.json"
        )
    manifest_bytes = json.dumps(
        [{"Config": config_name, "RepoTags": [image_tag], "Layers": []}],
        separators=(",", ":"),
    ).encode()
    with tarfile.open(archive_path, "w:gz") as archive:
        manifest_info = tarfile.TarInfo("manifest.json")
        if manifest_member_type is not None:
            manifest_info.type = manifest_member_type
        if manifest_is_pax_sparse:
            manifest_info.pax_headers = {
                "GNU.sparse.map": f"0,{len(manifest_bytes)}",
                "GNU.sparse.realsize": str(len(manifest_bytes)),
            }
        manifest_info.size = len(manifest_bytes)
        archive.addfile(manifest_info, io.BytesIO(manifest_bytes))
        config_names = [config_name] * config_copies
        if include_alternate_alias:
            alternate_name = (
                f"{config_hex}.json" if config_name.startswith("blobs/sha256/") else f"blobs/sha256/{config_hex}"
            )
            config_names.append(alternate_name)
        for member_name in config_names:
            config_info = tarfile.TarInfo(member_name)
            if config_member_type is not None:
                config_info.type = config_member_type
            if config_pax_headers is not None:
                config_info.pax_headers = dict(config_pax_headers)
            if config_is_file:
                config_info.size = len(config_bytes)
                archive.addfile(config_info, io.BytesIO(config_bytes))
            else:
                config_info.type = tarfile.SYMTYPE
                config_info.linkname = "manifest.json"
                archive.addfile(config_info)
    return f"sha256:{config_hex}"


def environment_binding(environment):
    return RELEASE.runtime_environment_binding(environment, TEST_KEY)


def network_identity():
    return {
        "flowise_internal": {
            "name": RELEASE.EXPECTED_TOP_LEVEL_NETWORKS["flowise_network"]["name"],
            "network_id": FLOWISE_NETWORK_ID,
        },
        "reverse_proxy": {
            "name": RELEASE.EXPECTED_TOP_LEVEL_NETWORKS["reverse_proxy_network"]["name"],
            "network_id": PROXY_NETWORK_ID,
        },
    }


def runtime_image_authority(image_tag, image_digest, image_environment=None):
    revision = image_tag.removeprefix("flowise-chinese:git-")
    return {
        "image_tag": image_tag,
        "image_config_digest": image_digest,
        "revision": revision,
        "release_id": f"git-{revision}",
        "repository_url": LEGACY_SOURCE,
        "created_at": LEGACY_CREATED_AT,
        "image_environment": copy.deepcopy(image_environment or {}),
    }


class BundleFixture:
    def __init__(self, root):
        self.root = Path(root)
        for directory in (self.root / "docker/seccomp", self.root / "scripts"):
            directory.mkdir(parents=True)
        source = "https://github.com/example/flowise"
        config = {
            "architecture": "amd64",
            "os": "linux",
            "config": {
                "User": "node",
                "WorkingDir": "/usr/src/flowise",
                "Cmd": ["node", "packages/server/bin/run", "start"],
                "Labels": {
                    "org.opencontainers.image.created": "2026-07-27T04:00:00.000Z",
                    "org.opencontainers.image.revision": REVISION,
                    "org.opencontainers.image.source": source,
                    "org.opencontainers.image.version": f"git-{REVISION}",
                },
            },
        }
        config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
        config_hex = hashlib.sha256(config_bytes).hexdigest()
        archive_path = self.root / "image.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            manifest_bytes = json.dumps(
                [{"Config": f"{config_hex}.json", "RepoTags": [CANDIDATE_TAG], "Layers": []}],
                separators=(",", ":"),
            ).encode()
            for name, value in (("manifest.json", manifest_bytes), (f"{config_hex}.json", config_bytes)):
                info = tarfile.TarInfo(name)
                info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
        archive_bytes = archive_path.read_bytes()
        compose_bytes = b"services:\n  flowise:\n    image: ${FLOWISE_IMAGE}\n"
        seccomp_bytes = b'{"defaultAction":"SCMP_ACT_ERRNO"}\n'
        wrapper_bytes = MODULE_PATH.read_bytes()
        manifest_inputs = {path: f"fixture:{path}\n".encode() for path in RELEASE.EXPECTED_MANIFEST_INPUTS}
        manifest_inputs.update(
            {
                "docker-compose.prod.yml": compose_bytes,
                "docker/seccomp/chromium.json": seccomp_bytes,
                "scripts/flowise-production-release.py": wrapper_bytes,
            }
        )
        manifest = {
            "schema_version": 1,
            "release_id": f"git-{REVISION}",
            "created_at": "2026-07-27T04:00:00.000Z",
            "source": {
                "dirty_digest": None,
                "repository_url": source,
                "revision": REVISION,
                "state": "clean",
                "tracked_patch": None,
                "untracked": [],
            },
            "toolchain": {"node": "v24.18.0", "package_manager": "pnpm@10.26.0", "pnpm": "10.26.0"},
            "inputs": {
                "env_template": {"keys": [], "keys_digest": digest(b"\n"), "path": ".env.production.template"},
                "files": [
                    {"path": path, "bytes": len(manifest_inputs[path]), "digest": digest(manifest_inputs[path])}
                    for path in sorted(manifest_inputs)
                ],
            },
            "boundaries": {
                "production_unchanged": True,
                "production_write": False,
                "provider_call": False,
                "registry_push": False,
                "secrets_read": False,
                "stable": True,
            },
            "image": {
                "tag": CANDIDATE_TAG,
                "config_digest": f"sha256:{config_hex}",
                "distribution": "offline_archive",
                "platform": "linux/amd64",
                "archive": {"bytes": len(archive_bytes), "digest": digest(archive_bytes)},
            },
        }
        manifest_bytes = canonical(manifest)
        evidence_values = {
            "source": source,
            "revision": REVISION,
            "image_tag": CANDIDATE_TAG,
            "store_identity": f"sha256:{config_hex}",
            "image_config_digest": f"sha256:{config_hex}",
            "platform": "linux/amd64",
            "buildx_version": RELEASE.EXPECTED_BUILDX_VERSION,
            "buildkit_version": RELEASE.EXPECTED_BUILDKIT_VERSION,
            "archive_bytes": str(len(archive_bytes)),
            "archive_sha256": digest(archive_bytes).removeprefix("sha256:"),
            "manifest_sha256": digest(manifest_bytes).removeprefix("sha256:"),
            "isolated_smoke": "passed",
            "chromium_profile_sha256": digest(seccomp_bytes).removeprefix("sha256:"),
            "production_compose_sha256": digest(compose_bytes).removeprefix("sha256:"),
            "production_wrapper_sha256": digest(wrapper_bytes).removeprefix("sha256:"),
            "chromium_sandbox": "passed",
            "raw_chromium_sandbox": "passed",
            "playwright_sandbox": "passed",
            "puppeteer_sandbox": "passed",
            "clone3_namespace": "blocked_enosys",
            "unsafe_chromium_flags": "false",
            "registry_push": "false",
        }
        evidence_bytes = (
            "\n".join(f"{key}={evidence_values[key]}" for key in RELEASE.EXPECTED_EVIDENCE_KEYS) + "\n"
        ).encode()
        payloads = {
            "image_archive": archive_bytes,
            "release_manifest": manifest_bytes,
            "release_evidence": evidence_bytes,
            "production_compose": compose_bytes,
            "chromium_seccomp": seccomp_bytes,
            "production_wrapper": wrapper_bytes,
        }
        entries = []
        for role, relative in RELEASE.EXPECTED_BUNDLE_FILES.items():
            value = payloads[role]
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(value)
            entries.append({"role": role, "path": relative, "bytes": len(value), "digest": digest(value)})
        document = {
            "schema_version": 1,
            "created_at": "2026-07-27T04:01:00.000Z",
            "release": {
                "release_id": f"git-{REVISION}",
                "revision": REVISION,
                "image_tag": CANDIDATE_TAG,
                "image_config_digest": f"sha256:{config_hex}",
            },
            "files": sorted(entries, key=lambda item: item["path"]),
            "boundaries": dict(RELEASE.EXPECTED_BOUNDARIES),
        }
        (self.root / "deployment-bundle.json").write_bytes(canonical(document))


def receipt():
    return {
        "schema_version": 1,
        "operation": "prepare",
        "state": "prepared",
        "run_id": RUN_ID,
        "release": {
            "release_id": f"git-{REVISION}",
            "revision": REVISION,
            "image_tag": CANDIDATE_TAG,
            "image_config_digest": CANDIDATE_DIGEST,
        },
        "candidate": {
            "files": {
                "env": digest(b"candidate-env"),
                "compose": digest(b"candidate-compose"),
                "seccomp": {"present": True, "digest": digest(b"candidate-seccomp")},
            },
            "archive": {"bytes": 1, "digest": digest(b"y")},
        },
        "rollback": {
            "release_id": f"git-{ROLLBACK_REVISION}",
            "revision": ROLLBACK_REVISION,
            "image_tag": ROLLBACK_TAG,
            "image_config_digest": ROLLBACK_DIGEST,
            "repository_url": "https://github.com/example/flowise",
            "files": {
                "env": digest(b"rollback-env"),
                "compose": digest(b"rollback-compose"),
                "seccomp": {"present": True, "digest": digest(b"rollback-seccomp")},
            },
            "archive": {"bytes": 1, "digest": digest(b"x")},
            "compose_config_hash": "3" * 64,
        },
        "baseline": {
            "containers": {
                RELEASE.FLOWISE_CONTAINER: {
                    "id": "old",
                    "runtime": RELEASE.container_snapshot(hardened_documents())[RELEASE.FLOWISE_CONTAINER]["runtime"],
                },
                RELEASE.POSTGRES_CONTAINER: {"id": "pg"},
                RELEASE.NGINX_CONTAINER: {"id": "nginx"},
            },
            "database": {
                "transaction_read_only": True,
                "migration_count": 59,
                "migration_sha256": digest(b"m"),
            },
        },
        "migration_gate": {
            "candidate_migration_count": 59,
            "candidate_migration_sha256": digest(b"m"),
            "production_migration_count": 59,
            "production_migration_sha256": digest(b"m"),
            "production_transaction_read_only": True,
            "pending_migrations": 0,
            "candidate_network": "none",
            "candidate_database_credentials_supplied": False,
        },
        "live_metadata": {"env": [0, 0, 0o600], "compose": [0, 0, 0o644], "seccomp": [0, 0, 0o644]},
    }


def transition_permit_document(bundle):
    return {
        "schema_version": 1,
        "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
        "run_id": RUN_ID,
        "target_bundle": {
            "bundle_digest": bundle.bundle_digest,
            "revision": bundle.revision,
            "image_tag": bundle.image_tag,
            "image_config_digest": bundle.image_config_digest,
        },
        "active_legacy": {
            "image_tag": LEGACY_TAG,
            "revision": LEGACY_REVISION,
            "release_id": f"git-{LEGACY_REVISION}",
            "repository_url": LEGACY_SOURCE,
            "created_at": LEGACY_CREATED_AT,
            "image_config_digest": LEGACY_DIGEST,
            "runtime_label_config_hash": "6" * 64,
            "live_computed_config_hash": "7" * 64,
            "runtime_projection_digest": digest(b"legacy-runtime"),
            **environment_binding(LEGACY_ENVIRONMENT),
        },
        "containers": {
            RELEASE.FLOWISE_CONTAINER: FLOWISE_ID,
            RELEASE.POSTGRES_CONTAINER: POSTGRES_ID,
            RELEASE.NGINX_CONTAINER: NGINX_ID,
        },
        "network_identity": network_identity(),
        "live": {
            "env_sha256": digest(b"legacy-env"),
            "compose_sha256": digest(b"legacy-compose"),
            "seccomp": {"present": False, "digest": None},
        },
        "database": {"migration_count": 59, "migration_name_sha256": digest(b"names")},
        "legacy_journal_inventory": {
            "root_paths": [str(RELEASE.LEGACY_RELEASES_DIR / f"git-{LEGACY_REVISION}" / "deployments")],
            "root_count": 1,
            "run_count": 18,
            "control_count": 41,
            "canonical_inventory_sha256": digest(b"inventory"),
            "unresolved_rollback_count": 0,
        },
    }


def transition_observation(bundle, *, sentinel="sentinel-secret-value"):
    permit = transition_permit_document(bundle)
    return {
        "documents": {"internal_secret": sentinel},
        "snapshot": {
            RELEASE.FLOWISE_CONTAINER: {
                "id": FLOWISE_ID,
                "image_ref": LEGACY_TAG,
                "image_id": LEGACY_DIGEST,
                "compose_config_hash": "6" * 64,
                "runtime": {"secret": sentinel},
            },
            RELEASE.POSTGRES_CONTAINER: {"id": POSTGRES_ID},
            RELEASE.NGINX_CONTAINER: {"id": NGINX_ID},
        },
        "active_tag": LEGACY_TAG,
        "active_revision": LEGACY_REVISION,
        "active_image_digest": LEGACY_DIGEST,
        "active_image": {
            "image_tag": LEGACY_TAG,
            "image_config_digest": LEGACY_DIGEST,
            "revision": LEGACY_REVISION,
            "release_id": f"git-{LEGACY_REVISION}",
            "repository_url": LEGACY_SOURCE,
            "created_at": LEGACY_CREATED_AT,
            "image_environment": {"SENTINEL_IMAGE_SECRET": sentinel},
        },
        "live_env": f"FLOWISE_IMAGE={LEGACY_TAG}\nSENTINEL={sentinel}\n".encode(),
        "live_compose": f"# {sentinel}\n".encode(),
        "live_seccomp": None,
        "live_hashes": {
            "env": permit["live"]["env_sha256"],
            "compose": permit["live"]["compose_sha256"],
            "seccomp": {"present": False, "digest": None},
        },
        "live_metadata": {"env": [0, 0, 0o600], "compose": [0, 0, 0o644], "seccomp": [0, 0, 0o644]},
        "legacy_config": {"internal_secret": sentinel},
        "legacy_config_hash": permit["active_legacy"]["live_computed_config_hash"],
        "legacy_runtime_label_hash": permit["active_legacy"]["runtime_label_config_hash"],
        "legacy_environment": {
            "FLOWISE_SECRETKEY_OVERWRITE": TEST_KEY.decode(),
            "SENTINEL_RUNTIME_SECRET": sentinel,
        },
        "legacy_environment_binding": {
            "runtime_environment_keys": ["FLOWISE_SECRETKEY_OVERWRITE", "SENTINEL_RUNTIME_SECRET"],
            "runtime_environment_hmac_sha256": digest(b"sentinel-environment-binding"),
        },
        "legacy_runtime": {
            "runtime_projection_digest": permit["active_legacy"]["runtime_projection_digest"],
            "runtime_policy": "legacy_frozen_v1",
        },
        "key": TEST_KEY,
        "database": {
            "transaction_read_only": True,
            "migration_count": permit["database"]["migration_count"],
            "migration_sha256": digest(b"timestamp-and-name-inventory"),
            "migration_name_sha256": permit["database"]["migration_name_sha256"],
        },
        "network_identity": permit["network_identity"],
        "legacy_journal_inventory": permit["legacy_journal_inventory"],
        "current_journal_inventory": {
            "root": str(RELEASE.RUNS_DIR),
            "present": True,
            "control_json_count": 7,
            "control_json_sha256": digest(b"current-journal-inventory"),
            "unresolved_rollback_count": 0,
        },
    }


def bootstrap_prepare_receipt():
    normal = receipt()
    baseline = copy.deepcopy(normal["baseline"])
    baseline["database"]["migration_name_sha256"] = digest(b"names")
    baseline["current_journal_inventory"] = {"present": False}
    baseline["network_identity"] = network_identity()
    hardened_files = {
        "env": digest(b"hardened-active-env"),
        "compose": digest(b"candidate-compose"),
        "seccomp": {"present": True, "digest": digest(b"candidate-seccomp")},
    }
    return {
        "schema_version": 1,
        "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
        "operation": "bootstrap",
        "state": "prepared_legacy_frozen",
        "run_id": RUN_ID,
        "permit": {"digest": digest(b"permit")},
        "target_bundle": {
            "bundle_digest": digest(b"bundle"),
            "release_id": f"git-{REVISION}",
            "revision": REVISION,
            "image_tag": CANDIDATE_TAG,
            "image_config_digest": CANDIDATE_DIGEST,
            "files": normal["candidate"]["files"],
            "compose_config_hash": "9" * 64,
        },
        "hardened_active": {
            "release_id": f"git-{LEGACY_REVISION}",
            "revision": LEGACY_REVISION,
            "image_tag": LEGACY_TAG,
            "image_config_digest": LEGACY_DIGEST,
            "repository_url": LEGACY_SOURCE,
            "created_at": LEGACY_CREATED_AT,
            "files": hardened_files,
            "compose_config_hash": "8" * 64,
            **environment_binding(HARDENED_ENVIRONMENT),
        },
        "legacy": {
            "release_id": f"git-{LEGACY_REVISION}",
            "revision": LEGACY_REVISION,
            "image_tag": LEGACY_TAG,
            "image_config_digest": LEGACY_DIGEST,
            "repository_url": LEGACY_SOURCE,
            "created_at": LEGACY_CREATED_AT,
            "files": {
                "env": digest(b"legacy-env"),
                "compose": digest(b"legacy-compose"),
                "seccomp": {"present": False, "digest": None},
            },
            "archive": {"bytes": 1, "digest": digest(b"legacy-archive")},
            "runtime_label_config_hash": "6" * 64,
            "live_computed_config_hash": "7" * 64,
            "runtime_projection_digest": digest(b"legacy-runtime"),
            **environment_binding(LEGACY_ENVIRONMENT),
        },
        "baseline": baseline,
        "live_metadata": normal["live_metadata"],
    }


def bootstrap_recovery_fixture(*, sentinel="bootstrap-recovery-sentinel-secret"):
    source_revision = RELEASE.BOOTSTRAP_RECOVERY_SOURCE_RELEASE_ID.removeprefix("git-")
    source_bundle = types.SimpleNamespace(
        bundle_digest=RELEASE.BOOTSTRAP_RECOVERY_SOURCE_BUNDLE_DIGEST,
        release_id=RELEASE.BOOTSTRAP_RECOVERY_SOURCE_RELEASE_ID,
        revision=source_revision,
        image_tag=f"flowise-chinese:git-{source_revision}",
        image_config_digest=CANDIDATE_DIGEST,
        files={},
        file_entries={
            "production_compose": {"digest": digest(b"target-compose")},
            "chromium_seccomp": {"digest": digest(b"target-seccomp")},
        },
    )
    recovery_revision = "c" * 40
    recovery_bundle = types.SimpleNamespace(
        bundle_digest=digest(b"recovery-bundle"),
        release_id=f"git-{recovery_revision}",
        revision=recovery_revision,
        image_tag=f"flowise-chinese:git-{recovery_revision}",
        image_config_digest="sha256:" + "c" * 64,
        files={},
        file_entries={},
    )
    hardened_config, _ = resolved_compose()
    hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
    image_environment = {"NODE_ENV": "production", "RECOVERY_SENTINEL": sentinel}
    expected_environment = RELEASE.expected_container_environment(
        image_environment,
        RELEASE.service_environment(hardened_config),
    )
    observed = hardened_documents(LEGACY_TAG, RELEASE.BOOTSTRAP_RECOVERY_LEGACY_IMAGE_CONFIG_DIGEST)
    observed[RELEASE.FLOWISE_CONTAINER]["Id"] = RECOVERY_FLOWISE_ID
    observed[RELEASE.FLOWISE_CONTAINER]["Config"]["Hostname"] = RECOVERY_FLOWISE_ID[:12]
    observed[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
        "com.docker.compose.replace"
    ] = FLOWISE_ID
    observed[RELEASE.POSTGRES_CONTAINER]["Id"] = POSTGRES_ID
    observed[RELEASE.NGINX_CONTAINER]["Id"] = NGINX_ID
    observed[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
        "com.docker.compose.config-hash"
    ] = OBSERVED_HARDENED_CONFIG_HASH
    observed[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"] = [
        f"{name}={value}" for name, value in sorted(expected_environment.items())
    ]
    observed_snapshot = RELEASE.container_snapshot(observed)

    live_bytes = {
        RELEASE.LIVE_ENV: b"hardened-active-env",
        RELEASE.LIVE_COMPOSE: b"candidate-compose",
        RELEASE.LIVE_SECCOMP: canonical(TEST_SECCOMP_DOCUMENT),
    }
    prepared = bootstrap_prepare_receipt()
    prepared["run_id"] = RECOVERY_RUN_ID
    prepared["permit"] = {"digest": RELEASE.BOOTSTRAP_RECOVERY_PERMIT_DIGEST}
    prepared["target_bundle"].update(
        {
            **RELEASE._bundle_identity(source_bundle),
            "compose_config_hash": "9" * 64,
        }
    )
    prepared["hardened_active"].update(
        {
            "image_config_digest": RELEASE.BOOTSTRAP_RECOVERY_LEGACY_IMAGE_CONFIG_DIGEST,
            "compose_config_hash": REQUESTED_HARDENED_CONFIG_HASH,
            **RELEASE.runtime_environment_binding(expected_environment, TEST_KEY),
        }
    )
    prepared["hardened_active"]["files"] = {
        "env": digest(live_bytes[RELEASE.LIVE_ENV]),
        "compose": digest(live_bytes[RELEASE.LIVE_COMPOSE]),
        "seccomp": {
            "present": True,
            "digest": digest(live_bytes[RELEASE.LIVE_SECCOMP]),
        },
    }
    prepared["target_bundle"]["files"]["compose"] = prepared["hardened_active"]["files"][
        "compose"
    ]
    prepared["target_bundle"]["files"]["seccomp"] = copy.deepcopy(
        prepared["hardened_active"]["files"]["seccomp"]
    )
    prepared["legacy"]["image_config_digest"] = RELEASE.BOOTSTRAP_RECOVERY_LEGACY_IMAGE_CONFIG_DIGEST
    prepared["baseline"]["containers"] = copy.deepcopy(observed_snapshot)
    prepared["baseline"]["containers"][RELEASE.FLOWISE_CONTAINER]["id"] = FLOWISE_ID
    prepared["baseline"]["legacy_journal_inventory"] = {
        "root_paths": [str(RELEASE.LEGACY_RELEASES_DIR / f"git-{LEGACY_REVISION}" / "deployments")],
        "root_count": 1,
        "run_count": 18,
        "control_count": 41,
        "canonical_inventory_sha256": digest(b"legacy-inventory"),
        "unresolved_rollback_count": 0,
    }
    prepared["baseline"]["current_journal_inventory"] = {
        "root": str(RELEASE.RUNS_DIR),
        "present": False,
        "control_json_count": 0,
        "control_json_sha256": digest(RELEASE.canonical_json([])),
        "unresolved_rollback_count": 0,
    }
    prepared.update(
        {
            "target_bundle_non_image_match": True,
            "candidate_archive_loaded": False,
            "key_continuity_verified": True,
            "container_recreated": False,
            "provider_call": False,
            "created_at": "2026-07-28T17:16:44Z",
        }
    )

    permit_document = transition_permit_document(source_bundle)
    permit_document["run_id"] = RECOVERY_RUN_ID
    permit_document["target_bundle"] = RELEASE._bundle_identity(source_bundle)
    for name in (
        "image_tag",
        "revision",
        "release_id",
        "repository_url",
        "created_at",
        "image_config_digest",
        "runtime_label_config_hash",
        "live_computed_config_hash",
        "runtime_projection_digest",
        "runtime_environment_keys",
        "runtime_environment_hmac_sha256",
    ):
        permit_document["active_legacy"][name] = prepared["legacy"][name]
    permit_document["containers"] = {
        name: prepared["baseline"]["containers"][name]["id"]
        for name in RELEASE.MANAGED_CONTAINERS
    }
    permit_document["network_identity"] = copy.deepcopy(prepared["baseline"]["network_identity"])
    permit_document["database"] = {
        "migration_count": prepared["baseline"]["database"]["migration_count"],
        "migration_name_sha256": prepared["baseline"]["database"]["migration_name_sha256"],
    }
    permit_document["legacy_journal_inventory"] = copy.deepcopy(
        prepared["baseline"]["legacy_journal_inventory"]
    )
    permit = RELEASE.TransitionPermit(
        (RELEASE.TRANSITION_PERMITS_DIR / f"{RECOVERY_RUN_ID}.json").absolute(),
        permit_document,
        prepared["permit"]["digest"],
    )
    prepare_digest = RELEASE.BOOTSTRAP_RECOVERY_PREPARE_DIGEST
    journal = {
        "schema_version": 1,
        "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
        "operation": "bootstrap",
        "state": "in_progress",
        "phase": "hardened_recreate_intent",
        "run_id": RECOVERY_RUN_ID,
        "permit_digest": permit.digest,
        "target_bundle_digest": source_bundle.bundle_digest,
        "target_bundle_release_id": source_bundle.release_id,
        "active_legacy_release_id": prepared["legacy"]["release_id"],
        "bootstrap_prepare_receipt_sha256": prepare_digest,
        "live_write_started": True,
        "hardened_recreate_started": True,
        "rollback_attempted": False,
        "updated_at": "2026-07-28T17:20:00Z",
    }
    journal_data = canonical(journal)
    context = {
        "recovery_bundle": recovery_bundle,
        "source_bundle": source_bundle,
        "permit": permit,
        "run_dir": RELEASE.RUNS_DIR / RECOVERY_RUN_ID,
        "prepare_receipt": prepared,
        "prepare_digest": prepare_digest,
        "journal": journal,
        "journal_data": journal_data,
        "journal_pre_sha256": digest(journal_data),
        "complete_path": None,
        "complete_receipt_present": False,
        "key": TEST_KEY,
        "expected": {
            "legacy_env": f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode(),
            "hardened_config": hardened_config,
            "hardened_environment": expected_environment,
        },
    }
    return {
        "context": context,
        "documents": observed,
        "full_runtime_projection_digest": RELEASE.recovery_runtime_projection_digest(
            observed[RELEASE.FLOWISE_CONTAINER],
            TEST_SECCOMP_DIGEST,
        ),
        "image_environment": image_environment,
        "expected_environment": expected_environment,
        "source_bundle": source_bundle,
        "recovery_bundle": recovery_bundle,
        "permit": permit,
        "prepare": prepared,
        "journal": journal,
        "live_bytes": live_bytes,
        "sentinel": sentinel,
    }


def legacy_control_document(kind, state=None, phase=None, *, run_id=RUN_ID) -> dict[str, Any]:
    if kind == "prepare-status.json":
        keys = RELEASE.LEGACY_PREPARE_KEYS_BY_STATE_PHASE[(state, phase)]
    else:
        keys = RELEASE.LEGACY_CONTROL_KEYS[kind]
    document: dict[str, Any] = {key: None for key in keys}
    if "schema_version" in document:
        document["schema_version"] = 1
    if "release_id" in document:
        document["release_id"] = f"git-{LEGACY_REVISION}"
    if "run_id" in document:
        document["run_id"] = run_id
    if "state" in document:
        document["state"] = state
    if "phase" in document:
        document["phase"] = phase
    return document


def documents(image=CANDIDATE_TAG, image_id=CANDIDATE_DIGEST, flowise_id=FLOWISE_ID):
    result = {}
    for name, identifier in (
        (RELEASE.FLOWISE_CONTAINER, flowise_id),
        (RELEASE.POSTGRES_CONTAINER, "pg"),
        (RELEASE.NGINX_CONTAINER, "nginx"),
    ):
        environment = ["FLOWISE_SECRETKEY_OVERWRITE=" + "k" * 32]
        if name == RELEASE.FLOWISE_CONTAINER:
            network_settings = {
                "Networks": {
                    "flowise_flowise_network": {
                        "NetworkID": FLOWISE_NETWORK_ID,
                        "Gateway": "172.28.0.1",
                        "IPPrefixLen": 16,
                        "IPAddress": "172.28.0.10",
                    },
                    "lighthouse_ai_video_net": {
                        "NetworkID": PROXY_NETWORK_ID,
                        "Gateway": "172.20.0.1",
                        "IPPrefixLen": 16,
                        "IPAddress": "172.20.0.10",
                    },
                }
            }
        elif name == RELEASE.POSTGRES_CONTAINER:
            environment = [
                "PGDATA=/var/lib/postgresql/data/pgdata",
                "POSTGRES_DB=flowise",
                "POSTGRES_USER=flowise",
                "POSTGRES_PASSWORD=test-password",
            ]
            network_settings = {
                "Networks": {
                    "flowise_flowise_network": {
                        "NetworkID": FLOWISE_NETWORK_ID,
                        "Aliases": ["flowise-postgres", "postgres"],
                    }
                }
            }
        else:
            network_settings = {
                "Networks": {
                    "lighthouse_ai_video_net": {
                        "NetworkID": PROXY_NETWORK_ID,
                        "Gateway": "172.20.0.1",
                        "IPPrefixLen": 16,
                        "IPAddress": "172.20.0.2",
                    }
                }
            }
        result[name] = {
            "Id": identifier,
            "Image": image_id if name == RELEASE.FLOWISE_CONTAINER else name + "-image",
            "Config": {
                "Image": image if name == RELEASE.FLOWISE_CONTAINER else name + "-ref",
                "Labels": {"com.docker.compose.config-hash": "4" * 64},
                "Env": environment,
            },
            "NetworkSettings": network_settings,
            "State": {"Status": "running", "Health": {"Status": "healthy"}},
            "RestartCount": 0,
        }
    return result


def resolved_compose():
    environment = copy.deepcopy(HARDENED_ENVIRONMENT)
    flowise = {
        "cap_drop": ["ALL"],
        "command": None,
        "container_name": RELEASE.FLOWISE_CONTAINER,
        "depends_on": {"postgres": {"condition": "service_healthy", "required": True}},
        "deploy": copy.deepcopy(RELEASE.EXPECTED_FLOWISE_DEPLOY),
        "entrypoint": None,
        "environment": environment,
        "healthcheck": copy.deepcopy(RELEASE.EXPECTED_FLOWISE_HEALTHCHECK),
        "image": CANDIDATE_TAG,
        "init": True,
        "logging": copy.deepcopy(RELEASE.EXPECTED_FLOWISE_LOGGING),
        "networks": {"flowise_network": None, "reverse_proxy_network": None},
        "pids_limit": 512,
        "ports": [
            {"mode": "ingress", "host_ip": "172.20.0.1", "target": 3000, "published": "3000", "protocol": "tcp"}
        ],
        "read_only": True,
        "restart": "always",
        "security_opt": ["no-new-privileges:true", "seccomp=./docker/seccomp/chromium.json"],
        "tmpfs": list(RELEASE.EXPECTED_TMPFS),
        "user": "1000:1000",
        "volumes": [{"type": "volume", "source": "flowise_data", "target": "/usr/src/flowise/.flowise", "volume": {}}],
    }
    candidate = {
        "services": {
            "flowise": flowise,
            "postgres": {
                "image": "postgres:16",
                "environment": {
                    "PGDATA": "/var/lib/postgresql/data/pgdata",
                    "POSTGRES_DB": "flowise",
                    "POSTGRES_PASSWORD": "test-password",
                    "POSTGRES_USER": "flowise",
                },
            },
        },
        "volumes": copy.deepcopy(RELEASE.EXPECTED_TOP_LEVEL_VOLUMES),
        "networks": copy.deepcopy(RELEASE.EXPECTED_TOP_LEVEL_NETWORKS),
    }
    rollback = copy.deepcopy(candidate)
    rollback["services"]["flowise"]["image"] = ROLLBACK_TAG
    return candidate, rollback


def hardened_documents(image=CANDIDATE_TAG, image_id=CANDIDATE_DIGEST):
    result = documents(image, image_id)
    flowise = result[RELEASE.FLOWISE_CONTAINER]
    image_authority = runtime_image_authority(image, image_id)
    replaced_container_id = "2" * 64
    candidate, _ = resolved_compose()
    candidate["services"]["flowise"]["image"] = image
    environment = [
        f"{key}={value}" for key, value in sorted(candidate["services"]["flowise"]["environment"].items())
    ]
    flowise["Path"] = "docker-entrypoint.sh"
    flowise["Args"] = ["node", "packages/server/bin/run", "start"]
    config_surface = copy.deepcopy(RELEASE.EXPECTED_RUNTIME_CONFIG_SURFACE)
    config_surface["Hostname"] = str(flowise["Id"])[:12]
    config_surface["Image"] = image
    config_surface["Healthcheck"]["StartInterval"] = 0
    config_surface["Env"] = environment
    config_surface["Labels"] = {
        "com.docker.compose.config-hash": "4" * 64,
        "com.docker.compose.container-number": "1",
        "com.docker.compose.depends_on": "",
        "com.docker.compose.image": image_id,
        "com.docker.compose.oneoff": "False",
        "com.docker.compose.project": "flowise",
        "com.docker.compose.project.config_files": str(RELEASE.BASE_DIR / "docker-compose.prod.yml"),
        "com.docker.compose.project.environment_file": str(RELEASE.BASE_DIR / ".env.production"),
        "com.docker.compose.project.working_dir": str(RELEASE.BASE_DIR),
        "com.docker.compose.replace": replaced_container_id,
        "com.docker.compose.service": "flowise",
        "com.docker.compose.version": "2.27.1",
        "org.opencontainers.image.created": image_authority["created_at"],
        "org.opencontainers.image.revision": image_authority["revision"],
        "org.opencontainers.image.source": image_authority["repository_url"],
        "org.opencontainers.image.version": image_authority["release_id"],
    }
    flowise["Config"] = config_surface
    host_config = copy.deepcopy(RELEASE.EXPECTED_RUNTIME_HOST_CONFIG_SURFACE)
    host_config["SecurityOpt"] = [
        "no-new-privileges:true",
        f"seccomp={TEST_SECCOMP_INLINE}",
    ]
    flowise["HostConfig"] = host_config
    flowise["Mounts"] = [
        {
            "Type": "volume",
            "Name": "flowise_flowise_data",
            "Source": "/var/lib/docker/volumes/flowise_flowise_data/_data",
            "Destination": "/usr/src/flowise/.flowise",
            "Driver": "local",
            "Mode": "rw",
            "RW": True,
            "Propagation": "",
        }
    ]
    flowise["NetworkSettings"] = {
        "Networks": {
            "flowise_flowise_network": {
                "NetworkID": FLOWISE_NETWORK_ID,
                "Gateway": "172.28.0.1",
                "IPPrefixLen": 16,
                "IPAddress": "172.28.0.10",
            },
            "lighthouse_ai_video_net": {
                "NetworkID": PROXY_NETWORK_ID,
                "Gateway": "172.20.0.1",
                "IPPrefixLen": 16,
                "IPAddress": "172.20.0.10",
            },
        }
    }
    return result


def attacker_value(value):
    """Return a JSON-compatible value guaranteed to differ from the fixture."""

    if value is None:
        return "__attacker__"
    if isinstance(value, bool):
        return not value
    if isinstance(value, int):
        return value + 1
    if isinstance(value, str):
        return value + "__attacker__" if value else "__attacker__"
    if isinstance(value, list):
        return copy.deepcopy(value) + ["__attacker__"]
    if isinstance(value, dict):
        return {**copy.deepcopy(value), "__attacker__": True}
    raise AssertionError(f"unsupported fixture value: {type(value)!r}")


class PatchedLock:
    def __init__(self, case, events=None):
        self.case = case
        self.events = events
        self.fd = None
        self.original_close = os.close

    def __enter__(self):
        self.fd = os.open(os.devnull, os.O_RDONLY)
        if self.events is not None:
            self.events.append("lock-acquired")
        self.acquire = mock.patch.object(RELEASE, "acquire_lock", return_value=self.fd)
        self.acquire_existing = mock.patch.object(
            RELEASE,
            "acquire_existing_lock",
            return_value=self.fd,
        )
        self.root = mock.patch.object(RELEASE, "require_root")

        def tracked_close(descriptor):
            if descriptor == self.fd and self.events is not None:
                self.events.append("lock-released")
            return self.original_close(descriptor)

        self.close = mock.patch.object(RELEASE.os, "close", side_effect=tracked_close)
        self.acquire_mock = self.acquire.start()
        self.acquire_existing_mock = self.acquire_existing.start()
        self.root_mock = self.root.start()
        self.close.start()
        return self

    def __exit__(self, *args):
        self.close.stop()
        self.root.stop()
        self.acquire_existing.stop()
        self.acquire.stop()


class ProductionReleaseTests(unittest.TestCase):
    def setUp(self):
        # Hardened-runtime unit fixtures model Docker's observed inline seccomp
        # form without depending on a host /opt/flowise tree.  The dedicated
        # normalization test below switches this mock to the real reader.
        self.live_seccomp_digest_patcher = mock.patch.object(
            RELEASE,
            "_live_seccomp_canonical_digest",
            return_value=TEST_SECCOMP_DIGEST,
        )
        self.live_seccomp_digest = self.live_seccomp_digest_patcher.start()
        self.addCleanup(self.live_seccomp_digest_patcher.stop)

    def test_bootstrap_requires_explicit_digest_bound_transition_permit(self):
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
            RELEASE.parse_args(["bootstrap", "--bundle-dir", "/bundle", "--run-id", RUN_ID])

        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        document = transition_permit_document(bundle)
        permit_bytes = canonical(document)
        with mock.patch.object(RELEASE, "read_regular", return_value=permit_bytes) as read:
            permit = RELEASE.verify_transition_permit(
                Path("/permit.json"),
                digest(permit_bytes),
                bundle=bundle,
                run_id=RUN_ID,
            )
        self.assertEqual(permit.digest, digest(permit_bytes))
        self.assertEqual(
            read.call_args.kwargs,
            {"maximum": 1024 * 1024, "expected_uid": 0, "expected_gid": 0, "expected_mode": 0o600},
        )

        variants = {
            "digest": (permit_bytes, digest(b"tampered")),
            "noncanonical": (json.dumps(document, indent=2).encode(), digest(json.dumps(document, indent=2).encode())),
            "unknown-key": (
                canonical({**document, "allow_legacy": True}),
                digest(canonical({**document, "allow_legacy": True})),
            ),
            "unknown-policy": (
                canonical({**document, "policy": {**document["policy"], "allow": "all"}}),
                digest(canonical({**document, "policy": {**document["policy"], "allow": "all"}})),
            ),
            "boolean-root-count": (
                canonical(
                    {
                        **document,
                        "legacy_journal_inventory": {
                            **document["legacy_journal_inventory"],
                            "root_count": True,
                        },
                    }
                ),
                digest(
                    canonical(
                        {
                            **document,
                            "legacy_journal_inventory": {
                                **document["legacy_journal_inventory"],
                                "root_count": True,
                            },
                        }
                    )
                ),
            ),
            "network-identity-drift": (
                canonical(
                    {
                        **document,
                        "network_identity": {
                            **document["network_identity"],
                            "reverse_proxy": {
                                **document["network_identity"]["reverse_proxy"],
                                "network_id": FLOWISE_NETWORK_ID,
                            },
                        },
                    }
                ),
                digest(
                    canonical(
                        {
                            **document,
                            "network_identity": {
                                **document["network_identity"],
                                "reverse_proxy": {
                                    **document["network_identity"]["reverse_proxy"],
                                    "network_id": FLOWISE_NETWORK_ID,
                                },
                            },
                        }
                    )
                ),
            ),
        }
        for label, (value, expected_digest) in variants.items():
            with self.subTest(label=label), mock.patch.object(RELEASE, "read_regular", return_value=value), self.assertRaises(
                RELEASE.DeployError
            ):
                RELEASE.verify_transition_permit(
                    Path("/permit.json"),
                    expected_digest,
                    bundle=bundle,
                    run_id=RUN_ID,
                )

    def test_transition_snapshot_cli_is_explicit_and_issue_requires_expected_digest(self):
        snapshot = RELEASE.parse_args(
            ["snapshot-transition", "--bundle-dir", "/bundle", "--run-id", RUN_ID]
        )
        self.assertEqual((snapshot.command, snapshot.bundle_dir, snapshot.run_id), (
            "snapshot-transition",
            Path("/bundle"),
            RUN_ID,
        ))
        issue = RELEASE.parse_args(
            [
                "issue-transition-permit",
                "--bundle-dir",
                "/bundle",
                "--run-id",
                RUN_ID,
                "--expected-snapshot-sha256",
                "a" * 64,
            ]
        )
        self.assertEqual(issue.expected_snapshot_sha256, "sha256:" + "a" * 64)
        with mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
            RELEASE.parse_args(
                ["issue-transition-permit", "--bundle-dir", "/bundle", "--run-id", RUN_ID]
            )

    def test_transition_snapshot_and_issuer_fail_before_observation_on_root_or_lock_gate(self):
        commands = (
            ("snapshot", lambda: RELEASE.snapshot_transition(Path("/bundle"), RUN_ID)),
            (
                "issue",
                lambda: RELEASE.issue_transition_permit(Path("/bundle"), RUN_ID, digest(b"snapshot")),
            ),
        )
        for command_label, command in commands:
            for gate_label, root_error, lock_error in (
                ("root", RELEASE.DeployError("ROOT_REQUIRED"), None),
                ("lock", None, RELEASE.DeployError("DEPLOY_LOCK_BUSY")),
            ):
                acquire = mock.Mock(side_effect=lock_error)
                observe = mock.Mock()
                write = mock.Mock()
                verify = mock.Mock()
                with self.subTest(command=command_label, gate=gate_label), mock.patch.object(
                    RELEASE, "require_root", side_effect=root_error
                ), mock.patch.object(
                    RELEASE, "acquire_lock", acquire
                ), mock.patch.object(
                    RELEASE, "verify_bundle", verify
                ), mock.patch.object(
                    RELEASE, "_collect_transition_observation", observe
                ), mock.patch.object(
                    RELEASE, "_install_transition_permit", write
                ), self.assertRaisesRegex(RELEASE.DeployError, "ROOT_REQUIRED|DEPLOY_LOCK_BUSY"):
                    command()
                if gate_label == "root":
                    acquire.assert_not_called()
                else:
                    acquire.assert_called_once_with()
                verify.assert_not_called()
                observe.assert_not_called()
                write.assert_not_called()

    def test_transition_snapshot_and_issuer_reject_invalid_run_or_digest_before_bundle_observation(self):
        verify = mock.Mock()
        observe = mock.Mock()
        write = mock.Mock()
        with PatchedLock(self), mock.patch.object(RELEASE, "verify_bundle", verify), mock.patch.object(
            RELEASE, "_collect_transition_observation", observe
        ), mock.patch.object(
            RELEASE, "_install_transition_permit", write
        ), self.assertRaisesRegex(RELEASE.DeployError, "RUN_ID_INVALID"):
            RELEASE.snapshot_transition(Path("/bundle"), "invalid-run")
        verify.assert_not_called()
        observe.assert_not_called()
        write.assert_not_called()

        for label, run_id, snapshot_digest, expected_error in (
            ("run", "invalid-run", digest(b"snapshot"), "RUN_ID_INVALID"),
            ("digest", RUN_ID, "not-a-digest", "TRANSITION_SNAPSHOT_DIGEST_INVALID"),
        ):
            verify.reset_mock()
            observe.reset_mock()
            write.reset_mock()
            with self.subTest(label=label), PatchedLock(self), mock.patch.object(
                RELEASE, "verify_bundle", verify
            ), mock.patch.object(
                RELEASE, "_collect_transition_observation", observe
            ), mock.patch.object(
                RELEASE, "_install_transition_permit", write
            ), self.assertRaisesRegex(RELEASE.DeployError, expected_error):
                RELEASE.issue_transition_permit(Path("/bundle"), run_id, snapshot_digest)
            verify.assert_not_called()
            observe.assert_not_called()
            write.assert_not_called()

    def test_snapshot_transition_is_double_observed_locked_read_only_and_secret_safe(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        observed = transition_observation(bundle)
        recover = mock.Mock(side_effect=AssertionError("snapshot must never recover"))
        runtime_write = mock.Mock(side_effect=AssertionError("snapshot must never write runtime"))
        artifact_write = mock.Mock(side_effect=AssertionError("snapshot must never write artifacts"))
        with PatchedLock(self) as locked, mock.patch.object(
            RELEASE, "verify_bundle", return_value=bundle
        ), mock.patch.object(
            RELEASE, "_collect_transition_observation", side_effect=[copy.deepcopy(observed), copy.deepcopy(observed)]
        ) as collector, mock.patch.object(
            RELEASE, "_recover_interrupted_runs", recover
        ), mock.patch.object(
            RELEASE, "install_config_set", runtime_write
        ), mock.patch.object(
            RELEASE, "_install_transition_permit", artifact_write
        ):
            result = RELEASE.snapshot_transition(Path("/bundle"), RUN_ID)

        locked.root_mock.assert_called_once_with()
        locked.acquire_mock.assert_called_once_with()
        self.assertEqual(collector.call_count, 2)
        self.assertEqual(collector.call_args_list[0].kwargs, {"check_current_journals": True})
        self.assertEqual(
            collector.call_args_list[1].kwargs,
            {
                "permit_document": RELEASE._build_transition_permit_document(bundle, RUN_ID, observed),
                "check_current_journals": True,
            },
        )
        recover.assert_not_called()
        runtime_write.assert_not_called()
        artifact_write.assert_not_called()
        self.assertEqual(
            set(result),
            {
                "status",
                "run_id",
                "target_bundle_sha256",
                "permit_candidate_sha256",
                "snapshot_sha256",
                "container_identity_sha256",
                "network_identity_sha256",
                "live_state_sha256",
                "runtime_environment_binding_sha256",
                "database_state_sha256",
                "legacy_journal_inventory_sha256",
                "current_journal_inventory_sha256",
                "migration_count",
                "legacy_journal_root_count",
                "legacy_journal_run_count",
                "legacy_journal_control_count",
                "current_journal_control_count",
                "production_runtime_write",
                "control_artifact_write",
                "database_write",
                "provider_call",
                "secret_value_output",
            },
        )
        self.assertEqual(result["status"], "transition_snapshot_verified")
        self.assertFalse(result["production_runtime_write"])
        self.assertFalse(result["control_artifact_write"])
        self.assertFalse(result["database_write"])
        self.assertFalse(result["provider_call"])
        self.assertFalse(result["secret_value_output"])
        self.assertNotIn("sentinel-secret-value", json.dumps(result, sort_keys=True))

        permit_document = RELEASE._build_transition_permit_document(bundle, RUN_ID, observed)
        snapshot_document = {
            "schema_version": 1,
            "run_id": RUN_ID,
            "target_bundle_sha256": bundle.bundle_digest,
            "permit_candidate_sha256": digest(canonical(permit_document)),
            "current_journal_inventory": observed["current_journal_inventory"],
        }
        self.assertEqual(result["snapshot_sha256"], digest(canonical(snapshot_document)))

    def test_transition_observation_cas_rejects_every_bound_drift_without_writes(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        initial = transition_observation(bundle)

        def mutate_container(value):
            value["snapshot"][RELEASE.FLOWISE_CONTAINER]["id"] = "9" * 64

        def mutate_network(value):
            value["network_identity"]["reverse_proxy"]["network_id"] = "9" * 64

        def mutate_live(value):
            value["live_hashes"]["env"] = digest(b"drifted-live-env")

        def mutate_environment(value):
            value["legacy_environment_binding"]["runtime_environment_hmac_sha256"] = digest(
                b"drifted-runtime-environment"
            )

        def mutate_database(value):
            value["database"]["migration_count"] += 1

        def mutate_legacy_journal(value):
            value["legacy_journal_inventory"]["control_count"] += 1

        def mutate_current_journal(value):
            value["current_journal_inventory"]["control_json_count"] += 1

        def mutate_key(value):
            value["key"] = b"z" * 32

        for label, mutate in (
            ("container", mutate_container),
            ("network", mutate_network),
            ("live", mutate_live),
            ("runtime-environment", mutate_environment),
            ("database", mutate_database),
            ("legacy-journal", mutate_legacy_journal),
            ("current-journal", mutate_current_journal),
            ("persistent-key", mutate_key),
        ):
            current = copy.deepcopy(initial)
            mutate(current)
            artifact_write = mock.Mock()
            with self.subTest(label=label), PatchedLock(self), mock.patch.object(
                RELEASE, "verify_bundle", return_value=bundle
            ), mock.patch.object(
                RELEASE, "_collect_transition_observation", side_effect=[copy.deepcopy(initial), current]
            ), mock.patch.object(
                RELEASE, "_install_transition_permit", artifact_write
            ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_OBSERVATION_CAS_MISMATCH") as raised:
                RELEASE.snapshot_transition(Path("/bundle"), RUN_ID)
            artifact_write.assert_not_called()
            self.assertNotIn("sentinel-secret-value", str(raised.exception))

    def test_issue_transition_permit_reobserves_cas_and_stale_digest_is_zero_write(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        observed = transition_observation(bundle)
        permit_document = RELEASE._build_transition_permit_document(bundle, RUN_ID, observed)
        snapshot_document = {
            "schema_version": 1,
            "run_id": RUN_ID,
            "target_bundle_sha256": bundle.bundle_digest,
            "permit_candidate_sha256": digest(canonical(permit_document)),
            "current_journal_inventory": observed["current_journal_inventory"],
        }
        expected_snapshot = digest(canonical(snapshot_document))
        artifact_write = mock.Mock()
        verifier = mock.Mock()
        with PatchedLock(self), mock.patch.object(
            RELEASE, "verify_bundle", return_value=bundle
        ), mock.patch.object(
            RELEASE, "_collect_transition_observation", side_effect=[copy.deepcopy(observed), copy.deepcopy(observed)]
        ) as collector, mock.patch.object(
            RELEASE, "_install_transition_permit", artifact_write
        ), mock.patch.object(
            RELEASE, "verify_transition_permit", verifier
        ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_SNAPSHOT_DIGEST_MISMATCH"):
            RELEASE.issue_transition_permit(Path("/bundle"), RUN_ID, digest(b"stale-snapshot"))
        self.assertEqual(collector.call_count, 2)
        artifact_write.assert_not_called()
        verifier.assert_not_called()

        permit_path = Path("/opt/flowise/transition-permits") / f"{RUN_ID}.json"
        permit_bytes = canonical(permit_document)
        artifact_write = mock.Mock(return_value=permit_path)
        verifier = mock.Mock(
            return_value=RELEASE.TransitionPermit(permit_path, permit_document, digest(permit_bytes))
        )
        recover = mock.Mock(side_effect=AssertionError("issuer must never recover"))
        with PatchedLock(self) as issue_locked, mock.patch.object(
            RELEASE, "verify_bundle", return_value=bundle
        ), mock.patch.object(
            RELEASE, "_collect_transition_observation", side_effect=[copy.deepcopy(observed), copy.deepcopy(observed)]
        ), mock.patch.object(
            RELEASE, "_install_transition_permit", artifact_write
        ), mock.patch.object(
            RELEASE, "verify_transition_permit", verifier
        ), mock.patch.object(
            RELEASE, "_recover_interrupted_runs", recover
        ):
            result = RELEASE.issue_transition_permit(Path("/bundle"), RUN_ID, expected_snapshot)

        issue_locked.root_mock.assert_called_once_with()
        issue_locked.acquire_mock.assert_called_once_with()
        recover.assert_not_called()
        artifact_write.assert_called_once_with(RUN_ID, permit_bytes, bundle=bundle)
        verifier.assert_called_once_with(
            permit_path,
            digest(permit_bytes),
            bundle=bundle,
            run_id=RUN_ID,
        )
        self.assertEqual(
            set(result),
            {
                "status",
                "run_id",
                "permit_path",
                "permit_sha256",
                "snapshot_sha256",
                "target_bundle_sha256",
                "production_runtime_write",
                "control_artifact_write",
                "database_write",
                "provider_call",
                "secret_value_output",
            },
        )
        self.assertEqual(result["status"], "transition_permit_issued")
        self.assertTrue(result["control_artifact_write"])
        self.assertFalse(result["production_runtime_write"])
        self.assertFalse(result["database_write"])
        self.assertFalse(result["provider_call"])
        self.assertFalse(result["secret_value_output"])
        self.assertNotIn("current_journal_inventory", permit_document)
        self.assertNotIn("sentinel-secret-value", permit_bytes.decode())
        self.assertNotIn("sentinel-secret-value", json.dumps(result, sort_keys=True))

    def test_transition_permit_directory_rejects_unsafe_existing_paths_without_chmod(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unsafe = root / "transition-permits"
            unsafe.mkdir(mode=0o755)
            unsafe.chmod(0o755)
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", unsafe), mock.patch.object(
                RELEASE, "_validate_transition_permit_parent"
            ), self.assertRaisesRegex(
                RELEASE.DeployError, "TRANSITION_PERMIT_DIRECTORY_UNSAFE"
            ):
                RELEASE._ensure_transition_permit_directory()
            self.assertEqual(stat.S_IMODE(unsafe.stat().st_mode), 0o755)

            unsafe.rmdir()
            target = root / "real-permit-directory"
            target.mkdir(mode=0o700)
            unsafe.symlink_to(target, target_is_directory=True)
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", unsafe), mock.patch.object(
                RELEASE, "_validate_transition_permit_parent"
            ), self.assertRaisesRegex(
                RELEASE.DeployError, "TRANSITION_PERMIT_DIRECTORY_UNSAFE"
            ):
                RELEASE._ensure_transition_permit_directory()

    def test_transition_permit_parent_requires_root_owner(self):
        safe_mode = stat.S_IFDIR | 0o755
        for label, overrides in (
            ("owner", {"st_uid": 501}),
            ("group", {"st_gid": 20}),
            ("writable", {"st_mode": stat.S_IFDIR | 0o775}),
            ("symlink", {"st_mode": stat.S_IFLNK | 0o777}),
        ):
            values = {"st_mode": safe_mode, "st_uid": 0, "st_gid": 0} | overrides
            with self.subTest(label=label), mock.patch.object(
                RELEASE.Path, "lstat", return_value=types.SimpleNamespace(**values)
            ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_PARENT_UNSAFE"):
                RELEASE._validate_transition_permit_parent(Path("/opt/flowise"))

    def test_transition_permit_install_is_no_overwrite_and_rejects_existing_symlink(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"
            for label, make_destination in (
                ("regular", lambda: destination.write_bytes(b"existing-permit")),
                ("symlink", lambda: destination.symlink_to(permit_dir / "outside.json")),
            ):
                destination.unlink(missing_ok=True)
                make_destination()
                before = destination.read_bytes() if label == "regular" else os.readlink(destination)
                with self.subTest(label=label), mock.patch.object(
                    RELEASE, "TRANSITION_PERMITS_DIR", permit_dir
                ), mock.patch.object(
                    RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
                ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_ALREADY_EXISTS"):
                    RELEASE._install_transition_permit(
                        RUN_ID,
                        canonical({"new": "permit"}),
                        bundle=bundle,
                    )
                after = destination.read_bytes() if label == "regular" else os.readlink(destination)
                self.assertEqual(after, before)
                self.assertEqual(
                    [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")],
                    [],
                )

    def test_transition_permit_close_failure_removes_unpublished_temporary_file(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_bytes = canonical(
            RELEASE._build_transition_permit_document(
                bundle,
                RUN_ID,
                transition_observation(bundle),
            )
        )
        real_close = os.close
        close_calls = 0

        def fail_first_close(descriptor):
            nonlocal close_calls
            close_calls += 1
            real_close(descriptor)
            if close_calls == 1:
                raise OSError("injected close failure")

        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", permit_dir), mock.patch.object(
                RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
            ), mock.patch.object(RELEASE.os, "fchown"), mock.patch.object(
                RELEASE.os, "close", side_effect=fail_first_close
            ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_INSTALL_FAILED"):
                RELEASE._install_transition_permit(RUN_ID, permit_bytes, bundle=bundle)
            self.assertFalse(destination.exists())
            self.assertEqual(
                [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")],
                [],
            )

    def test_transition_permit_install_is_canonical_root_mode_single_link_and_consumer_compatible(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_document = RELEASE._build_transition_permit_document(
            bundle,
            RUN_ID,
            transition_observation(bundle),
        )
        permit_bytes = canonical(permit_document)
        expected_digest = digest(permit_bytes)
        identities = []
        publication_events = []
        real_link = os.link

        def verify_identity(path, *, expected_bytes, expected_digest: str, **metadata):
            info = Path(path).stat()
            self.assertTrue(stat.S_ISREG(info.st_mode))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
            expected_nlink = metadata.pop("expected_nlink", 1)
            self.assertEqual(info.st_nlink, expected_nlink)
            self.assertEqual(Path(path).read_bytes(), permit_bytes)
            self.assertEqual((expected_bytes, expected_digest), (len(permit_bytes), digest(permit_bytes)))
            self.assertEqual(metadata, {})
            identities.append(Path(path))

        def verify_consumer(path, expected_digest, *, bundle, run_id):
            self.assertEqual(expected_digest, digest(permit_bytes))
            self.assertEqual(run_id, RUN_ID)
            return RELEASE.TransitionPermit(Path(path).absolute(), permit_document, expected_digest)

        def track_fsync(path):
            publication_events.append(("fsync", Path(path)))

        def track_link(source, destination, **kwargs):
            publication_events.append(("link", Path(source), Path(destination)))
            return real_link(source, destination, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", permit_dir), mock.patch.object(
                RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
            ), mock.patch.object(RELEASE.os, "fchown") as fchown, mock.patch.object(
                RELEASE.os, "link", side_effect=track_link
            ), mock.patch.object(
                RELEASE, "fsync_dir", side_effect=track_fsync
            ), mock.patch.object(
                RELEASE, "verify_regular_identity", side_effect=verify_identity
            ), mock.patch.object(
                RELEASE, "verify_transition_permit", side_effect=verify_consumer
            ), mock.patch.object(RELEASE, "_validate_transition_permit_directory") as validate_directory:
                permit_path = RELEASE._install_transition_permit(RUN_ID, permit_bytes, bundle=bundle)
            fchown.assert_called_once_with(mock.ANY, 0, 0)
            validate_directory.assert_called_once_with(permit_dir)
            self.assertEqual(permit_path, permit_dir / f"{RUN_ID}.json")
            self.assertEqual(len(identities), 2)
            self.assertNotEqual(identities[0], permit_path)
            self.assertEqual(identities[1], permit_path)
            self.assertEqual(
                [event[0] for event in publication_events],
                ["fsync", "link", "fsync", "fsync"],
            )
            self.assertEqual(
                [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")],
                [],
            )
            with mock.patch.object(RELEASE, "read_regular", return_value=permit_path.read_bytes()):
                verified = RELEASE.verify_transition_permit(
                    permit_path,
                    expected_digest,
                    bundle=bundle,
                    run_id=RUN_ID,
                )
            self.assertEqual(verified.document, permit_document)
            self.assertEqual(verified.digest, expected_digest)

    def test_transition_permit_post_link_failure_preserves_two_links_for_consumer_rejection(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_document = RELEASE._build_transition_permit_document(
            bundle,
            RUN_ID,
            transition_observation(bundle),
        )
        permit_bytes = canonical(permit_document)

        def verify_consumer(path, expected_digest, *, bundle, run_id):
            return RELEASE.TransitionPermit(Path(path).absolute(), permit_document, expected_digest)

        def fail_destination_identity(_path, *, expected_nlink=1, **_kwargs):
            if expected_nlink == 2:
                raise RELEASE.DeployError("POST_LINK_VERIFY_FAILED")

        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", permit_dir), mock.patch.object(
                RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
            ), mock.patch.object(RELEASE.os, "fchown"), mock.patch.object(
                RELEASE,
                "verify_regular_identity",
                side_effect=fail_destination_identity,
            ), mock.patch.object(
                RELEASE, "verify_transition_permit", side_effect=verify_consumer
            ), self.assertRaisesRegex(RELEASE.DeployError, "POST_LINK_VERIFY_FAILED"):
                RELEASE._install_transition_permit(RUN_ID, permit_bytes, bundle=bundle)
            guards = [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")]
            self.assertTrue(destination.is_file())
            self.assertEqual(len(guards), 1)
            self.assertEqual(destination.stat().st_ino, guards[0].stat().st_ino)
            self.assertEqual(destination.stat().st_nlink, 2)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            guards[0].unlink()
            self.assertEqual(destination.stat().st_nlink, 1)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            with self.assertRaises(RELEASE.DeployError):
                RELEASE.read_regular(destination, expected_mode=0o600)

    def test_transition_permit_guard_relink_failure_tombstones_without_deleting_destination(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_document = RELEASE._build_transition_permit_document(
            bundle,
            RUN_ID,
            transition_observation(bundle),
        )
        permit_bytes = canonical(permit_document)
        real_link = os.link
        fsync_calls = 0

        def fail_guard_link(source, destination, **kwargs):
            if Path(destination).name.startswith(f".{RUN_ID}."):
                raise OSError("injected guard-link failure")
            return real_link(source, destination, **kwargs)

        def fail_post_unlink_fsync(path):
            nonlocal fsync_calls
            fsync_calls += 1
            hidden = [item for item in Path(path).iterdir() if item.name.startswith(f".{RUN_ID}.")]
            if destination.exists() and not hidden:
                raise OSError("injected post-unlink fsync failure")

        def verify_consumer(path, expected_digest, *, bundle, run_id):
            return RELEASE.TransitionPermit(Path(path).absolute(), permit_document, expected_digest)

        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", permit_dir), mock.patch.object(
                RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
            ), mock.patch.object(RELEASE.os, "fchown"), mock.patch.object(
                RELEASE.os, "link", side_effect=fail_guard_link
            ), mock.patch.object(
                RELEASE, "fsync_dir", side_effect=fail_post_unlink_fsync
            ), mock.patch.object(
                RELEASE, "verify_regular_identity"
            ), mock.patch.object(
                RELEASE, "verify_transition_permit", side_effect=verify_consumer
            ), mock.patch.object(
                RELEASE, "_validate_transition_permit_directory"
            ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_INSTALL_FAILED"):
                RELEASE._install_transition_permit(RUN_ID, permit_bytes, bundle=bundle)
            self.assertTrue(destination.exists())
            self.assertEqual(destination.stat().st_size, len(permit_bytes))
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            self.assertEqual(destination.stat().st_nlink, 1)
            self.assertEqual(fsync_calls, 3)
            with self.assertRaises(RELEASE.DeployError):
                RELEASE.read_regular(destination, expected_mode=0o600)

    def test_transition_permit_guard_fsync_failure_tombstones_without_deleting_destination(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_document = RELEASE._build_transition_permit_document(
            bundle,
            RUN_ID,
            transition_observation(bundle),
        )
        permit_bytes = canonical(permit_document)
        fsync_calls = 0
        post_unlink_failed = False

        def fail_post_unlink_and_guard_fsync(path):
            nonlocal fsync_calls, post_unlink_failed
            fsync_calls += 1
            hidden = [item for item in Path(path).iterdir() if item.name.startswith(f".{RUN_ID}.")]
            if destination.exists() and not hidden and not post_unlink_failed:
                post_unlink_failed = True
                raise OSError("injected directory fsync failure")
            if destination.exists() and hidden and post_unlink_failed:
                raise OSError("injected directory fsync failure")

        def verify_consumer(path, expected_digest, *, bundle, run_id):
            return RELEASE.TransitionPermit(Path(path).absolute(), permit_document, expected_digest)

        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"
            with mock.patch.object(RELEASE, "TRANSITION_PERMITS_DIR", permit_dir), mock.patch.object(
                RELEASE, "_ensure_transition_permit_directory", return_value=permit_dir
            ), mock.patch.object(RELEASE.os, "fchown"), mock.patch.object(
                RELEASE, "fsync_dir", side_effect=fail_post_unlink_and_guard_fsync
            ), mock.patch.object(
                RELEASE, "verify_regular_identity"
            ), mock.patch.object(
                RELEASE, "verify_transition_permit", side_effect=verify_consumer
            ), mock.patch.object(
                RELEASE, "_validate_transition_permit_directory"
            ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_INSTALL_FAILED"):
                RELEASE._install_transition_permit(RUN_ID, permit_bytes, bundle=bundle)
            guards = [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")]
            self.assertTrue(destination.exists())
            self.assertEqual(destination.stat().st_size, len(permit_bytes))
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            self.assertEqual(len(guards), 1)
            self.assertEqual(destination.stat().st_ino, guards[0].stat().st_ino)
            self.assertEqual(destination.stat().st_nlink, 2)
            self.assertTrue(post_unlink_failed)
            self.assertEqual(fsync_calls, 4)
            with self.assertRaises(RELEASE.DeployError):
                RELEASE.read_regular(destination, expected_mode=0o600)

    def test_issue_roundtrip_failure_quarantines_the_published_permit(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        observed = transition_observation(bundle)
        permit_document = RELEASE._build_transition_permit_document(bundle, RUN_ID, observed)
        snapshot_document = {
            "schema_version": 1,
            "run_id": RUN_ID,
            "target_bundle_sha256": bundle.bundle_digest,
            "permit_candidate_sha256": digest(canonical(permit_document)),
            "current_journal_inventory": observed["current_journal_inventory"],
        }
        with tempfile.TemporaryDirectory() as directory:
            permit_dir = Path(directory)
            destination = permit_dir / f"{RUN_ID}.json"

            def install(_run_id, data, *, bundle):
                destination.write_bytes(data)
                destination.chmod(0o600)
                return destination

            with PatchedLock(self), mock.patch.object(
                RELEASE, "verify_bundle", return_value=bundle
            ), mock.patch.object(
                RELEASE, "_collect_transition_observation", side_effect=[copy.deepcopy(observed), copy.deepcopy(observed)]
            ), mock.patch.object(
                RELEASE, "_install_transition_permit", side_effect=install
            ), mock.patch.object(
                RELEASE,
                "verify_transition_permit",
                side_effect=RELEASE.DeployError("INJECTED_FINAL_ROUNDTRIP_FAILURE"),
            ), self.assertRaisesRegex(RELEASE.DeployError, "INJECTED_FINAL_ROUNDTRIP_FAILURE"):
                RELEASE.issue_transition_permit(
                    Path("/bundle"),
                    RUN_ID,
                    digest(canonical(snapshot_document)),
                )
            guards = [path for path in permit_dir.iterdir() if path.name.startswith(f".{RUN_ID}.")]
            self.assertTrue(destination.exists())
            self.assertEqual(len(guards), 1)
            self.assertEqual(destination.stat().st_ino, guards[0].stat().st_ino)
            self.assertEqual(destination.stat().st_nlink, 2)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            guards[0].unlink()
            self.assertEqual(destination.stat().st_nlink, 1)
            self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o000)
            with self.assertRaises(RELEASE.DeployError):
                RELEASE.read_regular(destination, expected_mode=0o600)

    def test_issue_reports_roundtrip_and_quarantine_failures_without_losing_root_cause(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        observed = transition_observation(bundle)
        permit_document = RELEASE._build_transition_permit_document(bundle, RUN_ID, observed)
        snapshot_document = {
            "schema_version": 1,
            "run_id": RUN_ID,
            "target_bundle_sha256": bundle.bundle_digest,
            "permit_candidate_sha256": digest(canonical(permit_document)),
            "current_journal_inventory": observed["current_journal_inventory"],
        }
        with PatchedLock(self), mock.patch.object(
            RELEASE, "verify_bundle", return_value=bundle
        ), mock.patch.object(
            RELEASE,
            "_collect_transition_observation",
            side_effect=[copy.deepcopy(observed), copy.deepcopy(observed)],
        ), mock.patch.object(
            RELEASE,
            "_install_transition_permit",
            return_value=Path("/opt/flowise/transition-permits") / f"{RUN_ID}.json",
        ), mock.patch.object(
            RELEASE,
            "verify_transition_permit",
            side_effect=RELEASE.DeployError("INJECTED_FINAL_ROUNDTRIP_FAILURE"),
        ), mock.patch.object(
            RELEASE,
            "_quarantine_transition_permit",
            side_effect=RELEASE.DeployError("INJECTED_QUARANTINE_FAILURE"),
        ), self.assertRaisesRegex(
            RELEASE.DeployError,
            "INJECTED_FINAL_ROUNDTRIP_FAILURE:TRANSITION_PERMIT_QUARANTINE_FAILED",
        ) as raised:
            RELEASE.issue_transition_permit(
                Path("/bundle"),
                RUN_ID,
                digest(canonical(snapshot_document)),
            )
        self.assertIsInstance(raised.exception.__cause__, RELEASE.DeployError)
        self.assertEqual(str(raised.exception.__cause__), "INJECTED_QUARANTINE_FAILURE")

    def test_transition_permit_file_owner_mode_link_and_symlink_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "permit.json"
            path.write_bytes(b"{}\n")
            path.chmod(0o600)
            real_fstat = os.fstat

            def stat_value(descriptor, **overrides):
                value = real_fstat(descriptor)
                fields = {
                    "st_mode": value.st_mode,
                    "st_nlink": value.st_nlink,
                    "st_uid": 0,
                    "st_gid": 0,
                    "st_size": value.st_size,
                    "st_dev": value.st_dev,
                    "st_ino": value.st_ino,
                    "st_mtime_ns": value.st_mtime_ns,
                }
                fields.update(overrides)
                return types.SimpleNamespace(**fields)

            for label, overrides in (
                ("owner", {"st_uid": 501}),
                ("mode", {"st_mode": 0o100640}),
                ("link", {"st_nlink": 2}),
            ):
                with self.subTest(label=label), mock.patch.object(
                    RELEASE.os, "fstat", side_effect=lambda descriptor, values=overrides: stat_value(descriptor, **values)
                ), self.assertRaises(RELEASE.DeployError):
                    RELEASE.read_regular(path, expected_uid=0, expected_gid=0, expected_mode=0o600)

            symlink = root / "permit-link.json"
            symlink.symlink_to(path)
            with self.assertRaises(RELEASE.DeployError):
                RELEASE.read_regular(symlink, expected_uid=0, expected_gid=0, expected_mode=0o600)

    def test_transition_permit_rejects_target_equal_to_active_legacy(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"legacy-bundle"),
            revision=LEGACY_REVISION,
            image_tag=LEGACY_TAG,
            image_config_digest=LEGACY_DIGEST,
        )
        permit_bytes = canonical(transition_permit_document(bundle))
        with mock.patch.object(RELEASE, "read_regular", return_value=permit_bytes), self.assertRaisesRegex(
            RELEASE.DeployError, "TARGET_NOT_DISTINCT_FROM_ACTIVE_LEGACY"
        ):
            RELEASE.verify_transition_permit(
                Path("/permit.json"),
                digest(permit_bytes),
                bundle=bundle,
                run_id=RUN_ID,
            )

    def test_invalid_bootstrap_permit_cannot_trigger_recovery_or_live_write(self):
        recover = mock.Mock()
        write = mock.Mock()
        with PatchedLock(self), mock.patch.object(RELEASE, "verify_bundle", return_value=mock.Mock()), mock.patch.object(
            RELEASE,
            "verify_transition_permit",
            side_effect=RELEASE.DeployError("TRANSITION_PERMIT_DIGEST_MISMATCH"),
        ), mock.patch.object(RELEASE, "_recover_interrupted_runs", recover), mock.patch.object(
            RELEASE,
            "install_config_set",
            write,
        ), self.assertRaisesRegex(RELEASE.DeployError, "TRANSITION_PERMIT_DIGEST_MISMATCH"):
            RELEASE.bootstrap(Path("/bundle"), RUN_ID, Path("/permit"), digest(b"bad"))
        recover.assert_not_called()
        write.assert_not_called()

    def test_stale_or_unrelated_valid_bootstrap_permit_cannot_trigger_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = types.SimpleNamespace(
                bundle_digest=digest(b"bundle"),
                revision=REVISION,
                image_tag=CANDIDATE_TAG,
                image_config_digest=CANDIDATE_DIGEST,
            )
            permit = RELEASE.TransitionPermit(
                Path("/permit.json"),
                transition_permit_document(bundle),
                digest(b"permit"),
            )
            for error in (
                "BOOTSTRAP_ACTIVE_IMAGE_IDENTITY_MISMATCH",
                "CURRENT_JOURNAL_UNRESOLVED_ROLLBACK",
            ):
                recover = mock.Mock()
                restore = mock.Mock()
                install = mock.Mock()
                with self.subTest(error=error), PatchedLock(self), mock.patch.object(
                    RELEASE, "RUNS_DIR", Path(directory)
                ), mock.patch.object(RELEASE, "verify_bundle", return_value=bundle), mock.patch.object(
                    RELEASE, "verify_transition_permit", return_value=permit
                ), mock.patch.object(
                    RELEASE, "_bootstrap_preflight", side_effect=RELEASE.DeployError(error)
                ), mock.patch.object(RELEASE, "_recover_interrupted_runs", recover), mock.patch.object(
                    RELEASE, "_restore_legacy_frozen", restore
                ), mock.patch.object(RELEASE, "install_config_set", install), self.assertRaisesRegex(
                    RELEASE.DeployError, error
                ):
                    RELEASE.bootstrap(Path("/bundle"), RUN_ID, Path("/permit"), digest(b"permit"))
                recover.assert_not_called()
                restore.assert_not_called()
                install.assert_not_called()

    def test_reused_bootstrap_run_is_checked_only_by_its_exact_scoped_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()
            bundle = types.SimpleNamespace(
                bundle_digest=digest(b"bundle"),
                revision=REVISION,
                image_tag=CANDIDATE_TAG,
                image_config_digest=CANDIDATE_DIGEST,
            )
            permit = RELEASE.TransitionPermit(
                Path("/permit.json"),
                transition_permit_document(bundle),
                digest(b"permit"),
            )
            (run_dir / "journal.json").write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                        "operation": "bootstrap",
                        "state": "bootstrap_failed_before_live_write",
                        "run_id": RUN_ID,
                        "permit_digest": permit.digest,
                        "target_bundle_digest": bundle.bundle_digest,
                    }
                )
            )
            preflight = mock.Mock()
            restore = mock.Mock()
            with PatchedLock(self), mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "verify_bundle", return_value=bundle
            ), mock.patch.object(RELEASE, "verify_transition_permit", return_value=permit), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_bootstrap_preflight", preflight), mock.patch.object(
                RELEASE, "_execute_legacy_rollback_transaction", restore
            ), self.assertRaisesRegex(RELEASE.DeployError, "RUN_DIRECTORY_EXISTS"):
                RELEASE.bootstrap(Path("/bundle"), RUN_ID, Path("/permit"), digest(b"permit"))
            preflight.assert_not_called()
            restore.assert_not_called()

    def test_receipt_policy_is_exact_and_never_defaults(self):
        prepared = bootstrap_prepare_receipt()
        RELEASE._validate_receipt_policy(prepared, "bootstrap-prepare")
        for policy in (None, {}, {**RELEASE.LEGACY_BOOTSTRAP_POLICY, "allow_legacy": "true"}):
            mutated = copy.deepcopy(prepared)
            if policy is None:
                mutated.pop("policy")
            else:
                mutated["policy"] = policy
            with self.assertRaises(RELEASE.DeployError):
                RELEASE._validate_receipt_policy(mutated, "bootstrap-prepare")

    def test_legacy_release_scoped_inventory_is_canonical_associated_and_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / "flowise"
            releases = base / "releases"
            release_names = [f"git-{LEGACY_REVISION}"] + [f"git-{index:040x}" for index in range(1, 15)]
            release_roots = [releases / name for name in release_names]
            for release_root in release_roots:
                release_root.mkdir(parents=True)
            deployment_roots = [release_root / "deployments" for release_root in release_roots[:14]]
            for deployments in deployment_roots:
                deployments.mkdir()

            run_paths = []
            control_documents = {}
            post_timestamps = (
                "20260720T150640.721324Z",
                "20260722T023513.141204Z",
                "20260722T193926.760368Z",
                "20260723T060422.087704Z",
            )
            for index in range(18):
                controls: dict[str, dict[str, Any]]
                run_id = f"202607{index + 1:02d}T120000Z-{index:08x}"
                run = deployment_roots[index % len(deployment_roots)] / run_id
                run.mkdir()
                run_paths.append(run)
                if index < 15:
                    controls = {
                        "prepare-status.json": legacy_control_document(
                            "prepare-status.json",
                            "prepared",
                            "prepared_cutover_ready",
                            run_id=run_id,
                        ),
                        "cutover-status.json": legacy_control_document(
                            "cutover-status.json",
                            "complete_candidate_active",
                            "complete_candidate_active",
                            run_id=run_id,
                        ),
                    }
                    if 11 <= index < 15:
                        timestamp = post_timestamps[index - 11]
                        controls[f"post-acceptance-rollback-{timestamp}.json"] = legacy_control_document(
                            "post-acceptance-rollback",
                            "post_acceptance_rolled_back",
                            run_id=run_id,
                        )
                else:
                    failed_phases = ("candidate_loaded", "validated_pre_load", "initialized")
                    phase = failed_phases[index - 15]
                    controls = {
                        "prepare-status.json": legacy_control_document(
                            "prepare-status.json",
                            "failed",
                            phase,
                            run_id=run_id,
                        )
                    }
                if index == 0:
                    controls["compose-cutover-status.json"] = legacy_control_document(
                        "compose-cutover-status.json",
                        "complete_candidate_active",
                        "complete_candidate_compose_active",
                        run_id=run_id,
                    )
                elif index in (11, 12):
                    controls["compose-cutover-status.json"] = legacy_control_document(
                        "compose-cutover-status.json",
                        "post_acceptance_rolled_back",
                        "post_acceptance_rollback_compose_restored",
                        run_id=run_id,
                    )
                if index == 15:
                    controls["candidate-manifest-attempt.json"] = legacy_control_document(
                        "candidate-manifest-attempt.json",
                        run_id=run_id,
                    )
                for name, value in controls.items():
                    if "release_id" in value:
                        value["release_id"] = run.parent.parent.name
                    path = run / name
                    path.write_text(json.dumps(value, indent=2))
                    path.chmod(0o600)
                    relative = path.relative_to(releases).as_posix()
                    control_documents[relative] = value

            base.chmod(0o755)
            for path in (releases, *release_roots, *deployment_roots, *run_paths):
                path.chmod(0o700)

            real_lstat = Path.lstat

            def root_lstat(path):
                value = real_lstat(path)
                if Path(path).name == "flowise-node24-20260710-authorized-v2.tar.gz":
                    uid, gid, size = 1000, 1000, 1_132_842_786
                else:
                    uid, gid, size = 0, 0, value.st_size
                return types.SimpleNamespace(
                    st_mode=value.st_mode,
                    st_nlink=value.st_nlink,
                    st_uid=uid,
                    st_gid=gid,
                    st_size=size,
                    st_dev=value.st_dev,
                    st_ino=value.st_ino,
                    st_mtime_ns=value.st_mtime_ns,
                )

            def relaxed_read(path, **_kwargs):
                if Path(path).name in RELEASE.LEGACY_NON_JOURNAL_FILE_SIBLINGS:
                    raise AssertionError("non-journal sibling content must not be read")
                return Path(path).read_bytes()

            common = (
                mock.patch.object(RELEASE, "BASE_DIR", base),
                mock.patch.object(RELEASE, "LEGACY_RELEASES_DIR", releases),
                mock.patch.object(Path, "lstat", autospec=True, side_effect=root_lstat),
                mock.patch.object(RELEASE, "read_regular", side_effect=relaxed_read),
            )
            with _MultiPatch(common):
                journal_only_inventory = RELEASE.legacy_journal_inventory()

            for name in RELEASE.LEGACY_NON_JOURNAL_DIRECTORY_SIBLINGS:
                (releases / name).mkdir(mode=0o700)
            sibling_lock = releases / ".flowise-backup-permission-hardening.lock"
            sibling_lock.write_bytes(b"")
            sibling_lock.chmod(0o600)
            sibling_archive = releases / "flowise-node24-20260710-authorized-v2.tar.gz"
            sibling_archive.write_bytes(b"legacy archive")
            sibling_archive.chmod(0o600)
            with _MultiPatch(common):
                inventory = RELEASE.legacy_journal_inventory()
            self.assertEqual(inventory, journal_only_inventory)
            expected_records = [
                {"path": path, "canonical_sha256": digest(canonical(document))}
                for path, document in sorted(control_documents.items())
            ]
            self.assertEqual(len(run_paths), 18)
            self.assertEqual(len(deployment_roots), 14)
            self.assertEqual(len(release_roots), 15)
            self.assertEqual(inventory["root_count"], 14)
            self.assertEqual(inventory["run_count"], 18)
            self.assertEqual(inventory["control_count"], 41)
            self.assertEqual(inventory["canonical_inventory_sha256"], digest(canonical(expected_records)))
            self.assertEqual(inventory["root_paths"], sorted(str(path) for path in deployment_roots))
            self.assertEqual(inventory["unresolved_rollback_count"], 0)

            unknown = run_paths[0] / "mystery-status.json"
            unknown.write_bytes(canonical({"state": "complete"}))
            unknown.chmod(0o600)
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "CONTROL_JSON_NAME_UNKNOWN"):
                RELEASE.legacy_journal_inventory()
            unknown.unlink()

            mismatched_run_path = run_paths[0] / "cutover-status.json"
            original_control = json.loads(mismatched_run_path.read_text())
            mismatched_control = copy.deepcopy(original_control)
            mismatched_control["run_id"] = "20260727T130000Z-feedface"
            mismatched_run_path.write_bytes(canonical(mismatched_control))
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "RUN_ID_MISMATCH"):
                RELEASE.legacy_journal_inventory()
            mismatched_run_path.write_bytes(canonical(original_control))

            unknown_release = releases / "not-a-release"
            unknown_release.mkdir(mode=0o700)
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "RELEASE_ROOT_UNKNOWN"):
                RELEASE.legacy_journal_inventory()
            unknown_release.rmdir()

            collision = releases / "browser-acceptance" / "deployments"
            collision.mkdir(mode=0o700)
            with _MultiPatch(common), self.assertRaisesRegex(
                RELEASE.DeployError, "SIBLING_DEPLOYMENTS_COLLISION"
            ):
                RELEASE.legacy_journal_inventory()
            collision.rmdir()

            control_path = run_paths[0] / "prepare-status.json"
            in_progress = json.loads(control_path.read_text())
            in_progress.update({"state": "in_progress", "phase": "validated_pre_load"})
            control_path.write_bytes(canonical(in_progress))
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "UNRESOLVED_ROLLBACK"):
                RELEASE.legacy_journal_inventory()

    def test_legacy_non_journal_file_siblings_require_exact_safe_metadata(self):
        def sibling(name, *, kind=stat.S_IFREG, mode=0o600, links=1, uid=0, gid=0, size=1):
            path = mock.Mock()
            path.name = name
            path.lstat.return_value = types.SimpleNamespace(
                st_mode=kind | mode,
                st_nlink=links,
                st_uid=uid,
                st_gid=gid,
                st_size=size,
            )
            return path

        def archive(**overrides):
            values = {"uid": 1000, "gid": 1000, "size": 1_132_842_786}
            values.update(overrides)
            return sibling("flowise-node24-20260710-authorized-v2.tar.gz", **values)

        RELEASE._validate_legacy_non_journal_sibling(
            sibling(".flowise-backup-permission-hardening.lock", size=0)
        )
        RELEASE._validate_legacy_non_journal_sibling(archive())

        invalid = [
            ("lock_nonempty", sibling(".flowise-backup-permission-hardening.lock", size=1), "SIZE_INVALID"),
            ("archive_size_low", archive(size=1_132_842_785), "SIZE_INVALID"),
            ("archive_size_high", archive(size=1_132_842_787), "SIZE_INVALID"),
            ("hardlink", archive(links=2), "FILE_UNSAFE"),
            ("owner", archive(uid=0, gid=0), "FILE_UNSAFE"),
            ("mixed_owner", archive(uid=1000, gid=0), "FILE_UNSAFE"),
            ("mixed_group", archive(uid=0, gid=1000), "FILE_UNSAFE"),
            ("mode", archive(mode=0o644), "FILE_UNSAFE"),
            ("unknown", sibling("flowise-node24-20260710-authorized-v3.tar.gz"), "RELEASE_ROOT_UNKNOWN"),
        ]
        invalid.extend(
            (label, archive(kind=kind), "FILE_UNSAFE")
            for label, kind in (
                ("directory", stat.S_IFDIR),
                ("symlink", stat.S_IFLNK),
                ("fifo", stat.S_IFIFO),
                ("socket", stat.S_IFSOCK),
                ("character_device", stat.S_IFCHR),
                ("block_device", stat.S_IFBLK),
            )
        )
        for label, path, error in invalid:
            with self.subTest(label=label), self.assertRaisesRegex(RELEASE.DeployError, error) as raised:
                RELEASE._validate_legacy_non_journal_sibling(path)
            self.assertNotIn("sentinel-secret-value", str(raised.exception))

        unavailable = archive()
        unavailable.lstat.side_effect = OSError("sentinel-secret-value")
        with self.assertRaisesRegex(RELEASE.DeployError, "SIBLING_FILE_UNAVAILABLE") as raised:
            RELEASE._validate_legacy_non_journal_sibling(unavailable)
        self.assertNotIn("sentinel-secret-value", str(raised.exception))

    def test_legacy_non_journal_directory_siblings_reject_unsafe_metadata_and_hidden_journals(self):
        def sibling(info, *, deployments=None):
            path = mock.MagicMock()
            path.name = "browser-acceptance"
            path.lstat.return_value = info
            child = mock.Mock()
            child.lstat.side_effect = FileNotFoundError if deployments is None else None
            if deployments is not None:
                child.lstat.return_value = deployments
            path.__truediv__.return_value = child
            return path

        safe = types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o700,
            st_uid=0,
            st_gid=0,
            st_nlink=99,
            st_size=1,
        )
        RELEASE._validate_legacy_non_journal_sibling(sibling(safe))

        unsafe = (
            ("owner", types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=1000, st_gid=0)),
            ("group", types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=1000)),
            ("mode", types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0)),
            ("symlink", types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o700, st_uid=0, st_gid=0)),
            ("file", types.SimpleNamespace(st_mode=stat.S_IFREG | 0o700, st_uid=0, st_gid=0)),
        )
        for label, info in unsafe:
            with self.subTest(label=label), self.assertRaisesRegex(RELEASE.DeployError, "DIRECTORY_UNSAFE"):
                RELEASE._validate_legacy_non_journal_sibling(sibling(info))

        with self.assertRaisesRegex(RELEASE.DeployError, "SIBLING_DEPLOYMENTS_COLLISION"):
            RELEASE._validate_legacy_non_journal_sibling(sibling(safe, deployments=safe))

        for name in (
            "flowise-node24-20260710-authorized-v3.tar.gz",
            "flowise-node24-20260710-authorized-v2.tar.gz.bak",
            "Flowise-node24-20260710-authorized-v2.tar.gz",
            "browser-acceptance-copy",
            "sentinel-secret-value",
        ):
            path = mock.Mock()
            path.name = name
            with self.subTest(name=name), self.assertRaisesRegex(
                RELEASE.DeployError, "LEGACY_JOURNAL_RELEASE_ROOT_UNKNOWN"
            ) as raised:
                RELEASE._validate_legacy_non_journal_sibling(path)
            self.assertNotIn("sentinel-secret-value", str(raised.exception))

    def test_legacy_inventory_rejects_unsafe_directory_metadata_and_bad_post_timestamp(self):
        safe = types.SimpleNamespace(st_mode=0o040700, st_uid=0, st_gid=0)
        for label, value in (
            ("owner", types.SimpleNamespace(st_mode=0o040700, st_uid=501, st_gid=0)),
            ("mode", types.SimpleNamespace(st_mode=0o040755, st_uid=0, st_gid=0)),
            ("symlink", types.SimpleNamespace(st_mode=0o120700, st_uid=0, st_gid=0)),
        ):
            path = mock.Mock(lstat=mock.Mock(return_value=value))
            with self.subTest(label=label), self.assertRaisesRegex(RELEASE.DeployError, "DIRECTORY_UNSAFE"):
                RELEASE._validate_inventory_directory(path, "LEGACY_JOURNAL")
        RELEASE._validate_inventory_directory(mock.Mock(lstat=mock.Mock(return_value=safe)), "LEGACY_JOURNAL")
        with self.assertRaisesRegex(RELEASE.DeployError, "TIMESTAMP_INVALID"):
            RELEASE._legacy_control_kind("post-acceptance-rollback-20260230T120000.000000Z.json")

        observed = legacy_control_document(
            "prepare-status.json",
            "prepared",
            "prepared_cutover_ready",
        )
        RELEASE._validate_legacy_control(observed, "prepare-status.json")
        with self.assertRaisesRegex(RELEASE.DeployError, "CONTROL_SCHEMA_FIELDS_INVALID"):
            RELEASE._validate_legacy_control({**observed, "unobserved": True}, "prepare-status.json")

        valid = {
            RUN_ID: [
                ("prepare-status.json", "prepared"),
                ("cutover-status.json", "complete_candidate_active"),
                ("compose-cutover-status.json", "complete_candidate_active"),
            ]
        }
        RELEASE._validate_legacy_run_associations(valid)
        duplicate = copy.deepcopy(valid)
        duplicate[RUN_ID].append(("compose-cutover-status.json", "complete_candidate_active"))
        with self.assertRaisesRegex(RELEASE.DeployError, "RUN_ASSOCIATION_INVALID"):
            RELEASE._validate_legacy_run_associations(duplicate)

    def test_current_journal_inventory_keeps_normal_receipts_compatible_but_requires_bootstrap_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "deployments"
            run = root / RUN_ID
            run.mkdir(parents=True)
            root.chmod(0o700)
            run.chmod(0o700)
            journal = run / "journal.json"
            normal_journal = {
                "schema_version": 1,
                "operation": "prepare",
                "state": "prepared",
                "run_id": RUN_ID,
            }
            journal.write_bytes(canonical(normal_journal))
            journal.chmod(0o600)
            real_lstat = Path.lstat

            def root_lstat(path):
                value = real_lstat(path)
                return types.SimpleNamespace(
                    st_mode=value.st_mode,
                    st_nlink=value.st_nlink,
                    st_uid=0,
                    st_gid=0,
                    st_size=value.st_size,
                    st_dev=value.st_dev,
                    st_ino=value.st_ino,
                    st_mtime_ns=value.st_mtime_ns,
                )

            common = (
                mock.patch.object(Path, "lstat", autospec=True, side_effect=root_lstat),
                mock.patch.object(RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()),
            )
            with _MultiPatch(common):
                records, unresolved = RELEASE._current_deployments_inventory(root)
            self.assertEqual((len(records), unresolved), (1, 0))
            with _MultiPatch(common):
                excluded_records, excluded_unresolved = RELEASE._current_deployments_inventory(
                    root,
                    exclude_run_id=RUN_ID,
                )
            self.assertEqual((excluded_records, excluded_unresolved), ([], 0))

            journal.write_bytes(canonical({key: value for key, value in normal_journal.items() if key != "run_id"}))
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "CONTROL_JSON_STATE_INVALID"):
                RELEASE._current_deployments_inventory(root)
            journal.write_bytes(canonical(normal_journal))

            unknown = run / "unknown-control.json"
            unknown.write_bytes(canonical({"state": "complete"}))
            unknown.chmod(0o600)
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "CONTROL_JSON_NAME_UNKNOWN"):
                RELEASE._current_deployments_inventory(root)
            unknown.unlink()

            journal.write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "operation": "bootstrap",
                        "state": "complete_hardened_baseline",
                        "run_id": RUN_ID,
                    }
                )
            )
            with _MultiPatch(common), self.assertRaisesRegex(RELEASE.DeployError, "BOOTSTRAP_JOURNAL_POLICY"):
                RELEASE._current_deployments_inventory(root)

            journal.write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                        "operation": "bootstrap",
                        "state": "complete_hardened_baseline",
                        "run_id": RUN_ID,
                    }
                )
            )
            with _MultiPatch(common):
                records, unresolved = RELEASE._current_deployments_inventory(root)
            self.assertEqual((len(records), unresolved), (1, 0))

    def test_bootstrap_cas_rechecks_current_journal_inventory_excluding_its_own_run(self):
        compared = (
            "snapshot",
            "active_tag",
            "active_revision",
            "active_image_digest",
            "active_image",
            "live_env",
            "live_compose",
            "live_seccomp",
            "live_hashes",
            "live_metadata",
            "legacy_config",
            "legacy_config_hash",
            "legacy_runtime_label_hash",
            "legacy_environment",
            "legacy_runtime",
            "database",
            "network_identity",
            "legacy_journal_inventory",
        )
        initial: dict[str, Any] = {name: {"same": name} for name in compared}
        initial["key"] = b"k" * 32
        initial["current_journal_inventory"] = {
            "root": str(RELEASE.RUNS_DIR),
            "present": False,
            "control_json_count": 0,
            "control_json_sha256": digest(canonical([])),
            "unresolved_rollback_count": 0,
        }
        current = copy.deepcopy(initial)
        current["current_journal_inventory"]["present"] = True
        RELEASE._validate_bootstrap_cas(initial, current)
        current["current_journal_inventory"]["control_json_count"] = 1
        with self.assertRaisesRegex(RELEASE.DeployError, "CURRENT_JOURNAL_CAS_MISMATCH"):
            RELEASE._validate_bootstrap_cas(initial, current)

    def test_verify_bundle_binds_exact_payload_manifest_archive_and_wrapper(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)

            def relaxed_read(path, **_kwargs):
                return Path(path).read_bytes()

            def relaxed_identity(path, *, expected_bytes, expected_digest, **_kwargs):
                value = Path(path).read_bytes()
                self.assertEqual((len(value), digest(value)), (expected_bytes, expected_digest))

            with mock.patch.object(RELEASE, "read_regular", side_effect=relaxed_read), mock.patch.object(
                RELEASE, "verify_regular_identity", side_effect=relaxed_identity
            ):
                bundle = RELEASE.verify_bundle(fixture.root)
            self.assertEqual(bundle.image_tag, CANDIDATE_TAG)
            self.assertEqual(bundle.release_id, f"git-{REVISION}")
            self.assertEqual(set(bundle.files), set(RELEASE.EXPECTED_BUNDLE_FILES))

    def test_verify_bundle_rejects_wrapper_that_is_not_the_executing_source(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            different_wrapper = fixture.root / "different-executing-wrapper.py"
            different_wrapper.write_bytes(MODULE_PATH.read_bytes() + b"\n# different execution source\n")

            def relaxed_identity(path, *, expected_bytes, expected_digest, **_kwargs):
                value = Path(path).read_bytes()
                self.assertEqual((len(value), digest(value)), (expected_bytes, expected_digest))

            with mock.patch.object(RELEASE, "SCRIPT_PATH", different_wrapper), mock.patch.object(
                RELEASE,
                "read_regular",
                side_effect=lambda path, **_kwargs: Path(path).read_bytes(),
            ), mock.patch.object(
                RELEASE, "verify_regular_identity", side_effect=relaxed_identity
            ), self.assertRaisesRegex(RELEASE.DeployError, "BUNDLE_WRAPPER_EXECUTION_MISMATCH"):
                RELEASE.verify_bundle(fixture.root)

            with mock.patch.object(RELEASE, "SCRIPT_PATH", different_wrapper), mock.patch.object(
                RELEASE,
                "read_regular",
                side_effect=lambda path, **_kwargs: Path(path).read_bytes(),
            ), mock.patch.object(RELEASE, "verify_regular_identity", side_effect=relaxed_identity):
                historical = RELEASE.verify_source_bundle(fixture.root)
            self.assertEqual(historical.bundle_digest, digest((fixture.root / "deployment-bundle.json").read_bytes()))

    def test_bundle_payload_rebound_without_manifest_update_fails_before_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            compose_path = fixture.root / "docker-compose.prod.yml"
            changed = compose_path.read_bytes() + b"# tampered\n"
            compose_path.write_bytes(changed)
            bundle_path = fixture.root / "deployment-bundle.json"
            document = json.loads(bundle_path.read_text())
            entry = next(item for item in document["files"] if item["role"] == "production_compose")
            entry.update({"bytes": len(changed), "digest": digest(changed)})
            bundle_path.write_bytes(canonical(document))

            def relaxed_identity(path, *, expected_bytes, expected_digest, **_kwargs):
                value = Path(path).read_bytes()
                self.assertEqual((len(value), digest(value)), (expected_bytes, expected_digest))

            with mock.patch.object(RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()), mock.patch.object(
                RELEASE, "verify_regular_identity", side_effect=relaxed_identity
            ), mock.patch.object(RELEASE, "run_command", side_effect=AssertionError("Docker must not run")), self.assertRaisesRegex(
                RELEASE.DeployError, "BUNDLE_MANIFEST_INPUT_MISMATCH_PRODUCTION_COMPOSE"
            ):
                RELEASE.verify_bundle(fixture.root)

    def test_manifest_requires_fixed_toolchain_exact_inputs_and_canonical_env_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            original = json.loads((fixture.root / "release-manifest.json").read_text())
            cases = []
            wrong_toolchain = copy.deepcopy(original)
            wrong_toolchain["toolchain"]["node"] = "v24.18.1"
            cases.append(("toolchain", wrong_toolchain, "RELEASE_MANIFEST_TOOLCHAIN_INVALID"))
            missing_input = copy.deepcopy(original)
            missing_input["inputs"]["files"].pop()
            cases.append(("input", missing_input, "RELEASE_MANIFEST_INPUT_SET_INVALID"))
            duplicate_env = copy.deepcopy(original)
            duplicate_env["inputs"]["env_template"]["keys"] = ["FLOWISE_IMAGE", "FLOWISE_IMAGE"]
            duplicate_env["inputs"]["env_template"]["keys_digest"] = digest(b"FLOWISE_IMAGE\nFLOWISE_IMAGE\n")
            cases.append(("env", duplicate_env, "RELEASE_MANIFEST_ENV_TEMPLATE_INVALID"))
            for label, manifest, error in cases:
                with self.subTest(label=label), self.assertRaisesRegex(RELEASE.DeployError, error):
                    RELEASE.validate_release_manifest(manifest)

    def test_python_wrapper_manifest_inputs_match_node_manifest_validator(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            script = """
import fs from 'node:fs'
const { validateManifest } = await import(process.argv[1])
validateManifest(JSON.parse(fs.readFileSync(0, 'utf8')))
"""
            result = subprocess.run(
                [
                    "node",
                    "--input-type=module",
                    "--eval",
                    script,
                    MODULE_PATH.with_name("release-manifest.mjs").as_uri(),
                ],
                input=(fixture.root / "release-manifest.json").read_text(),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_evidence_rejects_bad_hash_boolean_and_line_order(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            bundle_document = json.loads((fixture.root / "deployment-bundle.json").read_text())
            entries = {entry["role"]: entry for entry in bundle_document["files"]}
            manifest = json.loads((fixture.root / "release-manifest.json").read_text())
            evidence = (fixture.root / "evidence.txt").read_bytes()
            variants = {
                "hash": evidence.replace(b"archive_sha256=", b"archive_sha256=0", 1),
                "boolean": evidence.replace(b"registry_push=false", b"registry_push=true"),
                "buildx": evidence.replace(b"buildx_version=v0.34.1", b"buildx_version=v0.34.0"),
                "buildkit": evidence.replace(b"buildkit_version=v0.30.0", b"buildkit_version=v0.29.0"),
                "order": b"\n".join(reversed(evidence.rstrip(b"\n").split(b"\n"))) + b"\n",
            }
            for label, value in variants.items():
                with self.subTest(label=label), self.assertRaises(RELEASE.DeployError):
                    RELEASE.validate_release_evidence(
                        value,
                        manifest=manifest,
                        entries=entries,
                        revision=REVISION,
                        image_tag=CANDIDATE_TAG,
                        image_config_digest=manifest["image"]["config_digest"],
                    )

    def test_compose_and_runtime_reject_every_dangerous_surface(self):
        candidate, rollback = resolved_compose()
        RELEASE.validate_compose(candidate, rollback, CANDIDATE_TAG, ROLLBACK_TAG, b"k" * 32)
        compose_variants = {
            "no-new-privileges-false": ("security_opt", ["no-new-privileges:false", "seccomp=./docker/seccomp/chromium.json"]),
            "arbitrary-seccomp": ("security_opt", ["no-new-privileges:true", "seccomp=/tmp/unknown.json"]),
            "privileged": ("privileged", True),
            "cap-add": ("cap_add", ["NET_ADMIN"]),
            "host-pid": ("pid", "host"),
            "host-ipc": ("ipc", "host"),
            "host-network": ("network_mode", "host"),
            "devices": ("devices", ["/dev/sda:/dev/sda"]),
        }
        for label, (field, value) in compose_variants.items():
            mutated = copy.deepcopy(candidate)
            mutated["services"]["flowise"][field] = value
            with self.subTest(layer="compose", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE.validate_compose(mutated, rollback, CANDIDATE_TAG, ROLLBACK_TAG, b"k" * 32)

        matched_unsafe_compose_variants = []
        for label, mutate in (
            (
                "attacker-database-host",
                lambda document: document["services"]["flowise"]["environment"].update({"DATABASE_HOST": "attacker"}),
            ),
            (
                "mysql-database-type",
                lambda document: document["services"]["flowise"]["environment"].update({"DATABASE_TYPE": "mysql"}),
            ),
            (
                "different-database-name",
                lambda document: document["services"]["flowise"]["environment"].update({"DATABASE_NAME": "other"}),
            ),
            (
                "database-ssl-enabled",
                lambda document: document["services"]["flowise"]["environment"].update({"DATABASE_SSL": "true"}),
            ),
            (
                "host-bind-volume-driver",
                lambda document: document["volumes"]["flowise_data"].update(
                    {"driver_opts": {"type": "none", "o": "bind", "device": "/"}}
                ),
            ),
            (
                "arbitrary-volume-name",
                lambda document: document["volumes"]["flowise_data"].update({"name": "attacker_volume"}),
            ),
            (
                "arbitrary-network-name",
                lambda document: document["networks"]["flowise_network"].update({"name": "attacker_network"}),
            ),
            (
                "remote-logging-driver",
                lambda document: document["services"]["flowise"].update(
                    {"logging": {"driver": "syslog", "options": {"syslog-address": "tcp://attacker:514"}}}
                ),
            ),
            (
                "disabled-healthcheck",
                lambda document: document["services"]["flowise"].update({"healthcheck": {"disable": True}}),
            ),
            (
                "removed-resource-limits",
                lambda document: document["services"]["flowise"].update({"deploy": {}}),
            ),
        ):
            mutated_candidate = copy.deepcopy(candidate)
            mutated_rollback = copy.deepcopy(rollback)
            mutate(mutated_candidate)
            mutate(mutated_rollback)
            matched_unsafe_compose_variants.append((label, mutated_candidate, mutated_rollback))
        for label, mutated_candidate, mutated_rollback in matched_unsafe_compose_variants:
            with self.subTest(layer="compose-matched", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE.validate_compose(
                    mutated_candidate,
                    mutated_rollback,
                    CANDIDATE_TAG,
                    ROLLBACK_TAG,
                    b"k" * 32,
                )

        expected_environment = RELEASE.service_environment(candidate)
        runtime = hardened_documents()
        expected_runtime = RELEASE.container_snapshot(runtime)[RELEASE.FLOWISE_CONTAINER]["runtime"]
        RELEASE.validate_runtime(
            runtime,
            image_tag=CANDIDATE_TAG,
            image_digest=CANDIDATE_DIGEST,
            expected_config_hash="4" * 64,
            expected_environment=expected_environment,
            require_candidate_hardening=True,
            expected_compose=candidate,
            expected_runtime=expected_runtime,
        )
        runtime_variants = {
            "no-new-privileges-false": ("SecurityOpt", ["no-new-privileges=false", f"seccomp={RELEASE.LIVE_SECCOMP}"]),
            "arbitrary-seccomp": ("SecurityOpt", ["no-new-privileges", "seccomp=/tmp/unknown.json"]),
            "privileged": ("Privileged", True),
            "cap-add": ("CapAdd", ["NET_ADMIN"]),
            "host-pid": ("PidMode", "host"),
            "host-ipc": ("IpcMode", "host"),
            "host-network": ("NetworkMode", "host"),
            "host-userns": ("UsernsMode", "host"),
            "host-uts": ("UTSMode", "host"),
            "host-cgroupns": ("CgroupnsMode", "host"),
            "devices": ("Devices", [{"PathOnHost": "/dev/sda"}]),
            "wrong-port": ("PortBindings", {"3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3000"}]}),
            "wrong-caps": ("CapDrop", []),
            "remote-log-driver": ("LogConfig", {"Type": "syslog", "Config": {"syslog-address": "tcp://attacker:514"}}),
            "removed-memory-limit": ("Memory", 0),
            "removed-cpu-limit": ("NanoCpus", 0),
        }
        for label, (field, value) in runtime_variants.items():
            mutated = copy.deepcopy(runtime)
            mutated[RELEASE.FLOWISE_CONTAINER]["HostConfig"][field] = value
            with self.subTest(layer="runtime", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE.validate_runtime(
                    mutated,
                    image_tag=CANDIDATE_TAG,
                    image_digest=CANDIDATE_DIGEST,
                    expected_config_hash="4" * 64,
                    expected_environment=expected_environment,
                    require_candidate_hardening=True,
                    expected_compose=candidate,
                    expected_runtime=expected_runtime,
                )

        mount_source_drift = copy.deepcopy(runtime)
        mount_source_drift[RELEASE.FLOWISE_CONTAINER]["Mounts"][0]["Source"] = "/"
        with self.assertRaises(RELEASE.DeployError):
            RELEASE.validate_runtime(
                mount_source_drift,
                image_tag=CANDIDATE_TAG,
                image_digest=CANDIDATE_DIGEST,
                expected_config_hash="4" * 64,
                expected_environment=expected_environment,
                require_candidate_hardening=True,
                expected_compose=candidate,
                expected_runtime=expected_runtime,
            )

        network_identity_drift = copy.deepcopy(runtime)
        network_identity_drift[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"][
            "flowise_flowise_network"
        ]["NetworkID"] = "attacker-network-id"
        with self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_RUNTIME_BASELINE_DRIFT"):
            RELEASE.validate_runtime(
                network_identity_drift,
                image_tag=CANDIDATE_TAG,
                image_digest=CANDIDATE_DIGEST,
                expected_config_hash="4" * 64,
                expected_environment=expected_environment,
                require_candidate_hardening=True,
                expected_compose=candidate,
                expected_runtime=expected_runtime,
            )

        RELEASE.validate_database_runtime_identity(candidate, runtime)
        image_baked_database_override = copy.deepcopy(runtime)
        image_baked_database_override[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].append(
            "DATABASE_SSL_KEY_BASE64=YXR0YWNrZXI="
        )
        with self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_RUNTIME_DATABASE_ENVIRONMENT_MISMATCH"):
            RELEASE.validate_runtime(
                image_baked_database_override,
                image_tag=CANDIDATE_TAG,
                image_digest=CANDIDATE_DIGEST,
                expected_config_hash="4" * 64,
                expected_environment=expected_environment,
                require_candidate_hardening=True,
                expected_compose=candidate,
                expected_runtime=expected_runtime,
            )
        with self.assertRaisesRegex(RELEASE.DeployError, "DATABASE_RUNTIME_FLOWISE_ENVIRONMENT_MISMATCH"):
            RELEASE.validate_database_runtime_identity(candidate, image_baked_database_override)
        duplicate_database_override = copy.deepcopy(runtime)
        duplicate_database_override[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].append("DATABASE_SSL=true")
        with self.assertRaisesRegex(RELEASE.DeployError, "CONTAINER_ENVIRONMENT_DUPLICATE_KEY"):
            RELEASE.validate_runtime(
                duplicate_database_override,
                image_tag=CANDIDATE_TAG,
                image_digest=CANDIDATE_DIGEST,
                expected_config_hash="4" * 64,
                expected_environment=expected_environment,
                require_candidate_hardening=True,
                expected_compose=candidate,
                expected_runtime=expected_runtime,
            )
        for label, mutate in (
            (
                "runtime-password",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["Config"].update(
                    {
                        "Env": [
                            "PGDATA=/var/lib/postgresql/data/pgdata",
                            "POSTGRES_DB=flowise",
                            "POSTGRES_USER=flowise",
                            "POSTGRES_PASSWORD=attacker",
                        ]
                    }
                ),
            ),
            (
                "runtime-network-id",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["NetworkSettings"]["Networks"][
                    "flowise_flowise_network"
                ].update({"NetworkID": "attacker-network-id"}),
            ),
            (
                "runtime-network-alias",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["NetworkSettings"]["Networks"][
                    "flowise_flowise_network"
                ].update({"Aliases": ["flowise-postgres"]}),
            ),
        ):
            mutated = copy.deepcopy(runtime)
            mutate(mutated)
            with self.subTest(layer="database-runtime", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE.validate_database_runtime_identity(candidate, mutated)

    def test_bootstrap_preflight_allows_only_the_exact_permitted_hash_label_exception(self):
        live_env = f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode()
        live_compose = b"legacy-compose"
        bundle = types.SimpleNamespace(
            files={"production_compose": Path("/bundle/compose")},
            file_entries={"production_compose": {"bytes": len(live_compose), "digest": digest(live_compose)}},
        )
        permit_bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        permit_document = transition_permit_document(permit_bundle)
        permit_document["live"].update({"env_sha256": digest(live_env), "compose_sha256": digest(live_compose)})
        permit = RELEASE.TransitionPermit(Path("/permit"), permit_document, digest(b"permit"))
        snapshot = {
            RELEASE.FLOWISE_CONTAINER: {
                "id": FLOWISE_ID,
                "image_ref": LEGACY_TAG,
                "image_id": LEGACY_DIGEST,
                "compose_config_hash": "6" * 64,
            },
            RELEASE.POSTGRES_CONTAINER: {"id": POSTGRES_ID},
            RELEASE.NGINX_CONTAINER: {"id": NGINX_ID},
        }
        database = copy.deepcopy(receipt()["baseline"]["database"])
        database["migration_name_sha256"] = digest(b"names")
        inventory = permit_document["legacy_journal_inventory"]
        patches = (
            mock.patch.object(RELEASE, "inspect_containers", return_value={}),
            mock.patch.object(RELEASE, "validate_container_health"),
            mock.patch.object(RELEASE, "container_snapshot", return_value=snapshot),
            mock.patch.object(
                RELEASE,
                "inspect_image",
                return_value={
                    "image_tag": LEGACY_TAG,
                    "image_config_digest": LEGACY_DIGEST,
                    "revision": LEGACY_REVISION,
                    "release_id": f"git-{LEGACY_REVISION}",
                    "repository_url": LEGACY_SOURCE,
                    "created_at": LEGACY_CREATED_AT,
                    "image_environment": {},
                },
            ),
            mock.patch.object(
                RELEASE,
                "live_file",
                side_effect=[(live_env, (0, 0, 0o600)), (live_compose, (0, 0, 0o644))],
            ),
            mock.patch.object(
                RELEASE,
                "_live_hashes",
                return_value={
                    "env": digest(live_env),
                    "compose": digest(live_compose),
                    "seccomp": {"present": False, "digest": None},
                },
            ),
            mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
            mock.patch.object(
                RELEASE,
                "_resolved_live",
                return_value=({}, "7" * 64, {"FLOWISE_SECRETKEY_OVERWRITE": "k" * 32}),
            ),
            mock.patch.object(RELEASE, "validate_database_runtime_identity"),
            mock.patch.object(RELEASE, "validate_key_continuity"),
            mock.patch.object(RELEASE, "validate_legacy_runtime", return_value={}),
            mock.patch.object(RELEASE, "database_state", return_value=database),
            mock.patch.object(RELEASE, "legacy_journal_inventory", return_value=inventory),
            mock.patch.object(RELEASE, "current_journal_inventory", return_value={"present": False}),
            mock.patch.object(RELEASE, "validate_runtime_network_identity", return_value=network_identity()),
            mock.patch.object(RELEASE, "runtime_pings"),
        )
        with _MultiPatch(patches):
            baseline = RELEASE._bootstrap_preflight(bundle, permit, check_current_journals=True)
        self.assertEqual(baseline["legacy_runtime_label_hash"], "6" * 64)
        self.assertEqual(baseline["legacy_config_hash"], "7" * 64)

        mismatch_patches = list(patches)
        mismatch_patches[7] = mock.patch.object(
            RELEASE,
            "_resolved_live",
            return_value=({}, "8" * 64, {"FLOWISE_SECRETKEY_OVERWRITE": "k" * 32}),
        )
        with _MultiPatch(mismatch_patches), self.assertRaisesRegex(
            RELEASE.DeployError, "HASH_EXCEPTION_BINDING_MISMATCH"
        ):
            RELEASE._bootstrap_preflight(bundle, permit, check_current_journals=True)

        image_drift_patches = list(patches)
        drifted_snapshot = copy.deepcopy(snapshot)
        drifted_snapshot[RELEASE.FLOWISE_CONTAINER]["image_id"] = CANDIDATE_DIGEST
        image_drift_patches[2] = mock.patch.object(RELEASE, "container_snapshot", return_value=drifted_snapshot)
        with _MultiPatch(image_drift_patches), self.assertRaisesRegex(
            RELEASE.DeployError, "ACTIVE_IMAGE_IDENTITY_MISMATCH"
        ):
            RELEASE._bootstrap_preflight(bundle, permit, check_current_journals=True)

        provenance_patches = list(patches)
        provenance_patches[3] = mock.patch.object(
            RELEASE,
            "inspect_image",
            return_value={
                "image_tag": LEGACY_TAG,
                "image_config_digest": LEGACY_DIGEST,
                "revision": LEGACY_REVISION,
                "release_id": f"git-{LEGACY_REVISION}",
                "repository_url": LEGACY_SOURCE,
                "created_at": None,
            },
        )
        with _MultiPatch(provenance_patches), self.assertRaisesRegex(
            RELEASE.DeployError, "ACTIVE_IMAGE_IDENTITY_MISMATCH"
        ):
            RELEASE._bootstrap_preflight(bundle, permit, check_current_journals=True)

        candidate, legacy = resolved_compose()
        legacy["services"]["flowise"]["environment"]["SHOW_COMMUNITY_NODES"] = "true"
        self.assertNotEqual(
            RELEASE._compose_without_flowise_image(candidate),
            RELEASE._compose_without_flowise_image(legacy),
        )

    def test_unbound_transition_observation_builds_a_consumer_compatible_permit(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        key = b"k" * 32
        live_env = f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode()
        live_compose = b"legacy-compose"
        live_hashes = {
            "env": digest(live_env),
            "compose": digest(live_compose),
            "seccomp": {"present": False, "digest": None},
        }
        snapshot = {
            RELEASE.FLOWISE_CONTAINER: {
                "id": FLOWISE_ID,
                "image_ref": LEGACY_TAG,
                "image_id": LEGACY_DIGEST,
                "compose_config_hash": "6" * 64,
            },
            RELEASE.POSTGRES_CONTAINER: {"id": POSTGRES_ID},
            RELEASE.NGINX_CONTAINER: {"id": NGINX_ID},
        }
        active_image = {
            "image_tag": LEGACY_TAG,
            "image_config_digest": LEGACY_DIGEST,
            "revision": LEGACY_REVISION,
            "release_id": f"git-{LEGACY_REVISION}",
            "repository_url": LEGACY_SOURCE,
            "created_at": LEGACY_CREATED_AT,
            "image_environment": {"IMAGE_ONLY": "not-persisted"},
        }
        compose_environment = {
            "FLOWISE_SECRETKEY_OVERWRITE": key.decode(),
            "COMPOSE_ONLY": "not-persisted",
        }
        runtime_projection = digest(b"legacy-runtime-projection")
        database = {
            "transaction_read_only": True,
            "migration_count": 59,
            "migration_sha256": digest(b"timestamp-and-name-inventory"),
            "migration_name_sha256": digest(b"name-inventory"),
        }
        legacy_inventory = transition_permit_document(bundle)["legacy_journal_inventory"]
        current_inventory = {
            "root": str(RELEASE.RUNS_DIR),
            "present": True,
            "control_json_count": 7,
            "control_json_sha256": digest(b"current-journal-inventory"),
            "unresolved_rollback_count": 0,
        }

        def observed_live_file(path, _mode):
            if path == RELEASE.LIVE_ENV:
                return live_env, (0, 0, 0o600)
            if path == RELEASE.LIVE_COMPOSE:
                return live_compose, (0, 0, 0o644)
            raise AssertionError(f"unexpected live path: {path.name}")

        patches = (
            mock.patch.object(RELEASE, "inspect_containers", return_value={}),
            mock.patch.object(RELEASE, "validate_container_health"),
            mock.patch.object(RELEASE, "container_snapshot", return_value=snapshot),
            mock.patch.object(RELEASE, "inspect_image", return_value=active_image),
            mock.patch.object(RELEASE, "live_file", side_effect=observed_live_file),
            mock.patch.object(RELEASE, "_live_hashes", return_value=live_hashes),
            mock.patch.object(RELEASE, "persistent_key", return_value=key),
            mock.patch.object(
                RELEASE,
                "_resolved_live",
                return_value=({}, "7" * 64, compose_environment),
            ),
            mock.patch.object(RELEASE, "runtime_projection_digest", return_value=runtime_projection),
            mock.patch.object(RELEASE, "validate_database_runtime_identity"),
            mock.patch.object(RELEASE, "validate_key_continuity"),
            mock.patch.object(
                RELEASE,
                "validate_legacy_runtime",
                return_value={
                    "runtime_projection_digest": runtime_projection,
                    "runtime_policy": "legacy_frozen_v1",
                },
            ),
            mock.patch.object(RELEASE, "database_state", return_value=database),
            mock.patch.object(RELEASE, "legacy_journal_inventory", return_value=legacy_inventory),
            mock.patch.object(RELEASE, "current_journal_inventory", return_value=current_inventory),
            mock.patch.object(RELEASE, "observe_runtime_network_identity", return_value=network_identity()),
            mock.patch.object(RELEASE, "validate_runtime_network_identity", return_value=network_identity()),
            mock.patch.object(RELEASE, "runtime_pings"),
        )
        with _MultiPatch(patches):
            initial = RELEASE._collect_transition_observation(bundle, check_current_journals=True)
            permit_document = RELEASE._build_transition_permit_document(bundle, RUN_ID, initial)
            current = RELEASE._collect_transition_observation(
                bundle,
                permit_document=permit_document,
                check_current_journals=True,
            )
        RELEASE._validate_transition_observation_cas(initial, current)
        permit_bytes = canonical(permit_document)
        self.assertNotIn(key.decode(), permit_bytes.decode())
        self.assertNotIn("not-persisted", permit_bytes.decode())
        with mock.patch.object(RELEASE, "read_regular", return_value=permit_bytes):
            verified = RELEASE.verify_transition_permit(
                Path("/permit.json"),
                digest(permit_bytes),
                bundle=bundle,
                run_id=RUN_ID,
            )
        self.assertEqual(verified.document, permit_document)
        self.assertEqual(verified.digest, digest(permit_bytes))

    def test_transition_permit_rejects_noncanonical_legacy_source_without_leaking_it(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        sentinel_source = "https://user:sentinel-secret@github.com/zjgulai/Flowise.git?token=sentinel-secret"
        observed = transition_observation(bundle)
        observed["active_image"]["repository_url"] = sentinel_source
        with self.assertRaisesRegex(
            RELEASE.DeployError,
            "TRANSITION_ACTIVE_IMAGE_SOURCE_MISMATCH",
        ) as builder_error:
            RELEASE._build_transition_permit_document(bundle, RUN_ID, observed)
        self.assertNotIn("sentinel-secret", str(builder_error.exception))

        document = transition_permit_document(bundle)
        document["active_legacy"]["repository_url"] = sentinel_source
        permit_bytes = canonical(document)
        with mock.patch.object(RELEASE, "read_regular", return_value=permit_bytes), self.assertRaisesRegex(
            RELEASE.DeployError,
            "TRANSITION_PERMIT_ACTIVE_LEGACY_INVALID",
        ) as consumer_error:
            RELEASE.verify_transition_permit(
                Path("/permit.json"),
                digest(permit_bytes),
                bundle=bundle,
                run_id=RUN_ID,
            )
        self.assertNotIn("sentinel-secret", str(consumer_error.exception))

    def test_control_and_oci_created_timestamp_contracts_are_distinct(self):
        for value in (
            "2026-07-28T11:26:44Z",
            "2026-07-28T19:26:44+08:00",
            "2026-07-23T01:39:35-04:30",
            "2026-07-28T19:26:44.123456789+08:00",
        ):
            with self.subTest(value=value):
                self.assertTrue(RELEASE._valid_oci_created_at(value))
        for value in (
            "2026-07-28 19:26:44+08:00",
            "2026-07-28T19:26:44",
            "2026-07-28T19:26:44+08:60",
            "2026-07-28T19:26:44+24:00",
            "2026-07-28T19:26:44-00:00",
            "2026-07-28T24:00:00Z",
            "2026-02-30T19:26:44Z",
            "2026-07-28T19:26:44z",
            "2026-07-28T19:26:44Z\n",
        ):
            with self.subTest(value=value):
                self.assertFalse(RELEASE._valid_oci_created_at(value))

        self.assertTrue(RELEASE._valid_timestamp("2026-07-28T11:26:44.123Z"))
        self.assertFalse(RELEASE._valid_timestamp("2026-07-28T19:26:44+08:00"))

    def test_release_manifest_control_created_at_rejects_numeric_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = BundleFixture(directory)
            manifest = json.loads((fixture.root / "release-manifest.json").read_text())
            manifest["created_at"] = "2026-07-28T19:26:44+08:00"
            with self.assertRaisesRegex(RELEASE.DeployError, "RELEASE_MANIFEST_HEADER_INVALID"):
                RELEASE.validate_release_manifest(manifest)

    def test_inspect_image_accepts_exact_oci_created_numeric_offset(self):
        source = "https://github.com/example/flowise"
        created_at = "2026-07-28T19:26:44+08:00"
        image_document = {
            "Id": CANDIDATE_DIGEST,
            "Os": "linux",
            "Architecture": "amd64",
            "Config": {
                "User": "node",
                "WorkingDir": "/usr/src/flowise",
                "Cmd": ["node", "packages/server/bin/run", "start"],
                "Env": [],
                "Labels": {
                    "org.opencontainers.image.created": created_at,
                    "org.opencontainers.image.revision": REVISION,
                    "org.opencontainers.image.source": source,
                    "org.opencontainers.image.version": f"git-{REVISION}",
                },
            },
        }
        with mock.patch.object(RELEASE, "run_command", return_value=json.dumps([image_document])):
            observed = RELEASE.inspect_image(
                CANDIDATE_TAG,
                CANDIDATE_DIGEST,
                REVISION,
                source,
            )
        self.assertEqual(observed["created_at"], created_at)

    def test_transition_permit_accepts_exact_oci_created_numeric_offset(self):
        bundle = types.SimpleNamespace(
            bundle_digest=digest(b"bundle"),
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
        )
        document = transition_permit_document(bundle)
        document["active_legacy"]["created_at"] = "2026-07-23T14:09:35+08:00"
        permit_bytes = canonical(document)
        with mock.patch.object(RELEASE, "read_regular", return_value=permit_bytes):
            verified = RELEASE.verify_transition_permit(
                Path("/permit.json"),
                digest(permit_bytes),
                bundle=bundle,
                run_id=RUN_ID,
            )
        self.assertEqual(verified.document["active_legacy"]["created_at"], "2026-07-23T14:09:35+08:00")

    def test_archive_config_digest_uses_exact_member_bytes_not_reserialized_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = "https://github.com/example/flowise"
            config = {
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "User": "node",
                    "WorkingDir": "/usr/src/flowise",
                    "Cmd": ["node", "packages/server/bin/run", "start"],
                    "Labels": {
                        "org.opencontainers.image.created": "2026-07-27T04:00:00.000Z",
                        "org.opencontainers.image.revision": REVISION,
                        "org.opencontainers.image.source": source,
                        "org.opencontainers.image.version": f"git-{REVISION}",
                    },
                },
            }
            canonical_config = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
            noncanonical_config = json.dumps(config, indent=2).encode()
            config_hex = hashlib.sha256(canonical_config).hexdigest()
            archive_path = root / "noncanonical.tar.gz"
            with tarfile.open(archive_path, "w:gz") as archive:
                manifest = json.dumps(
                    [{"Config": f"{config_hex}.json", "RepoTags": [CANDIDATE_TAG], "Layers": []}],
                    separators=(",", ":"),
                ).encode()
                for name, value in (("manifest.json", manifest), (f"{config_hex}.json", noncanonical_config)):
                    info = tarfile.TarInfo(name)
                    info.size = len(value)
                    archive.addfile(info, io.BytesIO(value))
            with self.assertRaisesRegex(RELEASE.DeployError, "IMAGE_ARCHIVE_CONFIG_DIGEST_MISMATCH"):
                RELEASE.verify_archive_contract(
                    archive_path,
                    image_tag=CANDIDATE_TAG,
                    image_config_digest=f"sha256:{config_hex}",
                    revision=REVISION,
                    release_id=f"git-{REVISION}",
                    repository_url=source,
                )

    def test_candidate_and_legacy_archive_contracts_accept_exact_config_name_styles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = (
                (
                    "candidate",
                    CANDIDATE_TAG,
                    REVISION,
                    f"git-{REVISION}",
                    "https://github.com/example/flowise",
                    "2026-07-28T11:26:44.000Z",
                    RELEASE.verify_archive_contract,
                ),
                (
                    "legacy",
                    LEGACY_TAG,
                    LEGACY_REVISION,
                    f"git-{LEGACY_REVISION}",
                    LEGACY_SOURCE,
                    LEGACY_CREATED_AT,
                    RELEASE.verify_legacy_archive_contract,
                ),
            )
            for contract, image_tag, revision, release_id, source, created_at, verifier in cases:
                config = {
                    "architecture": "amd64",
                    "os": "linux",
                    "config": {
                        "User": "node",
                        "WorkingDir": "/usr/src/flowise",
                        "Cmd": ["node", "packages/server/bin/run", "start"],
                        "Labels": {
                            "org.opencontainers.image.created": created_at,
                            "org.opencontainers.image.revision": revision,
                            "org.opencontainers.image.source": source,
                            "org.opencontainers.image.version": release_id,
                        },
                    },
                }
                for config_name_style in ("classic", "containerd"):
                    archive_path = root / f"{contract}-{config_name_style}.tar.gz"
                    config_digest = write_config_archive(
                        archive_path,
                        image_tag=image_tag,
                        config=config,
                        config_name_style=config_name_style,
                    )
                    arguments = {
                        "image_tag": image_tag,
                        "image_config_digest": config_digest,
                        "revision": revision,
                        "release_id": release_id,
                        "repository_url": source,
                    }
                    if contract == "legacy":
                        arguments["created_at"] = created_at
                    with self.subTest(contract=contract, config_name_style=config_name_style):
                        self.assertEqual(verifier(archive_path, **arguments)["platform"], "linux/amd64")

    def test_candidate_and_legacy_archive_contracts_accept_oci_created_numeric_offset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            created_at = "2026-07-28T19:26:44+08:00"
            cases = (
                (
                    "candidate",
                    CANDIDATE_TAG,
                    REVISION,
                    f"git-{REVISION}",
                    "https://github.com/example/flowise",
                    RELEASE.verify_archive_contract,
                ),
                (
                    "legacy",
                    LEGACY_TAG,
                    LEGACY_REVISION,
                    f"git-{LEGACY_REVISION}",
                    LEGACY_SOURCE,
                    RELEASE.verify_legacy_archive_contract,
                ),
            )
            for contract, image_tag, revision, release_id, source, verifier in cases:
                config = {
                    "architecture": "amd64",
                    "os": "linux",
                    "config": {
                        "User": "node",
                        "WorkingDir": "/usr/src/flowise",
                        "Cmd": ["node", "packages/server/bin/run", "start"],
                        "Labels": {
                            "org.opencontainers.image.created": created_at,
                            "org.opencontainers.image.revision": revision,
                            "org.opencontainers.image.source": source,
                            "org.opencontainers.image.version": release_id,
                        },
                    },
                }
                archive_path = root / f"offset-{contract}.tar.gz"
                config_digest = write_config_archive(
                    archive_path,
                    image_tag=image_tag,
                    config=config,
                    config_name_style="containerd",
                )
                arguments = {
                    "image_tag": image_tag,
                    "image_config_digest": config_digest,
                    "revision": revision,
                    "release_id": release_id,
                    "repository_url": source,
                }
                if contract == "legacy":
                    arguments["created_at"] = created_at
                with self.subTest(contract=contract):
                    self.assertEqual(verifier(archive_path, **arguments)["platform"], "linux/amd64")

    def test_candidate_and_legacy_archive_contracts_reject_config_path_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = (
                (
                    "candidate",
                    CANDIDATE_TAG,
                    REVISION,
                    f"git-{REVISION}",
                    "https://github.com/example/flowise",
                    "2026-07-28T19:26:44+08:00",
                    RELEASE.verify_archive_contract,
                    "IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH",
                ),
                (
                    "legacy",
                    LEGACY_TAG,
                    LEGACY_REVISION,
                    f"git-{LEGACY_REVISION}",
                    LEGACY_SOURCE,
                    LEGACY_CREATED_AT,
                    RELEASE.verify_legacy_archive_contract,
                    "LEGACY_IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH",
                ),
            )
            for contract, image_tag, revision, release_id, source, created_at, verifier, error in cases:
                config = {
                    "architecture": "amd64",
                    "os": "linux",
                    "config": {
                        "User": "node",
                        "WorkingDir": "/usr/src/flowise",
                        "Cmd": ["node", "packages/server/bin/run", "start"],
                        "Labels": {
                            "org.opencontainers.image.created": created_at,
                            "org.opencontainers.image.revision": revision,
                            "org.opencontainers.image.source": source,
                            "org.opencontainers.image.version": release_id,
                        },
                    },
                }
                for config_name_style in ("classic", "containerd"):
                    wrong_hex = "0" * 64
                    wrong_name = (
                        f"blobs/sha256/{wrong_hex}"
                        if config_name_style == "containerd"
                        else f"{wrong_hex}.json"
                    )
                    archive_path = root / f"wrong-path-digest-{contract}-{config_name_style}.tar.gz"
                    config_digest = write_config_archive(
                        archive_path,
                        image_tag=image_tag,
                        config=config,
                        config_name=wrong_name,
                    )
                    arguments = {
                        "image_tag": image_tag,
                        "image_config_digest": config_digest,
                        "revision": revision,
                        "release_id": release_id,
                        "repository_url": source,
                    }
                    if contract == "legacy":
                        arguments["created_at"] = created_at
                    with self.subTest(contract=contract, config_name_style=config_name_style):
                        with self.assertRaisesRegex(RELEASE.DeployError, error):
                            verifier(archive_path, **arguments)

    def test_containerd_config_path_remains_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = "https://github.com/example/flowise"
            created_at = "2026-07-27T04:00:00.000Z"
            config = {
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "User": "node",
                    "WorkingDir": "/usr/src/flowise",
                    "Cmd": ["node", "packages/server/bin/run", "start"],
                    "Labels": {
                        "org.opencontainers.image.created": created_at,
                        "org.opencontainers.image.revision": REVISION,
                        "org.opencontainers.image.source": source,
                        "org.opencontainers.image.version": f"git-{REVISION}",
                    },
                },
            }
            arguments = {
                "image_tag": CANDIDATE_TAG,
                "revision": REVISION,
                "release_id": f"git-{REVISION}",
                "repository_url": source,
            }

            unsafe_path = "blobs/sha256/../" + "0" * 64
            unsafe_archive = root / "unsafe-config-path.tar.gz"
            arguments["image_config_digest"] = write_config_archive(
                unsafe_archive,
                image_tag=CANDIDATE_TAG,
                config=config,
                config_name=unsafe_path,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH"):
                RELEASE.verify_archive_contract(unsafe_archive, **arguments)

            duplicate_archive = root / "duplicate-config-member.tar.gz"
            arguments["image_config_digest"] = write_config_archive(
                duplicate_archive,
                image_tag=CANDIDATE_TAG,
                config=config,
                config_name_style="containerd",
                config_copies=2,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "IMAGE_ARCHIVE_MEMBER_INVALID"):
                RELEASE.verify_archive_contract(duplicate_archive, **arguments)

            alias_archive = root / "ambiguous-config-alias.tar.gz"
            arguments["image_config_digest"] = write_config_archive(
                alias_archive,
                image_tag=CANDIDATE_TAG,
                config=config,
                config_name_style="containerd",
                include_alternate_alias=True,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "IMAGE_ARCHIVE_MEMBER_INVALID"):
                RELEASE.verify_archive_contract(alias_archive, **arguments)

            symlink_archive = root / "symlink-config-member.tar.gz"
            arguments["image_config_digest"] = write_config_archive(
                symlink_archive,
                image_tag=CANDIDATE_TAG,
                config=config,
                config_name_style="containerd",
                config_is_file=False,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "IMAGE_ARCHIVE_MEMBER_INVALID"):
                RELEASE.verify_archive_contract(symlink_archive, **arguments)

    def test_archive_config_member_rejects_contiguous_gnu_and_pax_sparse_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = "https://github.com/example/flowise"
            config = {
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "User": "node",
                    "WorkingDir": "/usr/src/flowise",
                    "Cmd": ["node", "packages/server/bin/run", "start"],
                    "Labels": {
                        "org.opencontainers.image.created": "2026-07-28T19:26:44+08:00",
                        "org.opencontainers.image.revision": REVISION,
                        "org.opencontainers.image.source": source,
                        "org.opencontainers.image.version": f"git-{REVISION}",
                    },
                },
            }
            config_bytes_length = len(json.dumps(config, sort_keys=True, separators=(",", ":")).encode())
            cases = (
                ("contiguous", tarfile.CONTTYPE, None),
                ("gnu-sparse", tarfile.GNUTYPE_SPARSE, None),
                (
                    "pax-sparse",
                    tarfile.REGTYPE,
                    {
                        "GNU.sparse.map": f"0,{config_bytes_length}",
                        "GNU.sparse.realsize": str(config_bytes_length),
                    },
                ),
            )
            for label, member_type, pax_headers in cases:
                archive_path = root / f"{label}.tar.gz"
                config_digest = write_config_archive(
                    archive_path,
                    image_tag=CANDIDATE_TAG,
                    config=config,
                    config_name_style="containerd",
                    config_member_type=member_type,
                    config_pax_headers=pax_headers,
                )
                with self.subTest(label=label), self.assertRaisesRegex(
                    RELEASE.DeployError,
                    "IMAGE_ARCHIVE_MEMBER_INVALID",
                ):
                    RELEASE.verify_archive_contract(
                        archive_path,
                        image_tag=CANDIDATE_TAG,
                        image_config_digest=config_digest,
                        revision=REVISION,
                        release_id=f"git-{REVISION}",
                        repository_url=source,
                    )

    def test_archive_manifest_member_rejects_contiguous_gnu_and_pax_sparse_types(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = "https://github.com/example/flowise"
            config = {
                "architecture": "amd64",
                "os": "linux",
                "config": {
                    "User": "node",
                    "WorkingDir": "/usr/src/flowise",
                    "Cmd": ["node", "packages/server/bin/run", "start"],
                    "Labels": {
                        "org.opencontainers.image.created": "2026-07-28T19:26:44+08:00",
                        "org.opencontainers.image.revision": REVISION,
                        "org.opencontainers.image.source": source,
                        "org.opencontainers.image.version": f"git-{REVISION}",
                    },
                },
            }
            cases = (
                ("contiguous", tarfile.CONTTYPE, False),
                ("gnu-sparse", tarfile.GNUTYPE_SPARSE, False),
                ("pax-sparse", tarfile.REGTYPE, True),
            )
            for label, member_type, pax_sparse in cases:
                archive_path = root / f"manifest-{label}.tar.gz"
                config_digest = write_config_archive(
                    archive_path,
                    image_tag=CANDIDATE_TAG,
                    config=config,
                    config_name_style="containerd",
                    manifest_member_type=member_type,
                    manifest_is_pax_sparse=pax_sparse,
                )
                with self.subTest(label=label), self.assertRaisesRegex(
                    RELEASE.DeployError,
                    "IMAGE_ARCHIVE_MEMBER_INVALID",
                ):
                    RELEASE.verify_archive_contract(
                        archive_path,
                        image_tag=CANDIDATE_TAG,
                        image_config_digest=config_digest,
                        revision=REVISION,
                        release_id=f"git-{REVISION}",
                        repository_url=source,
                    )

    def test_legacy_archive_requires_exact_oci_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for label, labels in (
                ("missing", {}),
                (
                    "mismatch",
                    {
                        "org.opencontainers.image.created": "2026-07-23T14:09:35+08:00",
                        "org.opencontainers.image.revision": LEGACY_REVISION,
                        "org.opencontainers.image.source": LEGACY_SOURCE,
                        "org.opencontainers.image.version": f"git-{LEGACY_REVISION}",
                    },
                ),
            ):
                config = {
                    "architecture": "amd64",
                    "os": "linux",
                    "config": {
                        "User": "node",
                        "WorkingDir": "/usr/src/flowise",
                        "Cmd": ["node", "packages/server/bin/run", "start"],
                        "Labels": labels,
                    },
                }
                config_bytes = json.dumps(config, sort_keys=True, separators=(",", ":")).encode()
                config_hex = hashlib.sha256(config_bytes).hexdigest()
                archive_path = root / f"legacy-{label}.tar.gz"
                with tarfile.open(archive_path, "w:gz") as archive:
                    manifest = json.dumps(
                        [{"Config": f"{config_hex}.json", "RepoTags": [LEGACY_TAG], "Layers": []}],
                        separators=(",", ":"),
                    ).encode()
                    for name, value in (("manifest.json", manifest), (f"{config_hex}.json", config_bytes)):
                        info = tarfile.TarInfo(name)
                        info.size = len(value)
                        archive.addfile(info, io.BytesIO(value))
                with self.subTest(label=label), self.assertRaisesRegex(
                    RELEASE.DeployError, "LEGACY_IMAGE_ARCHIVE_RUNTIME_CONTRACT_MISMATCH"
                ):
                    RELEASE.verify_legacy_archive_contract(
                        archive_path,
                        image_tag=LEGACY_TAG,
                        image_config_digest=f"sha256:{config_hex}",
                        revision=LEGACY_REVISION,
                        release_id=f"git-{LEGACY_REVISION}",
                        repository_url=LEGACY_SOURCE,
                        created_at=LEGACY_CREATED_AT,
                    )

    def test_candidate_migration_inventory_is_networkless_readonly_and_has_no_database_environment(self):
        captured = []

        def run(args, **_kwargs):
            captured.append(args)
            return json.dumps([{"timestamp": 1693891895163, "name": "Init1693891895163"}]).encode()

        cleanup_results = [
            types.SimpleNamespace(returncode=1),
            types.SimpleNamespace(returncode=0, stdout=b""),
            types.SimpleNamespace(returncode=1),
            types.SimpleNamespace(returncode=0, stdout=b""),
        ]
        with mock.patch.object(RELEASE, "run_command", side_effect=run), mock.patch.object(
            RELEASE.subprocess, "run", side_effect=cleanup_results
        ):
            inventory = RELEASE.candidate_migration_inventory(CANDIDATE_TAG, Path("/safe/chromium.json"))
        args = captured[0]
        self.assertEqual(args[:2], ["docker", "run"])
        self.assertIn("--rm", args)
        self.assertEqual(args[args.index("--network") + 1], "none")
        self.assertIn("--read-only", args)
        self.assertEqual(args[args.index("--cap-drop") + 1], "ALL")
        self.assertEqual(args[args.index("--user") + 1], "1000:1000")
        self.assertEqual(args[args.index("--pids-limit") + 1], "512")
        self.assertIn("no-new-privileges:true", args)
        self.assertIn("seccomp=/safe/chromium.json", args)
        self.assertNotIn("--env", args)
        self.assertEqual(inventory["migration_count"], 1)
        self.assertNotIn("migration_name_sha256", inventory)

    def test_bootstrap_database_fingerprint_adds_ordered_name_digest_without_changing_default_shape(self):
        output = b"transaction_read_only\ton\nmigration\t1693891895163\tInit1693891895163\n"
        with mock.patch.object(RELEASE, "run_command", return_value=output):
            normal = RELEASE.database_state()
            bootstrap = RELEASE.database_state(include_name_digest=True)
        self.assertNotIn("migration_name_sha256", normal)
        self.assertEqual(bootstrap["migration_name_sha256"], digest(b"Init1693891895163\n"))

    def test_migration_gate_rejects_candidate_database_mismatch(self):
        database = {"transaction_read_only": True, "migration_count": 59, "migration_sha256": digest(b"production")}
        with mock.patch.object(
            RELEASE,
            "candidate_migration_inventory",
            return_value={"migration_count": 60, "migration_sha256": digest(b"candidate")},
        ), self.assertRaisesRegex(RELEASE.DeployError, "CANDIDATE_PRODUCTION_MIGRATION_MISMATCH"):
            RELEASE.migration_gate(CANDIDATE_TAG, Path("/safe/chromium.json"), database)

    def test_cutover_preflight_rechecks_migration_gate_and_fails_closed(self):
        prepared = receipt()
        changed_gate = dict(prepared["migration_gate"], pending_migrations=1)
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            with _MultiPatch(
                (
                    mock.patch.object(RELEASE, "_read_receipt", return_value=(run_dir, prepared)),
                    mock.patch.object(
                        RELEASE,
                        "_load_staged",
                        side_effect=lambda _receipt, role, _run_dir: (run_dir / role, b"env", b"compose", b"seccomp"),
                    ),
                    mock.patch.object(RELEASE, "verify_regular_identity"),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=documents(ROLLBACK_TAG, ROLLBACK_DIGEST, "old")),
                    mock.patch.object(RELEASE, "container_snapshot", return_value=prepared["baseline"]["containers"]),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["rollback"]["files"]),
                    mock.patch.object(RELEASE, "inspect_image"),
                    mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                    mock.patch.object(RELEASE, "compose_config", side_effect=[{}, {}]),
                    mock.patch.object(RELEASE, "validate_compose"),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                    mock.patch.object(RELEASE, "migration_gate", return_value=changed_gate),
                    mock.patch.object(RELEASE, "validate_key_continuity"),
                    mock.patch.object(RELEASE, "service_environment", return_value={}),
                    mock.patch.object(RELEASE, "runtime_pings"),
                )
            ), self.assertRaisesRegex(RELEASE.DeployError, "CUTOVER_MIGRATION_GATE_RECEIPT_MISMATCH"):
                RELEASE._cutover_preflight(RUN_ID, digest(b"prepare"))

    def test_freeze_verified_file_rehashes_source_and_rejects_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.tar.gz"
            source.write_bytes(b"immutable candidate bytes")
            source.chmod(0o600)
            real_fstat = os.fstat

            def root_fstat(descriptor):
                value = real_fstat(descriptor)
                return types.SimpleNamespace(
                    st_mode=(value.st_mode & 0o170000) | 0o600,
                    st_nlink=value.st_nlink,
                    st_uid=0,
                    st_gid=0,
                    st_size=value.st_size,
                    st_dev=value.st_dev,
                    st_ino=value.st_ino,
                    st_mtime_ns=value.st_mtime_ns,
                )

            def verify_destination(path, *, expected_bytes, expected_digest, **_kwargs):
                value = Path(path).read_bytes()
                self.assertEqual((len(value), digest(value)), (expected_bytes, expected_digest))

            destination = root / "frozen.tar.gz"
            with mock.patch.object(RELEASE.os, "fstat", side_effect=root_fstat), mock.patch.object(
                RELEASE.os, "fchown"
            ), mock.patch.object(RELEASE, "verify_regular_identity", side_effect=verify_destination):
                RELEASE.freeze_verified_file(
                    source,
                    destination,
                    expected_bytes=source.stat().st_size,
                    expected_digest=digest(source.read_bytes()),
                )
            self.assertEqual(destination.read_bytes(), source.read_bytes())

            rejected = root / "rejected.tar.gz"
            with mock.patch.object(RELEASE.os, "fstat", side_effect=root_fstat), mock.patch.object(
                RELEASE.os, "fchown"
            ), self.assertRaisesRegex(RELEASE.DeployError, "FROZEN_SOURCE_IDENTITY_MISMATCH"):
                RELEASE.freeze_verified_file(
                    source,
                    rejected,
                    expected_bytes=source.stat().st_size,
                    expected_digest=digest(b"different"),
                )
            self.assertFalse(rejected.exists())

    def test_install_config_set_is_seccomp_then_compose_then_env(self):
        events = []

        def write(path, data, *_args):
            events.append((Path(path).name, data))

        def file_hash(path):
            values = {
                RELEASE.LIVE_SECCOMP: b"seccomp",
                RELEASE.LIVE_COMPOSE: b"compose",
                RELEASE.LIVE_ENV: b"env",
            }
            return digest(values[Path(path)])

        metadata = {"seccomp": [0, 0, 0o644], "compose": [0, 0, 0o644], "env": [0, 0, 0o600]}
        with mock.patch.object(RELEASE, "atomic_write", side_effect=write), mock.patch.object(
            RELEASE, "sha256_file", side_effect=file_hash
        ), mock.patch.object(RELEASE, "_ensure_live_seccomp_parent"):
            RELEASE.install_config_set(b"env", b"compose", b"seccomp", metadata)
        self.assertEqual(events, [("chromium.json", b"seccomp"), ("docker-compose.prod.yml", b"compose"), (".env.production", b"env")])

    def test_prepare_staging_records_absent_live_seccomp_without_inventing_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "rollback"

            def simple_write(path, data, *_args):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_bytes(data)

            with mock.patch.object(RELEASE, "_secure_directory", side_effect=lambda path: Path(path).mkdir(parents=True)), mock.patch.object(
                RELEASE, "atomic_write", side_effect=simple_write
            ):
                files = RELEASE._write_staged_tree(root, b"env", b"compose", None)
            self.assertEqual(files["seccomp"], {"present": False, "digest": None})
            self.assertFalse((root / "docker/seccomp/chromium.json").exists())

    def test_lock_identity_rejects_nonroot_hardlink_replacement_and_symlink(self):
        regular_mode = stat_mode = 0o100600
        safe = types.SimpleNamespace(
            st_mode=regular_mode,
            st_nlink=1,
            st_uid=0,
            st_gid=0,
            st_dev=11,
            st_ino=22,
        )
        unsafe_cases = {
            "nonroot": (types.SimpleNamespace(**{**safe.__dict__, "st_uid": 501}), safe),
            "hardlink": (types.SimpleNamespace(**{**safe.__dict__, "st_nlink": 2}), safe),
            "replacement": (safe, types.SimpleNamespace(**{**safe.__dict__, "st_ino": 23})),
            "symlink": (safe, types.SimpleNamespace(**{**safe.__dict__, "st_mode": 0o120777})),
        }
        for label, (descriptor_info, path_info) in unsafe_cases.items():
            with self.subTest(label=label), mock.patch.object(RELEASE.os, "fstat", return_value=descriptor_info), mock.patch.object(
                RELEASE, "LOCK_PATH", mock.Mock(lstat=mock.Mock(return_value=path_info))
            ), self.assertRaisesRegex(RELEASE.DeployError, "DEPLOY_LOCK_IDENTITY_UNSAFE"):
                RELEASE._validate_lock_identity(9)

    def test_acquire_lock_rejects_symlink_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_text("x")
            lock_path = root / "deploy.lock"
            lock_path.symlink_to(target)
            with mock.patch.object(RELEASE, "LOCK_DIR", root), mock.patch.object(RELEASE, "LOCK_PATH", lock_path), mock.patch.object(
                RELEASE, "_ensure_lock_directory"
            ), self.assertRaisesRegex(RELEASE.DeployError, "DEPLOY_LOCK_OPEN_FAILED"):
                RELEASE.acquire_lock()

    def test_prepare_loads_candidate_and_never_recreates_production(self):
        with tempfile.TemporaryDirectory() as directory, PatchedLock(self):
            root = Path(directory)
            for name, value in (("compose", b"candidate-compose"), ("seccomp", b"candidate-seccomp")):
                (root / name).write_bytes(value)
            fake_bundle = mock.Mock(
                release_id=f"git-{REVISION}",
                revision=REVISION,
                image_tag=CANDIDATE_TAG,
                image_config_digest=CANDIDATE_DIGEST,
                bundle_digest=digest(b"bundle"),
                files={"production_compose": root / "compose", "chromium_seccomp": root / "seccomp", "image_archive": root / "archive"},
                file_entries={
                    "production_compose": {"bytes": len(b"candidate-compose"), "digest": digest(b"candidate-compose")},
                    "chromium_seccomp": {"bytes": len(b"candidate-seccomp"), "digest": digest(b"candidate-seccomp")},
                    "image_archive": {"bytes": 1, "digest": digest(b"y")},
                },
                manifest={"source": {"repository_url": "https://github.com/example/flowise"}},
            )
            baseline = {
                "documents": {},
                "snapshot": {RELEASE.FLOWISE_CONTAINER: {"id": "old"}},
                "active_tag": ROLLBACK_TAG,
                "active_revision": ROLLBACK_REVISION,
                "active_image_digest": ROLLBACK_DIGEST,
                "active_repository_url": "https://github.com/example/flowise",
                "live_env": b"FLOWISE_IMAGE=" + ROLLBACK_TAG.encode() + b"\n",
                "live_compose": b"rollback-compose",
                "live_seccomp": b"rollback-seccomp",
                "live_metadata": {"env": [0, 0, 0o600], "compose": [0, 0, 0o644], "seccomp": [0, 0, 0o644]},
                "rollback_config_hash": "3" * 64,
                "key": b"k" * 32,
                "database": receipt()["baseline"]["database"],
            }
            events = []

            def simple_write(path, data, *_args):
                Path(path).parent.mkdir(parents=True, exist_ok=True)
                Path(path).write_bytes(data)

            run_dir = root / "run"
            patches = (
                mock.patch.object(RELEASE, "_recover_interrupted_runs"),
                mock.patch.object(RELEASE, "verify_bundle", return_value=fake_bundle),
                mock.patch.object(RELEASE, "_prepare_preflight", return_value=baseline),
                mock.patch.object(RELEASE, "_create_run_dir", return_value=run_dir),
                mock.patch.object(RELEASE, "_secure_directory", side_effect=lambda path: Path(path).mkdir(parents=True, exist_ok=True)),
                mock.patch.object(RELEASE, "atomic_write", side_effect=simple_write),
                mock.patch.object(RELEASE, "_journal"),
                mock.patch.object(RELEASE, "read_bundle_payload", side_effect=lambda path, *_args: Path(path).read_bytes()),
                mock.patch.object(RELEASE, "compose_config", return_value={}),
                mock.patch.object(RELEASE, "validate_compose"),
                mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                mock.patch.object(RELEASE, "freeze_verified_file", return_value=(1, digest(b"y"))),
                mock.patch.object(RELEASE, "save_rollback_archive", side_effect=lambda *_args: (1, digest(b"x"))),
                mock.patch.object(RELEASE, "verify_archive_contract"),
                mock.patch.object(
                    RELEASE,
                    "load_candidate",
                    side_effect=lambda path: events.append(f"candidate-loaded:{Path(path).relative_to(run_dir)}"),
                ),
                mock.patch.object(
                    RELEASE,
                    "inspect_image",
                    side_effect=lambda tag, *_args, **_kwargs: {
                        "image_config_digest": CANDIDATE_DIGEST if tag == CANDIDATE_TAG else ROLLBACK_DIGEST,
                        "revision": REVISION if tag == CANDIDATE_TAG else ROLLBACK_REVISION,
                        "repository_url": "https://github.com/example/flowise",
                    },
                ),
                mock.patch.object(RELEASE, "inspect_containers", return_value={}),
                mock.patch.object(RELEASE, "container_snapshot", return_value=baseline["snapshot"]),
                mock.patch.object(
                    RELEASE,
                    "_live_hashes",
                    return_value={
                        "env": digest(baseline["live_env"]),
                        "compose": digest(baseline["live_compose"]),
                        "seccomp": {"present": True, "digest": digest(baseline["live_seccomp"])},
                    },
                ),
                mock.patch.object(RELEASE, "database_state", return_value=baseline["database"]),
                mock.patch.object(RELEASE, "migration_gate", return_value=receipt()["migration_gate"]),
                mock.patch.object(RELEASE, "runtime_pings"),
                mock.patch.object(RELEASE, "_write_receipt", return_value=digest(b"receipt")),
                mock.patch.object(RELEASE, "compose_recreate", side_effect=AssertionError("prepare must not recreate")),
            )
            with _MultiPatch(patches):
                result = RELEASE.prepare(root, RUN_ID)
            self.assertEqual(events, ["candidate-loaded:candidate/image.tar.gz"])
            self.assertFalse(result["container_recreated"])

    def _cutover_patches(
        self,
        run_dir,
        prepared,
        events,
        *,
        candidate_recreate_error=None,
        runtime_error=None,
        rollback_remove_error=None,
    ):
        current_files = {}

        def write(path, data, *_args):
            current_files[Path(path)] = data
            events.append(f"write:{Path(path).name}:{data.decode()}")

        def file_hash(path):
            return digest(current_files[Path(path)])

        def live_hashes():
            seccomp_value = current_files.get(RELEASE.LIVE_SECCOMP)
            return {
                "env": digest(current_files.get(RELEASE.LIVE_ENV, b"rollback-env")),
                "compose": digest(current_files.get(RELEASE.LIVE_COMPOSE, b"rollback-compose")),
                "seccomp": {
                    "present": seccomp_value is not None,
                    "digest": digest(seccomp_value) if seccomp_value is not None else None,
                },
            }

        def staged(_receipt, role, _run_dir):
            seccomp = None if role == "rollback" and not _receipt["rollback"]["files"]["seccomp"]["present"] else f"{role}-seccomp".encode()
            return (
                run_dir / role,
                f"{role}-env".encode(),
                f"{role}-compose".encode(),
                seccomp,
            )

        def remove_seccomp():
            events.append("remove:chromium.json")
            if rollback_remove_error is not None:
                raise rollback_remove_error
            current_files.pop(RELEASE.LIVE_SECCOMP, None)

        recreate_calls = {"count": 0}

        def recreate(*_args):
            recreate_calls["count"] += 1
            events.append("recreate:candidate" if recreate_calls["count"] == 1 else "recreate:rollback")
            if recreate_calls["count"] == 1 and candidate_recreate_error is not None:
                raise candidate_recreate_error

        def validate_runtime(*_args, **kwargs):
            if kwargs["image_tag"] == CANDIDATE_TAG and runtime_error is not None:
                raise runtime_error
            return {"runtime_image_verified": True}

        return (
            mock.patch.object(RELEASE, "_recover_interrupted_runs"),
            mock.patch.object(RELEASE, "_cutover_preflight", return_value=(run_dir, prepared, documents(ROLLBACK_TAG, ROLLBACK_DIGEST, "old"), b"k" * 32)),
            mock.patch.object(RELEASE, "_receipt_path", side_effect=lambda root, name: Path(root) / f"{name}-receipt.json"),
            mock.patch.object(RELEASE, "_load_staged", side_effect=staged),
            mock.patch.object(
                RELEASE,
                "_ensure_rollback_image",
                return_value=runtime_image_authority(ROLLBACK_TAG, ROLLBACK_DIGEST),
            ),
            mock.patch.object(
                RELEASE,
                "inspect_image",
                side_effect=lambda tag, *_args, **_kwargs: runtime_image_authority(
                    tag,
                    CANDIDATE_DIGEST if tag == CANDIDATE_TAG else ROLLBACK_DIGEST,
                ),
            ),
            mock.patch.object(RELEASE, "atomic_write", side_effect=write),
            mock.patch.object(RELEASE, "sha256_file", side_effect=file_hash),
            mock.patch.object(RELEASE, "_ensure_live_seccomp_parent"),
            mock.patch.object(RELEASE, "_remove_live_seccomp", side_effect=remove_seccomp),
            mock.patch.object(RELEASE, "_live_hashes", side_effect=live_hashes),
            mock.patch.object(RELEASE, "_journal"),
            mock.patch.object(
                RELEASE,
                "_resolved_live",
                side_effect=lambda tag, _key: (
                    {},
                    ("3" if tag == ROLLBACK_TAG else "4") * 64,
                    {"FLOWISE_SECRETKEY_OVERWRITE": "k" * 32},
                ),
            ),
            mock.patch.object(RELEASE, "compose_recreate", side_effect=recreate),
            mock.patch.object(
                RELEASE,
                "inspect_containers",
                side_effect=lambda: documents(ROLLBACK_TAG if recreate_calls["count"] > 1 else CANDIDATE_TAG, ROLLBACK_DIGEST if recreate_calls["count"] > 1 else CANDIDATE_DIGEST),
            ),
            mock.patch.object(RELEASE, "validate_runtime", side_effect=validate_runtime),
            mock.patch.object(RELEASE, "validate_database_runtime_identity"),
            mock.patch.object(RELEASE, "container_snapshot", side_effect=lambda docs: {
                RELEASE.FLOWISE_CONTAINER: {"id": docs[RELEASE.FLOWISE_CONTAINER]["Id"]},
                RELEASE.POSTGRES_CONTAINER: {"id": "pg"},
                RELEASE.NGINX_CONTAINER: {"id": "nginx"},
            }),
            mock.patch.object(RELEASE, "_validate_sidecars"),
            mock.patch.object(RELEASE, "validate_key_continuity"),
            mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
            mock.patch.object(RELEASE, "runtime_pings"),
        )

    def _bootstrap_patches(self, root, events, *, runtime_error=None):
        legacy_compose_bytes = b"legacy-compose"
        hardened_compose_bytes = b"hardened-compose"
        seccomp_bytes = b"candidate-seccomp"
        live_env = f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode()
        hardened_active_env = f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode()
        target_bundle_env = f"FLOWISE_IMAGE={CANDIDATE_TAG}\n".encode()
        fake_bundle = types.SimpleNamespace(
            release_id=f"git-{REVISION}",
            revision=REVISION,
            image_tag=CANDIDATE_TAG,
            image_config_digest=CANDIDATE_DIGEST,
            bundle_digest=digest(b"bundle"),
            files={
                "production_compose": root / "bundle-compose",
                "chromium_seccomp": root / "bundle-seccomp",
                "image_archive": root / "bundle-image",
            },
            file_entries={
                "production_compose": {
                    "bytes": len(hardened_compose_bytes),
                    "digest": digest(hardened_compose_bytes),
                },
                "chromium_seccomp": {"bytes": len(seccomp_bytes), "digest": digest(seccomp_bytes)},
                "image_archive": {"bytes": 1, "digest": digest(b"candidate-archive")},
            },
            manifest={"source": {"repository_url": "https://github.com/example/flowise"}},
        )
        permit_document = transition_permit_document(fake_bundle)
        permit = RELEASE.TransitionPermit(root / "permit", permit_document, digest(b"permit"))
        legacy_files = {
            "env": digest(live_env),
            "compose": digest(legacy_compose_bytes),
            "seccomp": {"present": False, "digest": None},
        }
        hardened_active_files = {
            "env": digest(hardened_active_env),
            "compose": digest(hardened_compose_bytes),
            "seccomp": {"present": True, "digest": digest(seccomp_bytes)},
        }
        target_bundle_files = {
            "env": digest(target_bundle_env),
            "compose": digest(hardened_compose_bytes),
            "seccomp": {"present": True, "digest": digest(seccomp_bytes)},
        }
        database = copy.deepcopy(receipt()["baseline"]["database"])
        database["migration_name_sha256"] = digest(b"names")
        baseline_documents = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        baseline_snapshot = {
            RELEASE.FLOWISE_CONTAINER: {"id": FLOWISE_ID, "runtime": {"legacy": True}},
            RELEASE.POSTGRES_CONTAINER: {"id": POSTGRES_ID},
            RELEASE.NGINX_CONTAINER: {"id": NGINX_ID},
        }
        baseline = {
            "documents": baseline_documents,
            "snapshot": baseline_snapshot,
            "active_tag": LEGACY_TAG,
            "active_revision": LEGACY_REVISION,
            "active_image_digest": LEGACY_DIGEST,
            "active_image": {
                "image_tag": LEGACY_TAG,
                "image_config_digest": LEGACY_DIGEST,
                "revision": LEGACY_REVISION,
                "release_id": f"git-{LEGACY_REVISION}",
                "repository_url": LEGACY_SOURCE,
                "created_at": LEGACY_CREATED_AT,
                "image_environment": {},
            },
            "live_env": live_env,
            "live_compose": legacy_compose_bytes,
            "live_seccomp": None,
            "live_hashes": legacy_files,
            "live_metadata": {"env": [0, 0, 0o600], "compose": [0, 0, 0o644], "seccomp": [0, 0, 0o644]},
            "legacy_config": {},
            "legacy_config_hash": "7" * 64,
            "legacy_runtime_label_hash": "6" * 64,
            "legacy_environment": {"FLOWISE_SECRETKEY_OVERWRITE": "k" * 32},
            "legacy_environment_binding": environment_binding(LEGACY_ENVIRONMENT),
            "legacy_runtime": {},
            "key": b"k" * 32,
            "database": database,
            "network_identity": network_identity(),
            "legacy_journal_inventory": permit_document["legacy_journal_inventory"],
            "current_journal_inventory": {"present": False},
        }
        target_bundle_config, _ = resolved_compose()
        hardened_active_config = copy.deepcopy(target_bundle_config)
        hardened_active_config["services"]["flowise"]["image"] = LEGACY_TAG
        after_documents = documents(LEGACY_TAG, LEGACY_DIGEST, "9" * 64)
        after_snapshot = {
            RELEASE.FLOWISE_CONTAINER: {"id": "9" * 64, "runtime": {"hardened": True}},
            RELEASE.POSTGRES_CONTAINER: {"id": POSTGRES_ID},
            RELEASE.NGINX_CONTAINER: {"id": NGINX_ID},
        }
        receipts = []

        def payload(path, *_args):
            return seccomp_bytes if Path(path).name == "bundle-seccomp" else hardened_compose_bytes

        def staged_tree(path, *_args):
            return {
                "legacy": legacy_files,
                "hardened_active": hardened_active_files,
                "target_bundle": target_bundle_files,
            }[Path(path).name]

        def write_receipt(path, document):
            receipts.append((Path(path).name, copy.deepcopy(document)))
            return digest(Path(path).name.encode())

        def hardened_runtime(*_args, **_kwargs):
            if runtime_error is not None:
                raise runtime_error
            return {"runtime_hardening_verified": True, "runtime_projection_digest": digest(b"hardened")}

        patches = (
            mock.patch.object(RELEASE, "_recover_interrupted_runs"),
            mock.patch.object(RELEASE, "verify_bundle", return_value=fake_bundle),
            mock.patch.object(RELEASE, "verify_transition_permit", return_value=permit),
            mock.patch.object(RELEASE, "_bootstrap_preflight", side_effect=[baseline, baseline]),
            mock.patch.object(RELEASE, "_create_run_dir", return_value=root),
            mock.patch.object(RELEASE, "_validate_secure_run_role", return_value=root / "legacy"),
            mock.patch.object(RELEASE, "_journal"),
            mock.patch.object(RELEASE, "read_bundle_payload", side_effect=payload),
            mock.patch.object(RELEASE, "_write_staged_tree", side_effect=staged_tree),
            mock.patch.object(RELEASE, "save_rollback_archive", return_value=(1, digest(b"legacy-archive"))),
            mock.patch.object(RELEASE, "verify_legacy_archive_contract"),
            mock.patch.object(RELEASE, "load_candidate", side_effect=lambda *_args: events.append("load-target-candidate")),
            mock.patch.object(
                RELEASE,
                "compose_config",
                side_effect=[hardened_active_config, target_bundle_config],
            ),
            mock.patch.object(RELEASE, "validate_hardened_compose"),
            mock.patch.object(RELEASE, "validate_database_runtime_identity"),
            mock.patch.object(RELEASE, "compose_service_hash", side_effect=["8" * 64, "9" * 64]),
            mock.patch.object(RELEASE, "_validate_bootstrap_cas"),
            mock.patch.object(RELEASE, "_write_receipt", side_effect=write_receipt),
            mock.patch.object(RELEASE, "install_config_set", side_effect=lambda *_args: events.append("install-hardened")),
            mock.patch.object(RELEASE, "_live_hashes", return_value=hardened_active_files),
            mock.patch.object(
                RELEASE,
                "_resolved_live",
                return_value=(hardened_active_config, "8" * 64, copy.deepcopy(HARDENED_ENVIRONMENT)),
            ),
            mock.patch.object(RELEASE, "compose_recreate", side_effect=lambda: events.append("recreate-hardened")),
            mock.patch.object(RELEASE, "inspect_containers", return_value=after_documents),
            mock.patch.object(RELEASE, "validate_bootstrap_hardened_runtime", side_effect=hardened_runtime),
            mock.patch.object(RELEASE, "container_snapshot", return_value=after_snapshot),
            mock.patch.object(RELEASE, "_validate_sidecars"),
            mock.patch.object(RELEASE, "validate_key_continuity"),
            mock.patch.object(RELEASE, "database_state", return_value=database),
            mock.patch.object(RELEASE, "runtime_pings"),
            mock.patch.object(
                RELEASE,
                "_execute_legacy_rollback_transaction",
                side_effect=lambda *_args, **_kwargs: events.append("restore-legacy") or {},
            ),
        )
        return fake_bundle, receipts, patches

    def test_bootstrap_success_writes_prepare_before_live_and_completes_hardened_baseline(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            events = []
            _bundle, receipts, patches = self._bootstrap_patches(run_dir, events)
            with PatchedLock(self), _MultiPatch(patches):
                result = RELEASE.bootstrap(Path("/bundle"), RUN_ID, Path("/permit"), digest(b"permit"))
            self.assertEqual(result["status"], "complete_hardened_baseline")
            self.assertEqual(events, ["install-hardened", "recreate-hardened"])
            self.assertEqual([name for name, _ in receipts], ["bootstrap-prepare-receipt.json", "bootstrap-complete-receipt.json"])
            self.assertEqual(receipts[0][1]["state"], "prepared_legacy_frozen")
            self.assertEqual(receipts[0][1]["policy"], RELEASE.LEGACY_BOOTSTRAP_POLICY)
            self.assertEqual(receipts[0][1]["hardened_active"]["image_tag"], LEGACY_TAG)
            self.assertEqual(receipts[0][1]["target_bundle"]["image_tag"], CANDIDATE_TAG)
            self.assertEqual(receipts[0][1]["baseline"]["network_identity"], network_identity())
            self.assertFalse(receipts[0][1]["candidate_archive_loaded"])
            self.assertEqual(receipts[1][1]["state"], "complete_hardened_baseline")
            self.assertEqual(result["active_image"], LEGACY_TAG)
            self.assertEqual(result["target_candidate_image"], CANDIDATE_TAG)

    def test_bootstrap_hardened_runtime_failure_automatically_restores_legacy_once(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            events = []
            _bundle, receipts, patches = self._bootstrap_patches(
                run_dir,
                events,
                runtime_error=RELEASE.DeployError("BOOTSTRAP_RUNTIME_FAILED"),
            )
            with PatchedLock(self), _MultiPatch(patches), self.assertRaisesRegex(
                RELEASE.DeployError, "BOOTSTRAP_RUNTIME_FAILED"
            ):
                RELEASE.bootstrap(Path("/bundle"), RUN_ID, Path("/permit"), digest(b"permit"))
            self.assertEqual(events, ["install-hardened", "recreate-hardened", "restore-legacy"])
            self.assertEqual(events.count("restore-legacy"), 1)
            self.assertEqual([name for name, _ in receipts], ["bootstrap-prepare-receipt.json"])

    def test_legacy_frozen_restore_preserves_seccomp_absence_and_uses_dedicated_runtime_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = bootstrap_prepare_receipt()
            before = documents(LEGACY_TAG, LEGACY_DIGEST, "9" * 64)
            after = documents(LEGACY_TAG, LEGACY_DIGEST, "a" * 64)
            before_snapshot = copy.deepcopy(prepared["baseline"]["containers"])
            before_snapshot[RELEASE.FLOWISE_CONTAINER] = {"id": "9" * 64}
            after_snapshot = copy.deepcopy(prepared["baseline"]["containers"])
            after_snapshot[RELEASE.FLOWISE_CONTAINER] = {"id": "a" * 64}
            events = []
            legacy_runtime = mock.Mock(return_value={"runtime_policy": "legacy_frozen_v1"})
            legacy_config = {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}}
            expected = {
                "legacy_env": b"legacy-env",
                "legacy_compose": b"legacy-compose",
                "legacy_config": legacy_config,
                "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
            }
            classification = {
                "file_state": "HHH",
                "runtime_profile": "hardened",
                "runtime_config_hash": "8" * 64,
                "snapshot": before_snapshot,
                "expected": expected,
            }

            def install(_run_dir, _receipt, observed, state, _journal):
                self.assertIs(observed, expected)
                self.assertEqual(state, "HHH")
                events.append("install-legacy-without-seccomp")

            with _MultiPatch(
                (
                    mock.patch.object(RELEASE, "container_snapshot", return_value=after_snapshot),
                    mock.patch.object(
                        RELEASE,
                        "_classify_legacy_rollback_live_state",
                        return_value=classification,
                    ),
                    mock.patch.object(RELEASE, "_ensure_legacy_image", side_effect=lambda *_args: events.append("legacy-image-ready")),
                    mock.patch.object(RELEASE, "_install_legacy_files_from_state", side_effect=install),
                    mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["legacy"]["files"]),
                    mock.patch.object(
                        RELEASE,
                        "_resolved_live",
                        return_value=(legacy_config, "7" * 64, copy.deepcopy(LEGACY_ENVIRONMENT)),
                    ),
                    mock.patch.object(RELEASE, "compose_recreate", side_effect=lambda: events.append("recreate-legacy")),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=after),
                    mock.patch.object(
                        RELEASE,
                        "validate_legacy_runtime",
                        side_effect=legacy_runtime,
                    ),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                    mock.patch.object(RELEASE, "_validate_sidecars"),
                    mock.patch.object(RELEASE, "validate_key_continuity"),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "runtime_pings"),
                )
            ):
                runtime = RELEASE._restore_legacy_frozen(run_dir, prepared, before, b"k" * 32)
            self.assertEqual(events, ["legacy-image-ready", "install-legacy-without-seccomp", "recreate-legacy"])
            self.assertEqual(runtime["runtime_policy"], "legacy_frozen_v1")
            self.assertEqual(legacy_runtime.call_args.kwargs["expected_runtime_projection_digest"], digest(b"legacy-runtime"))

    def test_bootstrap_interruption_before_write_never_restores_and_after_write_restores_once(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()

            def persist(root, value):
                (Path(root) / "journal.json").write_bytes(canonical(value))

            prewrite = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "in_progress",
                "phase": "legacy_and_hardening_configs_frozen",
                "run_id": RUN_ID,
                "permit_digest": digest(b"permit"),
                "target_bundle_digest": digest(b"bundle"),
                "live_write_started": False,
            }
            (run_dir / "journal.json").write_bytes(canonical(prewrite))
            restore = mock.Mock()
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_journal", side_effect=persist), mock.patch.object(
                RELEASE, "_restore_legacy_frozen", restore
            ), self.assertRaisesRegex(RELEASE.DeployError, "BEFORE_LIVE_WRITE"):
                RELEASE._recover_interrupted_runs()
            restore.assert_not_called()

            postwrite = {
                **prewrite,
                "phase": "hardened_config_installing",
                "live_write_started": True,
                "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
            }
            (run_dir / "journal.json").write_bytes(canonical(postwrite))
            restore = mock.Mock(return_value={})
            read_receipt = mock.Mock(return_value=(run_dir, bootstrap_prepare_receipt()))
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(
                RELEASE, "_read_receipt", side_effect=read_receipt
            ), mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32), mock.patch.object(
                RELEASE, "_execute_legacy_rollback_transaction", restore
            ), mock.patch.object(
                RELEASE, "_journal", side_effect=persist
            ), self.assertRaisesRegex(RELEASE.DeployError, "RECOVERED_RETRY_REQUIRED"):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)
            read_receipt.assert_called_once_with(RUN_ID, "bootstrap-prepare", digest(b"bootstrap-prepare"))
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_execute_legacy_rollback_transaction", restore):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)

    def test_interrupted_recovery_never_follows_run_directory_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runs_dir = root / "current-runs"
            legacy_run = root / "legacy-release-run"
            runs_dir.mkdir()
            legacy_run.mkdir()
            legacy_journal = legacy_run / "journal.json"
            legacy_journal.write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "operation": "bootstrap",
                        "state": "in_progress",
                        "run_id": RUN_ID,
                        "live_write_started": True,
                    }
                )
            )
            (runs_dir / RUN_ID).symlink_to(legacy_run, target_is_directory=True)
            before = legacy_journal.read_bytes()
            restore = mock.Mock()
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "_restore_legacy_frozen", restore
            ), self.assertRaisesRegex(RELEASE.DeployError, "RECOVERY_RUN_DIRECTORY_UNSAFE"):
                RELEASE._recover_interrupted_runs()
            restore.assert_not_called()
            self.assertEqual(legacy_journal.read_bytes(), before)

    def test_interrupted_recovery_rejects_unsafe_directory_metadata_before_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory) / "deployments"
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir(parents=True)
            (run_dir / "journal.json").write_bytes(canonical({"state": "in_progress"}))
            actual_validate = RELEASE._validate_inventory_directory

            for rejected, error_code in (
                (runs_dir, "RECOVERY_ROOT_DIRECTORY_UNSAFE"),
                (run_dir, "RECOVERY_RUN_DIRECTORY_UNSAFE"),
            ):
                marker = mock.Mock()
                restore = mock.Mock()
                read = mock.Mock()

                def validate(path, label, *, rejected_path=rejected):
                    mode = 0o040755 if Path(path) == rejected_path else 0o040700
                    synthetic = mock.Mock(
                        lstat=mock.Mock(
                            return_value=types.SimpleNamespace(st_mode=mode, st_uid=0, st_gid=0)
                        )
                    )
                    actual_validate(synthetic, label)

                with self.subTest(path=rejected), mock.patch.object(
                    RELEASE, "RUNS_DIR", runs_dir
                ), mock.patch.object(
                    RELEASE, "_validate_inventory_directory", side_effect=validate
                ), mock.patch.object(
                    RELEASE, "read_regular", side_effect=read
                ), mock.patch.object(
                    RELEASE, "_mark_rollback_attempt", marker
                ), mock.patch.object(
                    RELEASE, "_restore_legacy_frozen", restore
                ), self.assertRaisesRegex(RELEASE.DeployError, error_code):
                    RELEASE._recover_interrupted_runs()
                read.assert_not_called()
                marker.assert_not_called()
                restore.assert_not_called()

    def test_interrupted_bootstrap_recovery_rejects_cross_run_receipt_before_rollback_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory) / "deployments"
            run_dir = runs_dir / RUN_ID
            other_run_dir = runs_dir / "20260727T130000Z-feedface"
            run_dir.mkdir(parents=True)
            other_run_dir.mkdir()
            journal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "in_progress",
                "phase": "hardened_config_installing",
                "run_id": RUN_ID,
                "permit_digest": digest(b"permit"),
                "target_bundle_digest": digest(b"bundle"),
                "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                "live_write_started": True,
            }
            (run_dir / "journal.json").write_bytes(canonical(journal))
            mark = mock.Mock()
            restore = mock.Mock()
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(
                RELEASE, "_read_receipt", return_value=(other_run_dir, bootstrap_prepare_receipt())
            ), mock.patch.object(RELEASE, "_mark_rollback_attempt", mark), mock.patch.object(
                RELEASE, "_restore_legacy_frozen", restore
            ), self.assertRaisesRegex(RELEASE.DeployError, "PREPARE_RECEIPT_BINDING_INVALID"):
                RELEASE._recover_interrupted_runs()
            mark.assert_not_called()
            restore.assert_not_called()

            mismatched_journal = {**journal, "run_id": "20260727T130000Z-feedface"}
            (run_dir / "journal.json").write_bytes(canonical(mismatched_journal))
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_journal", mark), self.assertRaisesRegex(
                RELEASE.DeployError, "INTERRUPTED_RUN_ID_INVALID"
            ):
                RELEASE._recover_interrupted_runs()
            mark.assert_not_called()

    def test_explicit_bootstrap_rollback_binds_both_receipts_and_is_one_shot(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = bootstrap_prepare_receipt()
            prepare_digest = digest(b"bootstrap-prepare")
            complete_digest = digest(b"bootstrap-complete")
            before = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
            before_snapshot = {
                RELEASE.FLOWISE_CONTAINER: {"id": "9" * 64, "runtime": {"hardened": True}},
                RELEASE.POSTGRES_CONTAINER: {"id": "pg"},
                RELEASE.NGINX_CONTAINER: {"id": "nginx"},
            }
            complete = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "run_id": RUN_ID,
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle": prepared["target_bundle"],
                "hardened_active": prepared["hardened_active"],
                "runtime": {"containers": before_snapshot},
            }
            hardened_config, _ = resolved_compose()
            hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
            restore = mock.Mock(return_value={"runtime_policy": "legacy_frozen_v1"})
            completed_journal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "target_bundle_release_id": prepared["target_bundle"]["release_id"],
                "active_legacy_release_id": prepared["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "bootstrap_complete_receipt_sha256": complete_digest,
            }
            classification = {
                "file_state": "HHH",
                "runtime_profile": "hardened",
                "runtime_config_hash": prepared["hardened_active"]["compose_config_hash"],
                "snapshot": before_snapshot,
                "expected": {
                    "hardened_config": hardened_config,
                    "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
                },
            }

            def read_receipt(_run_id, name, _digest=None):
                if name == "bootstrap-prepare":
                    return run_dir, prepared
                if name == "bootstrap-complete":
                    return run_dir, complete
                return run_dir, json.loads((run_dir / "bootstrap-rollback-receipt.json").read_text())

            def write_receipt(path, document):
                Path(path).write_bytes(canonical(document))
                return digest(canonical(document))

            def patches():
                return (
                    mock.patch.object(RELEASE, "current_journal_inventory", return_value={"present": True}),
                    mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                    mock.patch.object(RELEASE, "_read_run_journal", return_value=copy.deepcopy(completed_journal)),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=before),
                    mock.patch.object(RELEASE, "validate_container_health"),
                    mock.patch.object(RELEASE, "_classify_legacy_rollback_live_state", return_value=classification),
                    mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                    mock.patch.object(RELEASE, "validate_bootstrap_hardened_runtime"),
                    mock.patch.object(RELEASE, "runtime_pings"),
                    mock.patch.object(RELEASE, "_journal"),
                    mock.patch.object(RELEASE, "_execute_legacy_rollback_transaction", restore),
                    mock.patch.object(RELEASE, "_write_receipt", side_effect=write_receipt),
                )

            with PatchedLock(self), _MultiPatch(patches()):
                result = RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
            self.assertEqual(result["status"], "manual_legacy_rollback_complete")
            self.assertEqual(restore.call_count, 1)
            self.assertTrue((run_dir / "bootstrap-rollback-receipt.json").exists())

            with PatchedLock(self), _MultiPatch(patches()), self.assertRaisesRegex(
                RELEASE.DeployError, "BOOTSTRAP_ROLLBACK_RECEIPT_ALREADY_EXISTS"
            ):
                RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
            self.assertEqual(restore.call_count, 1)

    def test_bootstrap_rollback_rejects_mismatched_receipt_pair_before_inventory_or_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = bootstrap_prepare_receipt()
            complete = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "run_id": RUN_ID,
                "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle": {**prepared["target_bundle"], "bundle_digest": digest(b"other-bundle")},
                "hardened_active": prepared["hardened_active"],
            }

            def read_receipt(_run_id, name, _digest):
                return run_dir, prepared if name == "bootstrap-prepare" else complete

            inventory = mock.Mock()
            recover = mock.Mock()
            restore = mock.Mock()
            with PatchedLock(self), mock.patch.object(
                RELEASE, "_read_receipt", side_effect=read_receipt
            ), mock.patch.object(RELEASE, "current_journal_inventory", inventory), mock.patch.object(
                RELEASE, "_recover_interrupted_runs", recover
            ), mock.patch.object(RELEASE, "_restore_legacy_frozen", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "BOOTSTRAP_RECEIPT_BINDING_MISMATCH"
            ):
                RELEASE.bootstrap_rollback(
                    RUN_ID,
                    digest(b"bootstrap-prepare"),
                    digest(b"bootstrap-complete"),
                )
            inventory.assert_not_called()
            recover.assert_not_called()
            restore.assert_not_called()

    def test_complete_hardened_bootstrap_baseline_satisfies_unchanged_strict_prepare_preflight(self):
        next_revision = "d" * 40
        next_bundle = types.SimpleNamespace(image_tag=f"flowise-chinese:git-{next_revision}")
        current_config, _ = resolved_compose()
        current_config["services"]["flowise"]["image"] = LEGACY_TAG
        current_documents = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        environment = RELEASE.service_environment(current_config)
        database = receipt()["baseline"]["database"]
        live_values = [
            (f"FLOWISE_IMAGE={LEGACY_TAG}\n".encode(), (0, 0, 0o600)),
            (b"compose", (0, 0, 0o644)),
            (b"seccomp", (0, 0, 0o644)),
        ]
        with _MultiPatch(
            (
                mock.patch.object(RELEASE, "inspect_containers", return_value=current_documents),
                mock.patch.object(
                    RELEASE,
                    "inspect_image",
                    return_value=runtime_image_authority(LEGACY_TAG, LEGACY_DIGEST),
                ),
                mock.patch.object(RELEASE, "live_file", side_effect=live_values),
                mock.patch.object(RELEASE, "_validate_live_seccomp_parents"),
                mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                mock.patch.object(
                    RELEASE,
                    "_resolved_live",
                    return_value=(current_config, "4" * 64, environment),
                ),
                mock.patch.object(RELEASE, "database_state", return_value=database),
                mock.patch.object(RELEASE, "runtime_pings"),
            )
        ):
            baseline = RELEASE._prepare_preflight(next_bundle)
        self.assertEqual(baseline["active_revision"], LEGACY_REVISION)
        self.assertEqual(baseline["active_image_digest"], LEGACY_DIGEST)

    def test_auto_rollback_restores_seccomp_compose_env_before_rollback_recreate(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            events = []
            patches = self._cutover_patches(
                run_dir, prepared, events, candidate_recreate_error=RELEASE.DeployError("CANDIDATE_RECREATE_FAILED")
            )
            with PatchedLock(self), _MultiPatch(patches), self.assertRaisesRegex(RELEASE.DeployError, "CANDIDATE_RECREATE_FAILED"):
                RELEASE.cutover(RUN_ID, digest(b"prepare"))
            self.assertEqual(
                events,
                [
                    "write:chromium.json:candidate-seccomp",
                    "write:docker-compose.prod.yml:candidate-compose",
                    "write:.env.production:candidate-env",
                    "recreate:candidate",
                    "write:chromium.json:rollback-seccomp",
                    "write:docker-compose.prod.yml:rollback-compose",
                    "write:.env.production:rollback-env",
                    "recreate:rollback",
                ],
            )
            self.assertFalse((run_dir / "cutover-receipt.json").exists())

    def test_missing_or_conflicting_rollback_tag_loads_frozen_archive_then_inspects_exact_identity(self):
        for label, first_error in (
            ("missing", RELEASE.DeployError("IMAGE_INSPECT_INVALID")),
            ("conflicting", RELEASE.DeployError("IMAGE_CONFIG_DIGEST_MISMATCH")),
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                run_dir = Path(directory)
                archive_path = run_dir / "rollback/image.tar.gz"
                archive_path.parent.mkdir()
                archive_path.write_bytes(b"x")
                prepared = receipt()
                events = []
                with mock.patch.object(
                    RELEASE,
                    "_validate_secure_run_role",
                    return_value=run_dir / "rollback",
                ), mock.patch.object(RELEASE, "verify_regular_identity"), mock.patch.object(
                    RELEASE, "verify_archive_contract"
                ), mock.patch.object(
                    RELEASE,
                    "inspect_image",
                    side_effect=[first_error, {"image_config_digest": ROLLBACK_DIGEST}],
                ) as inspect, mock.patch.object(
                    RELEASE, "load_candidate", side_effect=lambda path: events.append(("load", Path(path)))
                ):
                    RELEASE._ensure_rollback_image(run_dir, prepared)
                self.assertEqual(events, [("load", archive_path)])
                self.assertEqual(inspect.call_count, 2)

    def test_rollback_archive_is_restored_before_any_live_file_write(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            events = []
            rollback_docs = documents(ROLLBACK_TAG, ROLLBACK_DIGEST)
            with _MultiPatch(
                (
                    mock.patch.object(
                        RELEASE,
                        "_ensure_rollback_image",
                        side_effect=lambda *_args: events.append("archive-ready")
                        or runtime_image_authority(ROLLBACK_TAG, ROLLBACK_DIGEST),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_load_staged",
                        return_value=(run_dir / "rollback", b"rollback-env", b"rollback-compose", b"rollback-seccomp"),
                    ),
                    mock.patch.object(RELEASE, "install_config_set", side_effect=lambda *_args: events.append("live-write")),
                    mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["rollback"]["files"]),
                    mock.patch.object(
                        RELEASE,
                        "_resolved_live",
                        return_value=({}, prepared["rollback"]["compose_config_hash"], {"FLOWISE_SECRETKEY_OVERWRITE": "k" * 32}),
                    ),
                    mock.patch.object(RELEASE, "compose_recreate", side_effect=lambda *_args: events.append("recreate")),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=rollback_docs),
                    mock.patch.object(RELEASE, "validate_runtime", return_value={}),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                    mock.patch.object(RELEASE, "_validate_sidecars"),
                    mock.patch.object(RELEASE, "validate_key_continuity"),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "runtime_pings"),
                    mock.patch.object(
                        RELEASE,
                        "container_snapshot",
                        return_value={RELEASE.FLOWISE_CONTAINER: {"id": FLOWISE_ID}},
                    ),
                )
            ):
                RELEASE._restore_rollback(run_dir, prepared, rollback_docs, b"k" * 32)
            self.assertEqual(events, ["archive-ready", "live-write", "recreate"])

    def test_restore_rollback_rebinds_actual_postgres_environment_and_network(self):
        _, rollback_config = resolved_compose()
        for label, mutate in (
            (
                "password",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["Config"].update(
                    {
                        "Env": [
                            "PGDATA=/var/lib/postgresql/data/pgdata",
                            "POSTGRES_DB=flowise",
                            "POSTGRES_USER=flowise",
                            "POSTGRES_PASSWORD=attacker",
                        ]
                    }
                ),
            ),
            (
                "network-id",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["NetworkSettings"]["Networks"][
                    "flowise_flowise_network"
                ].update({"NetworkID": "attacker-network-id"}),
            ),
            (
                "network-alias",
                lambda documents_value: documents_value[RELEASE.POSTGRES_CONTAINER]["NetworkSettings"]["Networks"][
                    "flowise_flowise_network"
                ].update({"Aliases": ["flowise-postgres"]}),
            ),
        ):
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                run_dir = Path(directory)
                prepared = receipt()
                after = hardened_documents()
                mutate(after)
                sidecars = mock.Mock()
                with _MultiPatch(
                    (
                        mock.patch.object(
                            RELEASE,
                            "_ensure_rollback_image",
                            return_value=runtime_image_authority(ROLLBACK_TAG, ROLLBACK_DIGEST),
                        ),
                        mock.patch.object(
                            RELEASE,
                            "_load_staged",
                            return_value=(
                                run_dir / "rollback",
                                b"rollback-env",
                                b"rollback-compose",
                                b"rollback-seccomp",
                            ),
                        ),
                        mock.patch.object(RELEASE, "install_config_set"),
                        mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["rollback"]["files"]),
                        mock.patch.object(
                            RELEASE,
                            "_resolved_live",
                            return_value=(
                                rollback_config,
                                prepared["rollback"]["compose_config_hash"],
                                RELEASE.service_environment(rollback_config),
                            ),
                        ),
                        mock.patch.object(RELEASE, "compose_recreate"),
                        mock.patch.object(RELEASE, "inspect_containers", return_value=after),
                        mock.patch.object(RELEASE, "validate_runtime", return_value={}),
                        mock.patch.object(RELEASE, "_validate_sidecars", sidecars),
                        mock.patch.object(RELEASE, "database_state", side_effect=AssertionError("must fail before DB probe")),
                    )
                ), self.assertRaisesRegex(RELEASE.DeployError, "DATABASE_RUNTIME"):
                    RELEASE._restore_rollback(run_dir, prepared, after, b"k" * 32)
                sidecars.assert_called_once_with(after, after)

    def test_unrecoverable_rollback_image_fails_before_live_write(self):
        with tempfile.TemporaryDirectory() as directory:
            events = []
            with mock.patch.object(
                RELEASE, "_ensure_rollback_image", side_effect=RELEASE.DeployError("ROLLBACK_IMAGE_UNRECOVERABLE")
            ), mock.patch.object(RELEASE, "install_config_set", side_effect=lambda *_args: events.append("write")), self.assertRaisesRegex(
                RELEASE.DeployError, "ROLLBACK_IMAGE_UNRECOVERABLE"
            ):
                RELEASE._restore_rollback(Path(directory), receipt(), documents(), b"k" * 32)
            self.assertEqual(events, [])

    def test_cutover_runtime_mismatch_rolls_back_and_emits_no_success_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            events = []
            patches = self._cutover_patches(
                run_dir, prepared, events, runtime_error=RELEASE.DeployError("FLOWISE_RUNTIME_CONFIG_HASH_MISMATCH")
            )
            with PatchedLock(self), _MultiPatch(patches), self.assertRaisesRegex(
                RELEASE.DeployError, "FLOWISE_RUNTIME_CONFIG_HASH_MISMATCH"
            ):
                RELEASE.cutover(RUN_ID, digest(b"prepare"))
            self.assertEqual(events.count("recreate:candidate"), 1)
            self.assertEqual(events.count("recreate:rollback"), 1)
            self.assertFalse((run_dir / "cutover-receipt.json").exists())

    def test_absent_rollback_seccomp_is_removed_before_compose_env_and_recreate(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            prepared["rollback"]["files"]["seccomp"] = {"present": False, "digest": None}
            events = []
            patches = self._cutover_patches(
                run_dir, prepared, events, candidate_recreate_error=RELEASE.DeployError("CANDIDATE_RECREATE_FAILED")
            )
            with PatchedLock(self), _MultiPatch(patches), self.assertRaisesRegex(RELEASE.DeployError, "CANDIDATE_RECREATE_FAILED"):
                RELEASE.cutover(RUN_ID, digest(b"prepare"))
            self.assertEqual(
                events[-4:],
                [
                    "remove:chromium.json",
                    "write:docker-compose.prod.yml:rollback-compose",
                    "write:.env.production:rollback-env",
                    "recreate:rollback",
                ],
            )

    def test_absent_seccomp_delete_failure_prevents_rollback_recreate(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            prepared["rollback"]["files"]["seccomp"] = {"present": False, "digest": None}
            events = []
            patches = self._cutover_patches(
                run_dir,
                prepared,
                events,
                candidate_recreate_error=RELEASE.DeployError("CANDIDATE_RECREATE_FAILED"),
                rollback_remove_error=RELEASE.DeployError("LIVE_SECCOMP_DELETE_UNSAFE"),
            )
            with PatchedLock(self), _MultiPatch(patches), self.assertRaisesRegex(
                RELEASE.DeployError, "FORWARD_AND_ROLLBACK_FAILED"
            ):
                RELEASE.cutover(RUN_ID, digest(b"prepare"))
            self.assertEqual(events.count("recreate:candidate"), 1)
            self.assertNotIn("recreate:rollback", events)
            self.assertEqual(events[-1], "remove:chromium.json")

    def test_cutover_preflight_failure_has_no_live_writes_or_recreate(self):
        events = []
        with PatchedLock(self), mock.patch.object(RELEASE, "_recover_interrupted_runs"), mock.patch.object(
            RELEASE, "_cutover_preflight", side_effect=RELEASE.DeployError("PREFLIGHT_FAILED")
        ), mock.patch.object(RELEASE, "install_config_set", side_effect=lambda *_args: events.append("write")), mock.patch.object(
            RELEASE, "compose_recreate", side_effect=lambda *_args: events.append("recreate")
        ), self.assertRaisesRegex(RELEASE.DeployError, "PREFLIGHT_FAILED"):
            RELEASE.cutover(RUN_ID, digest(b"prepare"))
        self.assertEqual(events, [])

    def test_manual_rollback_delegates_to_ordered_restore_and_writes_receipt_last(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            events = []
            before = documents()

            def read_receipt(_run_id, name, _expected=None):
                return run_dir, prepared if name == "prepare" else {
                    "run_id": RUN_ID,
                    "state": "complete_candidate_active",
                }

            with PatchedLock(self), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "_recover_interrupted_runs"),
                    mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                    mock.patch.object(RELEASE, "_receipt_path", side_effect=lambda root, name: Path(root) / f"{name}-receipt.json"),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=before),
                    mock.patch.object(RELEASE, "validate_container_health"),
                    mock.patch.object(RELEASE, "container_snapshot", return_value={RELEASE.FLOWISE_CONTAINER: {"image_ref": CANDIDATE_TAG}}),
                    mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                    mock.patch.object(RELEASE, "_journal"),
                    mock.patch.object(RELEASE, "_restore_rollback", side_effect=lambda *_args: events.append("restore") or {}),
                    mock.patch.object(RELEASE, "_write_receipt", side_effect=lambda *_args: events.append("receipt") or digest(b"rollback")),
                )
            ):
                result = RELEASE.rollback(RUN_ID, digest(b"prepare"), digest(b"cutover"))
            self.assertEqual(events, ["restore", "receipt"])
            self.assertEqual(result["status"], "manual_rollback_complete")

    def test_manual_rollback_failure_persists_terminal_state_and_blocks_repeated_restore(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()
            prepared = receipt()
            before = documents()

            def read_receipt(_run_id, name, _expected=None):
                return run_dir, prepared if name == "prepare" else {
                    "run_id": RUN_ID,
                    "state": "complete_candidate_active",
                }

            def persist_journal(root, value):
                (Path(root) / "journal.json").write_bytes(canonical(value))

            restore = mock.Mock(side_effect=RELEASE.DeployError("ROLLBACK_RECREATE_FAILED"))
            with PatchedLock(self), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "_recover_interrupted_runs"),
                    mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                    mock.patch.object(RELEASE, "_receipt_path", side_effect=lambda root, name: Path(root) / f"{name}-receipt.json"),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=before),
                    mock.patch.object(RELEASE, "validate_container_health"),
                    mock.patch.object(RELEASE, "container_snapshot", return_value={RELEASE.FLOWISE_CONTAINER: {"image_ref": CANDIDATE_TAG}}),
                    mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                    mock.patch.object(RELEASE, "_journal", side_effect=persist_journal),
                    mock.patch.object(RELEASE, "_restore_rollback", restore),
                )
            ), self.assertRaisesRegex(RELEASE.DeployError, "ROLLBACK_RECREATE_FAILED"):
                RELEASE.rollback(RUN_ID, digest(b"prepare"), digest(b"cutover"))
            terminal = json.loads((run_dir / "journal.json").read_text())
            self.assertEqual(terminal["state"], "rollback_failed_manual_intervention_required")
            self.assertEqual(restore.call_count, 1)

            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_restore_rollback", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE"
            ):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)

    def test_lock_covers_candidate_config_install_and_recreate(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = receipt()
            events = []
            patches = list(self._cutover_patches(run_dir, prepared, events))
            patches.append(mock.patch.object(RELEASE, "_write_receipt", return_value=digest(b"cutover")))
            with PatchedLock(self, events), _MultiPatch(patches):
                RELEASE.cutover(RUN_ID, digest(b"prepare"))
            self.assertEqual(events[0], "lock-acquired")
            self.assertEqual(events[-1], "lock-released")
            candidate_write = events.index("write:chromium.json:candidate-seccomp")
            recreate = events.index("recreate:candidate")
            self.assertLess(candidate_write, recreate)
            self.assertLess(recreate, events.index("lock-released"))

    def test_recovery_only_converges_to_shared_rollback_path(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()
            (run_dir / "journal.json").write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "operation": "cutover",
                        "state": "in_progress",
                        "phase": "candidate_recreate_intent",
                        "run_id": RUN_ID,
                    }
                )
            )
            prepared = receipt()
            prepared["rollback"]["files"]["seccomp"] = {"present": False, "digest": None}
            events = []
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_read_receipt", return_value=(run_dir, prepared)), mock.patch.object(
                RELEASE, "inspect_containers", return_value=documents()
            ), mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32), mock.patch.object(
                RELEASE, "_restore_rollback", side_effect=lambda *_args: events.append("shared-rollback") or {}
            ), mock.patch.object(RELEASE, "_journal", side_effect=lambda *_args: events.append("recovery-journal")), self.assertRaisesRegex(
                RELEASE.DeployError, "INTERRUPTED_RUN_RECOVERED_RETRY_REQUIRED"
            ):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(events, ["recovery-journal", "shared-rollback", "recovery-journal"])

    def test_recovery_final_journal_failure_leaves_attempt_marker_and_never_restores_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()
            (run_dir / "journal.json").write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "operation": "cutover",
                        "state": "in_progress",
                        "phase": "candidate_recreate_intent",
                        "run_id": RUN_ID,
                    }
                )
            )
            restore = mock.Mock(return_value={"runtime_image_verified": True})
            journal_calls = 0

            def fail_second_journal(root, value):
                nonlocal journal_calls
                journal_calls += 1
                if journal_calls == 2:
                    raise OSError("simulated final journal fsync failure")
                (Path(root) / "journal.json").write_bytes(canonical(value))

            common = (
                mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                mock.patch.object(RELEASE, "_validate_inventory_directory"),
                mock.patch.object(RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()),
                mock.patch.object(RELEASE, "_read_receipt", return_value=(run_dir, receipt())),
                mock.patch.object(RELEASE, "inspect_containers", return_value=documents()),
                mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                mock.patch.object(RELEASE, "_restore_rollback", restore),
                mock.patch.object(RELEASE, "_journal", side_effect=fail_second_journal),
            )
            with _MultiPatch(common), self.assertRaisesRegex(OSError, "simulated final journal fsync failure"):
                RELEASE._recover_interrupted_runs()
            persisted = json.loads((run_dir / "journal.json").read_text())
            self.assertEqual(persisted["state"], RELEASE.ROLLBACK_ATTEMPTED_STATE)
            self.assertEqual(restore.call_count, 1)

            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_restore_rollback", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE"
            ):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)

    def test_interrupted_recovery_failure_persists_terminal_state_and_is_not_retried(self):
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RUN_ID
            run_dir.mkdir()
            (run_dir / "journal.json").write_bytes(
                canonical(
                    {
                        "schema_version": 1,
                        "operation": "cutover",
                        "state": "in_progress",
                        "phase": "candidate_recreate_intent",
                        "run_id": RUN_ID,
                    }
                )
            )
            restore = mock.Mock(side_effect=RELEASE.DeployError("RECOVERY_RESTORE_FAILED"))

            def persist_journal(root, value):
                (Path(root) / "journal.json").write_bytes(canonical(value))

            common = (
                mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                mock.patch.object(RELEASE, "_validate_inventory_directory"),
                mock.patch.object(RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()),
                mock.patch.object(RELEASE, "_read_receipt", return_value=(run_dir, receipt())),
                mock.patch.object(RELEASE, "inspect_containers", return_value=documents()),
                mock.patch.object(RELEASE, "persistent_key", return_value=b"k" * 32),
                mock.patch.object(RELEASE, "_restore_rollback", restore),
                mock.patch.object(RELEASE, "_journal", side_effect=persist_journal),
            )
            with _MultiPatch(common), self.assertRaisesRegex(
                RELEASE.DeployError, "INTERRUPTED_ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED"
            ):
                RELEASE._recover_interrupted_runs()
            terminal = json.loads((run_dir / "journal.json").read_text())
            self.assertEqual(terminal["state"], "rollback_failed_manual_intervention_required")
            self.assertEqual(restore.call_count, 1)

            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_restore_rollback", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE"
            ):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)

    def test_legacy_restore_precondition_allows_stopped_unhealthy_or_healthless_flowise(self):
        healthy = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        prepared = bootstrap_prepare_receipt()
        prepared["baseline"]["containers"] = RELEASE.container_snapshot(healthy)
        for label, state in (
            ("stopped", {"Status": "exited"}),
            ("unhealthy", {"Status": "running", "Health": {"Status": "unhealthy"}}),
            ("healthless", {"Status": "running"}),
        ):
            with self.subTest(label=label):
                observed = copy.deepcopy(healthy)
                observed[RELEASE.FLOWISE_CONTAINER]["State"] = state
                snapshot = RELEASE._validate_legacy_restore_sidecars(observed, prepared)
                self.assertEqual(snapshot[RELEASE.POSTGRES_CONTAINER], prepared["baseline"]["containers"][RELEASE.POSTGRES_CONTAINER])
                self.assertEqual(snapshot[RELEASE.NGINX_CONTAINER], prepared["baseline"]["containers"][RELEASE.NGINX_CONTAINER])

        for sidecar in (RELEASE.POSTGRES_CONTAINER, RELEASE.NGINX_CONTAINER):
            with self.subTest(sidecar=sidecar):
                observed = copy.deepcopy(healthy)
                observed[sidecar]["State"]["Health"]["Status"] = "unhealthy"
                with self.assertRaisesRegex(RELEASE.DeployError, "SIDECAR_NOT_HEALTHY"):
                    RELEASE._validate_legacy_restore_sidecars(observed, prepared)

    def test_recovery_inspector_proves_flowise_absent_without_relaxing_sidecars(self):
        source = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        sidecars = [source[RELEASE.POSTGRES_CONTAINER], source[RELEASE.NGINX_CONTAINER]]
        sidecars[0]["Name"] = "/" + RELEASE.POSTGRES_CONTAINER
        sidecars[1]["Name"] = "/" + RELEASE.NGINX_CONTAINER
        with mock.patch.object(
            RELEASE,
            "run_command",
            side_effect=[
                json.dumps(sidecars).encode(),
                RELEASE.DeployError("COMMAND_FAILED"),
                b"",
            ],
        ) as command:
            observed = RELEASE.inspect_legacy_recovery_containers()
        self.assertEqual(set(observed), {RELEASE.POSTGRES_CONTAINER, RELEASE.NGINX_CONTAINER})
        self.assertEqual(command.call_count, 3)

        with mock.patch.object(
            RELEASE,
            "run_command",
            side_effect=[
                json.dumps(sidecars).encode(),
                RELEASE.DeployError("COMMAND_FAILED"),
                (RELEASE.FLOWISE_CONTAINER + "\n").encode(),
            ],
        ), self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_INSPECT_FAILED"):
            RELEASE.inspect_legacy_recovery_containers()

    def test_controlled_missing_flowise_recovery_recreates_and_defers_flowise_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / RUN_ID
            prepared = bootstrap_prepare_receipt()
            healthy = documents(LEGACY_TAG, LEGACY_DIGEST, "a" * 64)
            prepared["baseline"]["containers"] = RELEASE.container_snapshot(healthy)
            missing = {
                RELEASE.POSTGRES_CONTAINER: healthy[RELEASE.POSTGRES_CONTAINER],
                RELEASE.NGINX_CONTAINER: healthy[RELEASE.NGINX_CONTAINER],
            }
            legacy_config = {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}}
            hardened_config, _ = resolved_compose()
            hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
            expected = {
                "legacy_env": b"legacy-env",
                "legacy_compose": b"legacy-compose",
                "legacy_config": legacy_config,
                "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
                "hardened_config": hardened_config,
                "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
            }
            file_state = list("HHH")

            def live_hashes():
                return {
                    name: prepared["legacy" if token == "L" else "hardened_active"]["files"][name]
                    for name, token in zip(("seccomp", "compose", "env"), file_state)
                }

            def install(*_args, **_kwargs):
                file_state[:] = list("LLL")
                events.append("install")

            events = []
            journals = []
            database_identity = mock.Mock()
            key_continuity = mock.Mock()
            journal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "in_progress",
                "phase": "hardened_recreate_intent",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                "live_write_started": True,
                "hardened_recreate_started": True,
            }
            with _MultiPatch(
                (
                    mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=missing),
                    mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "_live_hashes", side_effect=live_hashes),
                    mock.patch.object(RELEASE, "_journal", side_effect=lambda _root, value: journals.append(copy.deepcopy(value))),
                    mock.patch.object(RELEASE, "_ensure_legacy_image"),
                    mock.patch.object(RELEASE, "_install_legacy_files_from_state", side_effect=install),
                    mock.patch.object(
                        RELEASE,
                        "_resolved_live",
                        return_value=(legacy_config, prepared["legacy"]["live_computed_config_hash"], copy.deepcopy(LEGACY_ENVIRONMENT)),
                    ),
                    mock.patch.object(RELEASE, "compose_recreate", side_effect=lambda: events.append("recreate")),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=healthy),
                    mock.patch.object(
                        RELEASE,
                        "validate_legacy_runtime",
                        return_value={"runtime_policy": "legacy_frozen_v1"},
                    ),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity", database_identity),
                    mock.patch.object(RELEASE, "_validate_sidecars"),
                    mock.patch.object(RELEASE, "validate_key_continuity", key_continuity),
                    mock.patch.object(RELEASE, "runtime_pings"),
                )
            ):
                runtime = RELEASE._execute_legacy_rollback_transaction(
                    run_dir,
                    prepared,
                    journal,
                    TEST_KEY,
                    intent_phase="automatic_legacy_rollback_restoring",
                    failure_phase="automatic_legacy_rollback_failed",
                    failure_code="FAILED",
                )
            self.assertEqual(events, ["install", "recreate"])
            self.assertEqual(runtime["runtime_policy"], "legacy_frozen_v1")
            self.assertEqual(database_identity.call_count, 1)
            self.assertEqual(key_continuity.call_count, 1)
            self.assertTrue(
                any(
                    item.get("flowise_absent_recovery")
                    == {
                        "origin": "hardened_recreate_intent",
                        "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                        "pre_recreate_flowise_container_id": "absent",
                    }
                    for item in journals
                )
            )

    def test_stopped_or_unhealthy_flowise_still_enters_authorized_restore_transaction(self):
        prepared = bootstrap_prepare_receipt()
        baseline = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        baseline[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"]["com.docker.compose.config-hash"] = prepared[
            "hardened_active"
        ]["compose_config_hash"]
        prepared["baseline"]["containers"] = RELEASE.container_snapshot(baseline)
        hardened_config, _ = resolved_compose()
        hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
        expected = {
            "legacy_config": {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}},
            "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
            "hardened_config": hardened_config,
            "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
        }
        for label, flowise_state in (
            ("stopped", {"Status": "exited"}),
            ("unhealthy", {"Status": "running", "Health": {"Status": "unhealthy"}}),
        ):
            observed = copy.deepcopy(baseline)
            observed[RELEASE.FLOWISE_CONTAINER]["State"] = flowise_state
            restore = mock.Mock(return_value={})
            with self.subTest(label=label), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=observed),
                    mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
                    mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["hardened_active"]["files"]),
                    mock.patch.object(RELEASE, "_hardened_runtime_stable_projection", return_value={"stable": True}),
                    mock.patch.object(RELEASE, "_expected_hardened_runtime_stable_projection", return_value={"stable": True}),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                    mock.patch.object(RELEASE, "validate_key_continuity"),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "_journal"),
                    mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
                )
            ):
                RELEASE._execute_legacy_rollback_transaction(
                    Path("/run"),
                    prepared,
                    {"operation": "bootstrap", "state": "in_progress", "run_id": RUN_ID},
                    TEST_KEY,
                    intent_phase="intent",
                    failure_phase="failed",
                    failure_code="FAILED",
                )
            restore.assert_called_once()

    def test_missing_flowise_outside_exact_recreate_window_is_zero_write(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / RUN_ID
            prepared = bootstrap_prepare_receipt()
            healthy = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
            prepared["baseline"]["containers"] = RELEASE.container_snapshot(healthy)
            missing = {
                RELEASE.POSTGRES_CONTAINER: healthy[RELEASE.POSTGRES_CONTAINER],
                RELEASE.NGINX_CONTAINER: healthy[RELEASE.NGINX_CONTAINER],
            }
            marker = mock.Mock()
            staged_read = mock.Mock()
            restore = mock.Mock()
            journal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "in_progress",
                "phase": "hardened_config_installing",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                "live_write_started": True,
                "hardened_recreate_started": False,
            }
            with mock.patch.object(
                RELEASE, "inspect_legacy_recovery_containers", return_value=missing
            ), mock.patch.object(RELEASE, "_legacy_restore_expected_state", staged_read), mock.patch.object(
                RELEASE, "_journal", marker
            ), mock.patch.object(RELEASE, "_restore_legacy_frozen", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "FLOWISE_MISSING"
            ):
                RELEASE._execute_legacy_rollback_transaction(
                    run_dir,
                    prepared,
                    journal,
                    TEST_KEY,
                    intent_phase="intent",
                    failure_phase="failed",
                    failure_code="FAILED",
                )
            staged_read.assert_not_called()
            marker.assert_not_called()
            restore.assert_not_called()

    def test_hardened_runtime_independently_binds_network_ids_and_allows_only_dynamic_endpoint_fields(self):
        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        baseline = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        identity = network_identity()
        initial = RELEASE.validate_bootstrap_hardened_runtime(
            baseline,
            image_tag=LEGACY_TAG,
            image_digest=LEGACY_DIGEST,
            expected_config_hash="4" * 64,
            expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
            expected_compose=config,
            expected_network_identity=identity,
        )
        dynamic = copy.deepcopy(baseline)
        for index, endpoint in enumerate(
            dynamic[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"].values(),
            start=1,
        ):
            endpoint["IPAddress"] = f"10.0.0.{index + 20}"
            endpoint["MacAddress"] = f"02:42:ac:1c:00:{index:02x}"
        after_dynamic_change = RELEASE.validate_bootstrap_hardened_runtime(
            dynamic,
            image_tag=LEGACY_TAG,
            image_digest=LEGACY_DIGEST,
            expected_config_hash="4" * 64,
            expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
            expected_compose=config,
            expected_network_identity=identity,
        )
        self.assertEqual(initial["runtime_projection_digest"], after_dynamic_change["runtime_projection_digest"])

        for label, mutate in (
            (
                "flowise-internal-id",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"][
                    "flowise_flowise_network"
                ].update({"NetworkID": "8" * 64}),
            ),
            (
                "flowise-proxy-id",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"][
                    "lighthouse_ai_video_net"
                ].update({"NetworkID": "8" * 64}),
            ),
            (
                "nginx-proxy-id",
                lambda value: value[RELEASE.NGINX_CONTAINER]["NetworkSettings"]["Networks"][
                    "lighthouse_ai_video_net"
                ].update({"NetworkID": "8" * 64}),
            ),
            (
                "missing-attachment",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"].pop(
                    "lighthouse_ai_video_net"
                ),
            ),
            (
                "extra-attachment",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"].update(
                    {"attacker_network": {"NetworkID": "8" * 64}}
                ),
            ),
        ):
            drifted_identity = copy.deepcopy(baseline)
            mutate(drifted_identity)
            with self.subTest(label=label), self.assertRaisesRegex(
                RELEASE.DeployError,
                "(RUNTIME_NETWORK_(IDENTITY|ATTACHMENT_SET)|FLOWISE_RUNTIME_NETWORK_ALLOWLIST)_MISMATCH",
            ):
                RELEASE.validate_bootstrap_hardened_runtime(
                    drifted_identity,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash="4" * 64,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=identity,
                )

        drifted = copy.deepcopy(dynamic)
        drifted[RELEASE.FLOWISE_CONTAINER]["HostConfig"]["NetworkMode"] = "lighthouse_ai_video_net"
        with self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_RUNTIME_BASELINE_DRIFT"):
            RELEASE.validate_bootstrap_hardened_runtime(
                drifted,
                image_tag=LEGACY_TAG,
                image_digest=LEGACY_DIGEST,
                expected_config_hash="4" * 64,
                expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                expected_compose=config,
                expected_network_identity=identity,
            )

    def test_hardened_runtime_accepts_only_reviewed_named_volume_modes_and_exact_host_options(self):
        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        arguments = {
            "image_tag": LEGACY_TAG,
            "image_digest": LEGACY_DIGEST,
            "expected_config_hash": "4" * 64,
            "expected_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
            "expected_compose": config,
            "expected_network_identity": network_identity(),
        }

        for mode in ("rw", "z"):
            runtime = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
            runtime[RELEASE.FLOWISE_CONTAINER]["Mounts"][0]["Mode"] = mode
            with self.subTest(engine_named_volume_mode=mode):
                result = RELEASE.validate_bootstrap_hardened_runtime(runtime, **arguments)
            self.assertIs(result["runtime_hardening_verified"], True)

        for mode in (None, "", "ro", "Z", "rw,z", "z,ro", "shared", ["z"]):
            runtime = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
            runtime[RELEASE.FLOWISE_CONTAINER]["Mounts"][0]["Mode"] = mode
            with self.subTest(rejected_engine_named_volume_mode=mode), self.assertRaisesRegex(
                RELEASE.DeployError,
                "FLOWISE_RUNTIME_MOUNT_ALLOWLIST_MISMATCH",
            ):
                RELEASE.validate_bootstrap_hardened_runtime(runtime, **arguments)

        for label, volume_options in (
            ("no-copy", {"NoCopy": True}),
            ("subpath-escape", {"Subpath": "../../etc"}),
            (
                "driver-config",
                {"DriverConfig": {"Name": "local", "Options": {"device": "/etc"}}},
            ),
        ):
            runtime = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
            runtime[RELEASE.FLOWISE_CONTAINER]["Mounts"][0]["Mode"] = "z"
            runtime[RELEASE.FLOWISE_CONTAINER]["HostConfig"]["Mounts"][0][
                "VolumeOptions"
            ] = volume_options
            with self.subTest(host_volume_options_drift=label), self.assertRaisesRegex(
                RELEASE.DeployError,
                "FLOWISE_RUNTIME_MOUNT_ALLOWLIST_MISMATCH",
            ):
                RELEASE.validate_bootstrap_hardened_runtime(runtime, **arguments)

    def test_hardened_runtime_accepts_distinct_requested_and_observed_hash_only_with_exact_contract(self):
        seccomp_document = {"defaultAction": "SCMP_ACT_ERRNO"}
        seccomp_inline = json.dumps(seccomp_document, sort_keys=True, separators=(",", ":"))
        seccomp_digest = RELEASE.sha256_bytes(RELEASE.canonical_json(seccomp_document))
        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        runtime = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        runtime[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = OBSERVED_HARDENED_CONFIG_HASH
        runtime[RELEASE.FLOWISE_CONTAINER]["HostConfig"]["SecurityOpt"] = [
            "no-new-privileges:true",
            f"seccomp={seccomp_inline}",
        ]
        expected_image = runtime_image_authority(LEGACY_TAG, LEGACY_DIGEST)
        replaced_container_id = "2" * 64

        with mock.patch.object(RELEASE, "_live_seccomp_canonical_digest", return_value=seccomp_digest):
            with self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_RUNTIME_CONFIG_HASH_MISMATCH"):
                RELEASE.validate_bootstrap_hardened_runtime(
                    runtime,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=network_identity(),
                )
            result = RELEASE.validate_bootstrap_hardened_runtime(
                runtime,
                image_tag=LEGACY_TAG,
                image_digest=LEGACY_DIGEST,
                expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                expected_compose=config,
                expected_network_identity=network_identity(),
                expected_image=expected_image,
                expected_replaced_container_id=replaced_container_id,
                allow_opaque_config_hash=True,
            )
        self.assertNotEqual(REQUESTED_HARDENED_CONFIG_HASH, OBSERVED_HARDENED_CONFIG_HASH)
        self.assertEqual(result["requested_compose_config_hash"], REQUESTED_HARDENED_CONFIG_HASH)
        self.assertEqual(result["observed_runtime_config_hash"], OBSERVED_HARDENED_CONFIG_HASH)
        self.assertIs(result["opaque_config_hash_semantic_contract_verified"], True)

        with mock.patch.object(
            RELEASE,
            "_live_seccomp_canonical_digest",
            return_value=seccomp_digest,
        ), self.assertRaisesRegex(RELEASE.DeployError, "OPAQUE_HASH_AUTHORITY_MISSING"):
            RELEASE.validate_bootstrap_hardened_runtime(
                runtime,
                image_tag=LEGACY_TAG,
                image_digest=LEGACY_DIGEST,
                expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                expected_compose=config,
                expected_network_identity=network_identity(),
                allow_opaque_config_hash=True,
            )

        semantic_variants = (
            (
                "path",
                lambda value: value.update({"Path": "/attacker"}),
                "PROCESS_CONTRACT_MISMATCH",
            ),
            (
                "args",
                lambda value: value["Args"].append("--unsafe"),
                "PROCESS_CONTRACT_MISMATCH",
            ),
            (
                "cmd",
                lambda value: value["Config"]["Cmd"].append("--unsafe"),
                "CONFIG_CONTRACT_MISMATCH",
            ),
            (
                "entrypoint",
                lambda value: value["Config"].update({"Entrypoint": ["/attacker"]}),
                "CONFIG_CONTRACT_MISMATCH",
            ),
            (
                "working-dir",
                lambda value: value["Config"].update({"WorkingDir": "/tmp"}),
                "CONFIG_CONTRACT_MISMATCH",
            ),
            (
                "hostname",
                lambda value: value["Config"].update({"Hostname": "attacker"}),
                "HOSTNAME_BINDING_MISMATCH",
            ),
            (
                "extra-label",
                lambda value: value["Config"]["Labels"].update({"attacker": "true"}),
                "LABEL_CONTRACT_MISMATCH",
            ),
            (
                "missing-label",
                lambda value: value["Config"]["Labels"].pop("com.docker.compose.service"),
                "LABEL_CONTRACT_MISMATCH",
            ),
        )
        host_drift_values = {
            "Dns": ["8.8.8.8"],
            "DnsOptions": ["use-vc"],
            "DnsSearch": ["attacker.invalid"],
            "ExtraHosts": ["attacker:1.2.3.4"],
            "Sysctls": {"kernel.shm_rmid_forced": "1"},
            "Ulimits": [{"Name": "nofile", "Soft": 1, "Hard": 1}],
            "GroupAdd": ["0"],
            "Links": ["attacker:attacker"],
            "VolumesFrom": ["attacker:rw"],
            "AutoRemove": True,
            "OomKillDisable": True,
            "ShmSize": 1,
            "Runtime": "attacker",
            "ConsoleSize": [1, 1],
            "Isolation": "hyperv",
        }
        semantic_variants += tuple(
            (
                f"host-{name}",
                lambda value, field=name, drift=drift: value["HostConfig"].update(
                    {field: copy.deepcopy(drift)}
                ),
                "HOSTCONFIG_CONTRACT_MISMATCH",
            )
            for name, drift in host_drift_values.items()
        )
        for label, mutate, expected_error in semantic_variants:
            drifted = copy.deepcopy(runtime)
            mutate(drifted[RELEASE.FLOWISE_CONTAINER])
            with self.subTest(semantic_surface=label), mock.patch.object(
                RELEASE,
                "_live_seccomp_canonical_digest",
                return_value=seccomp_digest,
            ), self.assertRaisesRegex(RELEASE.DeployError, expected_error):
                RELEASE.validate_bootstrap_hardened_runtime(
                    drifted,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=network_identity(),
                    expected_image=expected_image,
                    expected_replaced_container_id=replaced_container_id,
                    allow_opaque_config_hash=True,
                )

        for label, image_authority, replaced_id, expected_error in (
            (
                "image-authority",
                {**expected_image, "image_config_digest": CANDIDATE_DIGEST},
                replaced_container_id,
                "EXPECTED_IMAGE_AUTHORITY_INVALID",
            ),
            (
                "replace-authority",
                expected_image,
                "a" * 64,
                "REPLACE_LABEL_MISMATCH",
            ),
        ):
            with self.subTest(authority=label), mock.patch.object(
                RELEASE,
                "_live_seccomp_canonical_digest",
                return_value=seccomp_digest,
            ), self.assertRaisesRegex(RELEASE.DeployError, expected_error):
                RELEASE.validate_bootstrap_hardened_runtime(
                    runtime,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=network_identity(),
                    expected_image=image_authority,
                    expected_replaced_container_id=replaced_id,
                    allow_opaque_config_hash=True,
                )

        for label, mutate in (
            (
                "malformed-observed-label",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"].update(
                    {"com.docker.compose.config-hash": "not-a-64hex-hash"}
                ),
            ),
            (
                "image-drift",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["Config"].update(
                    {"Image": CANDIDATE_TAG}
                ),
            ),
            (
                "environment-drift",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].append(
                    "UNEXPECTED_RUNTIME_FLAG=true"
                ),
            ),
            (
                "database-environment-drift",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].__setitem__(
                    next(
                        index
                        for index, entry in enumerate(
                            value[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"]
                        )
                        if entry.startswith("DATABASE_HOST=")
                    ),
                    "DATABASE_HOST=attacker",
                ),
            ),
            (
                "hardening-drift",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["HostConfig"].update(
                    {"ReadonlyRootfs": False}
                ),
            ),
            (
                "projection-drift",
                lambda value: value[RELEASE.FLOWISE_CONTAINER]["Mounts"][0].update(
                    {"Propagation": "rprivate"}
                ),
            ),
        ):
            drifted = copy.deepcopy(runtime)
            mutate(drifted)
            with self.subTest(label=label), mock.patch.object(
                RELEASE,
                "_live_seccomp_canonical_digest",
                return_value=seccomp_digest,
            ), self.assertRaises(RELEASE.DeployError):
                RELEASE.validate_bootstrap_hardened_runtime(
                    drifted,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=network_identity(),
                    expected_image=expected_image,
                    expected_replaced_container_id=replaced_container_id,
                    allow_opaque_config_hash=True,
                )

    def test_opaque_hash_semantic_contract_covers_every_config_and_hostconfig_key(self):
        expected_image = runtime_image_authority(LEGACY_TAG, LEGACY_DIGEST)
        replaced_container_id = "2" * 64
        documents_value = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        flowise = documents_value[RELEASE.FLOWISE_CONTAINER]
        flowise["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = OBSERVED_HARDENED_CONFIG_HASH

        def validate(value):
            RELEASE._validate_hardened_runtime_semantic_surface(
                value,
                image_tag=LEGACY_TAG,
                image_digest=LEGACY_DIGEST,
                observed_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
                expected_image=expected_image,
                expected_replaced_container_id=replaced_container_id,
                expected_seccomp_digest=TEST_SECCOMP_DIGEST,
            )

        expected_config_keys = set(RELEASE.EXPECTED_RUNTIME_CONFIG_SURFACE)
        expected_host_keys = set(RELEASE.EXPECTED_RUNTIME_HOST_CONFIG_SURFACE)
        self.assertEqual(len(expected_config_keys), 17)
        self.assertEqual(len(expected_host_keys), 66)
        self.assertNotIn("Env", expected_config_keys)
        self.assertNotIn("Labels", expected_config_keys)
        self.assertEqual(set(flowise["Config"]) - {"Env", "Labels"}, expected_config_keys)
        self.assertEqual(set(flowise["HostConfig"]), expected_host_keys)
        self.assertTrue(
            {"MaskedPaths", "ReadonlyPaths", "CgroupParent", "MemorySwap"}
            <= expected_host_keys
        )
        self.assertNotIn("Sysctls", expected_host_keys)
        self.assertEqual(len(flowise["Config"]["Labels"]), 16)
        validate(flowise)

        # Environment is independently exact-bound by validate_runtime; the
        # semantic Config comparison must omit values that can contain secrets.
        environment_variant = copy.deepcopy(flowise)
        environment_variant["Config"]["Env"].append("SEMANTIC_ONLY_ATTACKER=true")
        validate(environment_variant)

        # Docker may omit its zero default.  Any non-zero value remains drift.
        no_start_interval = copy.deepcopy(flowise)
        no_start_interval["Config"]["Healthcheck"].pop("StartInterval")
        validate(no_start_interval)
        nonzero_start_interval = copy.deepcopy(flowise)
        nonzero_start_interval["Config"]["Healthcheck"]["StartInterval"] = 1
        with self.assertRaisesRegex(RELEASE.DeployError, "CONFIG_CONTRACT_MISMATCH"):
            validate(nonzero_start_interval)

        # Hostname is Docker's current ID prefix, not a frozen identifier.
        rebound_identity = copy.deepcopy(flowise)
        rebound_identity["Id"] = "9" * 64
        rebound_identity["Config"]["Hostname"] = "9" * 12
        validate(rebound_identity)
        unbound_identity = copy.deepcopy(rebound_identity)
        unbound_identity["Config"]["Hostname"] = "8" * 12
        with self.assertRaisesRegex(RELEASE.DeployError, "HOSTNAME_BINDING_MISMATCH"):
            validate(unbound_identity)

        # Order and Docker's accepted no-new-privileges spellings do not alter
        # meaning; unknown/duplicate/disabled options remain fail-closed.
        semantic_security_options = (
            [f"seccomp={TEST_SECCOMP_INLINE}", "no-new-privileges"],
            ["no-new-privileges=true", f"seccomp={json.dumps(TEST_SECCOMP_DOCUMENT, indent=2)}"],
        )
        for options in semantic_security_options:
            equivalent = copy.deepcopy(flowise)
            equivalent["HostConfig"]["SecurityOpt"] = options
            with self.subTest(security_opt=options[0]):
                validate(equivalent)

        for key in sorted(expected_config_keys):
            missing = copy.deepcopy(flowise)
            missing["Config"].pop(key)
            expected_error = (
                "HOSTNAME_BINDING_MISMATCH" if key == "Hostname" else "CONFIG_CONTRACT_MISMATCH"
            )
            with self.subTest(config_key=key, attack="delete"), self.assertRaisesRegex(
                RELEASE.DeployError,
                expected_error,
            ):
                validate(missing)

            replaced = copy.deepcopy(flowise)
            replaced["Config"][key] = attacker_value(replaced["Config"][key])
            with self.subTest(config_key=key, attack="replace"), self.assertRaisesRegex(
                RELEASE.DeployError,
                expected_error,
            ):
                validate(replaced)

        unexpected_config = copy.deepcopy(flowise)
        unexpected_config["Config"]["__attacker__"] = True
        with self.assertRaisesRegex(RELEASE.DeployError, "CONFIG_CONTRACT_MISMATCH"):
            validate(unexpected_config)

        for key in sorted(expected_host_keys):
            missing = copy.deepcopy(flowise)
            missing["HostConfig"].pop(key)
            missing_error = (
                "SECURITY_OPT_INVALID" if key == "SecurityOpt" else "HOSTCONFIG_CONTRACT_MISMATCH"
            )
            with self.subTest(host_config_key=key, attack="delete"), self.assertRaisesRegex(
                RELEASE.DeployError,
                missing_error,
            ):
                validate(missing)

            replaced = copy.deepcopy(flowise)
            replaced["HostConfig"][key] = attacker_value(replaced["HostConfig"][key])
            replaced_error = (
                "SECURITY_OPT_UNKNOWN" if key == "SecurityOpt" else "HOSTCONFIG_CONTRACT_MISMATCH"
            )
            with self.subTest(host_config_key=key, attack="replace"), self.assertRaisesRegex(
                RELEASE.DeployError,
                replaced_error,
            ):
                validate(replaced)

        for extra_key, extra_value in (("Sysctls", None), ("__attacker__", True)):
            unexpected_host = copy.deepcopy(flowise)
            unexpected_host["HostConfig"][extra_key] = extra_value
            with self.subTest(host_config_extra=extra_key), self.assertRaisesRegex(
                RELEASE.DeployError,
                "HOSTCONFIG_CONTRACT_MISMATCH",
            ):
                validate(unexpected_host)

    def test_opaque_hash_full_runtime_validation_requires_and_enforces_exact_environment(self):
        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        documents_value = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        documents_value[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = OBSERVED_HARDENED_CONFIG_HASH
        expected_image = runtime_image_authority(LEGACY_TAG, LEGACY_DIGEST)
        expected_runtime_stable = RELEASE._expected_hardened_runtime_stable_projection(
            config,
            TEST_SECCOMP_DIGEST,
        )
        arguments = {
            "image_tag": LEGACY_TAG,
            "image_digest": LEGACY_DIGEST,
            "expected_config_hash": REQUESTED_HARDENED_CONFIG_HASH,
            "expected_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
            "require_candidate_hardening": True,
            "expected_compose": config,
            "expected_runtime_stable": expected_runtime_stable,
            "allow_opaque_config_hash": True,
            "expected_image": expected_image,
            "expected_replaced_container_id": "2" * 64,
        }

        accepted = RELEASE.validate_runtime(
            documents_value,
            require_exact_environment=True,
            **arguments,
        )
        self.assertIs(accepted["opaque_config_hash_semantic_contract_verified"], True)

        injected = copy.deepcopy(documents_value)
        injected[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].append(
            "UNEXPECTED_NON_DATABASE_FLAG=true"
        )
        with self.assertRaisesRegex(RELEASE.DeployError, "ENVIRONMENT_MISMATCH"):
            RELEASE.validate_runtime(
                injected,
                require_exact_environment=True,
                **arguments,
            )
        with self.assertRaisesRegex(RELEASE.DeployError, "OPAQUE_HASH_AUTHORITY_MISSING"):
            RELEASE.validate_runtime(
                injected,
                require_exact_environment=False,
                **arguments,
            )

    def test_live_file_accepts_only_the_production_owner_allowlist_and_exact_mode(self):
        payload = b'{"defaultAction":"SCMP_ACT_ERRNO"}\n'
        maximum = 2 * 1024 * 1024

        for owner in ((0, 0), (1000, 1000)):
            path = types.SimpleNamespace(
                name="chromium.json",
                lstat=mock.Mock(
                    return_value=types.SimpleNamespace(
                        st_uid=owner[0],
                        st_gid=owner[1],
                        st_mode=stat.S_IFREG | 0o644,
                    )
                ),
            )
            reader = mock.Mock(return_value=payload)
            with self.subTest(owner=owner), mock.patch.object(RELEASE, "read_regular", reader):
                data, metadata = RELEASE.live_file(path, 0o644, maximum=maximum)
            self.assertEqual(data, payload)
            self.assertEqual(metadata, (owner[0], owner[1], 0o644))
            reader.assert_called_once_with(
                path,
                maximum=maximum,
                expected_uid=owner[0],
                expected_gid=owner[1],
                expected_mode=0o644,
            )

        for label, owner, mode in (
            ("unlisted-owner", (501, 20), 0o644),
            ("mixed-owner", (0, 1000), 0o644),
            ("owner-mode-drift", (1000, 1000), 0o600),
            ("world-writable-mode", (0, 0), 0o666),
        ):
            path = types.SimpleNamespace(
                name="chromium.json",
                lstat=mock.Mock(
                    return_value=types.SimpleNamespace(
                        st_uid=owner[0],
                        st_gid=owner[1],
                        st_mode=stat.S_IFREG | mode,
                    )
                ),
            )
            reader = mock.Mock(
                side_effect=AssertionError("unsafe metadata must fail before content read")
            )
            with self.subTest(label=label), mock.patch.object(
                RELEASE,
                "read_regular",
                reader,
            ), self.assertRaisesRegex(RELEASE.DeployError, "LIVE_FILE_METADATA_MISMATCH"):
                RELEASE.live_file(path, 0o644, maximum=maximum)
            reader.assert_not_called()

    def test_live_seccomp_digest_reader_uses_exact_mode_and_two_mib_bound(self):
        profile = canonical(TEST_SECCOMP_DOCUMENT)
        reader = mock.Mock(return_value=(profile, (1000, 1000, 0o644)))
        with mock.patch.object(
            RELEASE,
            "_validate_live_seccomp_parents",
        ) as validate_parents, mock.patch.object(
            RELEASE,
            "live_file",
            reader,
        ):
            observed = ORIGINAL_LIVE_SECCOMP_CANONICAL_DIGEST()

        self.assertEqual(observed, TEST_SECCOMP_DIGEST)
        validate_parents.assert_called_once_with(allow_missing=False)
        reader.assert_called_once_with(
            RELEASE.LIVE_SECCOMP,
            0o644,
            maximum=2 * 1024 * 1024,
        )

    def test_hardened_runtime_normalizes_actual_inline_seccomp_and_rejects_every_ambiguous_form(self):
        sentinel = "inline-seccomp-secret-must-never-leak"
        profile = canonical(
            {
                "architectures": ["SCMP_ARCH_X86_64"],
                "defaultAction": "SCMP_ACT_ERRNO",
                "syscalls": [{"action": "SCMP_ACT_ALLOW", "names": ["read", "write"]}],
            }
        )
        inline = json.dumps(json.loads(profile), sort_keys=True, separators=(",", ":"))
        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        base = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        base[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = REQUESTED_HARDENED_CONFIG_HASH
        base[RELEASE.FLOWISE_CONTAINER]["HostConfig"]["SecurityOpt"] = [
            "no-new-privileges:true",
            f"seccomp={inline}",
        ]

        with tempfile.TemporaryDirectory() as directory:
            base_dir = Path(directory)
            seccomp = base_dir / "docker/seccomp/chromium.json"
            seccomp.parent.mkdir(parents=True)
            seccomp.write_bytes(profile)
            live_reader = mock.Mock(return_value=(profile, (1000, 1000, 0o644)))
            self.live_seccomp_digest.side_effect = ORIGINAL_LIVE_SECCOMP_CANONICAL_DIGEST
            with mock.patch.object(RELEASE, "BASE_DIR", base_dir), mock.patch.object(
                RELEASE, "LIVE_SECCOMP", seccomp
            ), mock.patch.object(
                RELEASE,
                "live_file",
                live_reader,
            ):
                result = RELEASE.validate_bootstrap_hardened_runtime(
                    base,
                    image_tag=LEGACY_TAG,
                    image_digest=LEGACY_DIGEST,
                    expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                    expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                    expected_compose=config,
                    expected_network_identity=network_identity(),
                )
                self.assertTrue(result["runtime_hardening_verified"])

                variants = {
                    "missing-nnp": [f"seccomp={inline}"],
                    "nnp-false": ["no-new-privileges:false", f"seccomp={inline}"],
                    "duplicate-nnp": [
                        "no-new-privileges:true",
                        "no-new-privileges:true",
                        f"seccomp={inline}",
                    ],
                    "duplicate-seccomp": [
                        "no-new-privileges:true",
                        f"seccomp={inline}",
                        f"seccomp={inline}",
                    ],
                    "unknown-option": [
                        "no-new-privileges:true",
                        f"seccomp={inline}",
                        "apparmor=unconfined",
                    ],
                    "malformed-inline-json": ["no-new-privileges:true", "seccomp={not-json"],
                    "duplicate-inline-json-key": [
                        "no-new-privileges:true",
                        'seccomp={"defaultAction":"SCMP_ACT_ERRNO","defaultAction":"SCMP_ACT_ALLOW"}',
                    ],
                    "content-digest-drift": [
                        "no-new-privileges:true",
                        "seccomp="
                        + json.dumps(
                            {"defaultAction": "SCMP_ACT_ALLOW", "sentinel": sentinel},
                            sort_keys=True,
                            separators=(",", ":"),
                        ),
                    ],
                }
                for label, security in variants.items():
                    drifted = copy.deepcopy(base)
                    drifted[RELEASE.FLOWISE_CONTAINER]["HostConfig"]["SecurityOpt"] = security
                    with self.subTest(label=label), self.assertRaises(RELEASE.DeployError) as raised:
                        RELEASE.validate_bootstrap_hardened_runtime(
                            drifted,
                            image_tag=LEGACY_TAG,
                            image_digest=LEGACY_DIGEST,
                            expected_config_hash=REQUESTED_HARDENED_CONFIG_HASH,
                            expected_environment=copy.deepcopy(HARDENED_ENVIRONMENT),
                            expected_compose=config,
                            expected_network_identity=network_identity(),
                        )
                    self.assertNotIn(sentinel, str(raised.exception))
            self.assertTrue(live_reader.call_args_list)
            self.assertTrue(
                all(
                    call
                    == mock.call(
                        seccomp,
                        0o644,
                        maximum=2 * 1024 * 1024,
                    )
                    for call in live_reader.call_args_list
                )
            )

    def test_recovery_full_runtime_projection_binds_every_stable_surface_without_environment_values(self):
        base = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)[RELEASE.FLOWISE_CONTAINER]
        base["Path"] = "/usr/local/bin/docker-entrypoint.sh"
        base["Args"] = ["node", "packages/server/bin/run", "start"]
        base["HostConfig"].update(
            {
                "Dns": ["127.0.0.11"],
                "ExtraHosts": ["host.docker.internal:host-gateway"],
                "Sysctls": {"net.ipv4.ip_unprivileged_port_start": "0"},
                "Ulimits": [{"Name": "nofile", "Soft": 1024, "Hard": 2048}],
            }
        )
        initial = RELEASE.recovery_runtime_projection_digest(base, TEST_SECCOMP_DIGEST)

        semantic_equivalent = copy.deepcopy(base)
        semantic_equivalent["HostConfig"]["SecurityOpt"] = [
            "seccomp=" + json.dumps(TEST_SECCOMP_DOCUMENT, indent=2),
            "no-new-privileges=true",
        ]
        self.assertEqual(
            RELEASE.recovery_runtime_projection_digest(semantic_equivalent, TEST_SECCOMP_DIGEST),
            initial,
        )

        secret_changed = copy.deepcopy(base)
        secret_changed["Config"]["Env"] = ["FLOWISE_SECRETKEY_OVERWRITE=sentinel-secret-value"]
        self.assertEqual(
            RELEASE.recovery_runtime_projection_digest(secret_changed, TEST_SECCOMP_DIGEST),
            initial,
        )

        for label, mutate in (
            ("path", lambda value: value.update({"Path": "/attacker"})),
            ("args", lambda value: value["Args"].append("--unsafe")),
            ("labels", lambda value: value["Config"]["Labels"].update({"attacker": "true"})),
            ("dns", lambda value: value["HostConfig"]["Dns"].append("8.8.8.8")),
            ("extra-hosts", lambda value: value["HostConfig"]["ExtraHosts"].append("attacker:1.2.3.4")),
            ("sysctls", lambda value: value["HostConfig"]["Sysctls"].update({"kernel.shm_rmid_forced": "1"})),
            ("ulimits", lambda value: value["HostConfig"]["Ulimits"][0].update({"Hard": 9999})),
            ("mounts", lambda value: value["Mounts"][0].update({"RW": False})),
            (
                "network-endpoint",
                lambda value: value["NetworkSettings"]["Networks"]["flowise_flowise_network"].update(
                    {"IPAddress": "172.28.0.99"}
                ),
            ),
        ):
            drifted = copy.deepcopy(base)
            mutate(drifted)
            with self.subTest(label=label):
                self.assertNotEqual(
                    RELEASE.recovery_runtime_projection_digest(drifted, TEST_SECCOMP_DIGEST),
                    initial,
                )

    def _bootstrap_recovery_observation_patches(
        self,
        fixture,
        *,
        documents=None,
        live_bytes=None,
        live_metadata=None,
        key=TEST_KEY,
        database=None,
        legacy_inventory=None,
        current_inventory=None,
        ping_error=None,
        journal=None,
        seccomp_authority=TEST_SECCOMP_DIGEST,
        full_runtime_authority=None,
        postgres_authority=POSTGRES_ID,
        nginx_authority=NGINX_ID,
        migration_count_authority=None,
        migration_name_authority=None,
        live_hash_reader=None,
        seccomp_path_reader=None,
    ):
        context = fixture["context"]
        prepared = fixture["prepare"]
        observed = copy.deepcopy(documents if documents is not None else fixture["documents"])
        selected_journal = copy.deepcopy(journal if journal is not None else fixture["journal"])
        selected_journal_data = canonical(selected_journal)
        selected_metadata = live_metadata if live_metadata is not None else prepared["live_metadata"]
        selected_live_bytes = copy.deepcopy(
            live_bytes if live_bytes is not None else fixture["live_bytes"]
        )
        selected_full_runtime_authority = (
            fixture["full_runtime_projection_digest"]
            if full_runtime_authority is None
            else full_runtime_authority
        )
        selected_migration_count_authority = (
            prepared["baseline"]["database"]["migration_count"]
            if migration_count_authority is None
            else migration_count_authority
        )
        selected_migration_name_authority = (
            prepared["baseline"]["database"]["migration_name_sha256"]
            if migration_name_authority is None
            else migration_name_authority
        )
        prohibited_live_hash_reader = live_hash_reader or mock.Mock(
            side_effect=AssertionError("bootstrap recovery must not reopen live paths for hashing")
        )
        prohibited_seccomp_path_reader = seccomp_path_reader or mock.Mock(
            side_effect=AssertionError("bootstrap recovery must not reopen the live seccomp path")
        )
        metadata_by_path = {
            RELEASE.LIVE_ENV: tuple(selected_metadata["env"]),
            RELEASE.LIVE_COMPOSE: tuple(selected_metadata["compose"]),
            RELEASE.LIVE_SECCOMP: tuple(selected_metadata["seccomp"]),
        }
        return (
            mock.patch.object(
                RELEASE,
                "_validate_bootstrap_recovery_run_topology",
                return_value=False,
            ),
            mock.patch.object(
                RELEASE,
                "_read_canonical_run_journal",
                return_value=(selected_journal, selected_journal_data, digest(selected_journal_data)),
            ),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_SECCOMP_CANONICAL_DIGEST",
                seccomp_authority,
            ),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_FULL_RUNTIME_PROJECTION_DIGEST",
                selected_full_runtime_authority,
            ),
            mock.patch.object(RELEASE, "BOOTSTRAP_RECOVERY_POSTGRES_CONTAINER_ID", postgres_authority),
            mock.patch.object(RELEASE, "BOOTSTRAP_RECOVERY_NGINX_CONTAINER_ID", nginx_authority),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_MIGRATION_COUNT",
                selected_migration_count_authority,
            ),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_MIGRATION_NAME_DIGEST",
                selected_migration_name_authority,
            ),
            mock.patch.object(RELEASE, "_require_control_absent"),
            mock.patch.object(
                RELEASE,
                "live_file",
                side_effect=lambda path, _mode: (
                    selected_live_bytes[Path(path)],
                    metadata_by_path[Path(path)],
                ),
            ),
            mock.patch.object(
                RELEASE,
                "_live_hashes",
                prohibited_live_hash_reader,
            ),
            mock.patch.object(
                RELEASE,
                "_live_seccomp_canonical_digest",
                prohibited_seccomp_path_reader,
            ),
            mock.patch.object(RELEASE, "inspect_containers", return_value=observed),
            mock.patch.object(
                RELEASE,
                "inspect_image",
                return_value={
                    "image_tag": LEGACY_TAG,
                    "image_config_digest": prepared["legacy"]["image_config_digest"],
                    "revision": LEGACY_REVISION,
                    "release_id": f"git-{LEGACY_REVISION}",
                    "repository_url": LEGACY_SOURCE,
                    "created_at": LEGACY_CREATED_AT,
                    "image_environment": copy.deepcopy(fixture["image_environment"]),
                },
            ),
            mock.patch.object(RELEASE, "persistent_key", return_value=key),
            mock.patch.object(
                RELEASE,
                "_resolved_live",
                return_value=(
                    context["expected"]["hardened_config"],
                    REQUESTED_HARDENED_CONFIG_HASH,
                    RELEASE.service_environment(context["expected"]["hardened_config"]),
                ),
            ),
            mock.patch.object(
                RELEASE,
                "database_state",
                return_value=copy.deepcopy(database if database is not None else prepared["baseline"]["database"]),
            ),
            mock.patch.object(
                RELEASE,
                "legacy_journal_inventory",
                return_value=copy.deepcopy(
                    legacy_inventory
                    if legacy_inventory is not None
                    else prepared["baseline"]["legacy_journal_inventory"]
                ),
            ),
            mock.patch.object(
                RELEASE,
                "current_journal_inventory",
                return_value=copy.deepcopy(
                    current_inventory
                    if current_inventory is not None
                    else prepared["baseline"]["current_journal_inventory"]
                ),
            ),
            mock.patch.object(RELEASE, "runtime_pings", side_effect=ping_error),
        )

    def _capture_bootstrap_recovery_fixture(self, fixture):
        with _MultiPatch(self._bootstrap_recovery_observation_patches(fixture)):
            return RELEASE._capture_stable_bootstrap_recovery(
                fixture["context"],
                expected_current_flowise_container_id=RECOVERY_FLOWISE_ID,
                expected_observed_runtime_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
                require_interrupted_journal=True,
            )

    def test_bootstrap_recovery_hashes_each_single_open_read_and_never_reopens_live_paths(self):
        fixture = bootstrap_recovery_fixture()
        metadata = fixture["prepare"]["live_metadata"]
        metadata_by_path = {
            RELEASE.LIVE_ENV: tuple(metadata["env"]),
            RELEASE.LIVE_COMPOSE: tuple(metadata["compose"]),
            RELEASE.LIVE_SECCOMP: tuple(metadata["seccomp"]),
        }
        reader = mock.Mock(
            side_effect=lambda path, _mode: (
                fixture["live_bytes"][Path(path)],
                metadata_by_path[Path(path)],
            )
        )
        live_hash_reopen = mock.Mock(
            side_effect=AssertionError("reopening live paths would restore the pathname TOCTOU")
        )
        seccomp_path_reopen = mock.Mock(
            side_effect=AssertionError("reopening seccomp would restore the pathname TOCTOU")
        )
        patches = list(
            self._bootstrap_recovery_observation_patches(
                fixture,
                live_hash_reader=live_hash_reopen,
                seccomp_path_reader=seccomp_path_reopen,
            )
        )
        patches.append(mock.patch.object(RELEASE, "live_file", reader))
        with _MultiPatch(tuple(patches)):
            observation = RELEASE._bootstrap_recovery_observation(
                fixture["context"],
                expected_current_flowise_container_id=RECOVERY_FLOWISE_ID,
                expected_observed_runtime_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
                require_interrupted_journal=True,
            )

        self.assertEqual(
            reader.call_args_list,
            [
                mock.call(RELEASE.LIVE_ENV, 0o600),
                mock.call(RELEASE.LIVE_COMPOSE, 0o644),
                mock.call(RELEASE.LIVE_SECCOMP, 0o644),
            ],
        )
        live_hash_reopen.assert_not_called()
        seccomp_path_reopen.assert_not_called()
        self.assertEqual(
            observation["material"]["live_files"],
            fixture["prepare"]["hardened_active"]["files"],
        )

    def test_snapshot_bootstrap_recovery_double_observes_exact_hhh_state_and_is_secret_free_zero_write(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        prohibited = {
            name: mock.Mock(side_effect=AssertionError(f"{name} must remain zero-write"))
            for name in (
                "_write_receipt",
                "_journal",
                "install_config_set",
                "compose_recreate",
                "load_candidate",
                "atomic_write",
                "_execute_legacy_rollback_transaction",
            )
        }
        patches = list(self._bootstrap_recovery_observation_patches(fixture))
        patches.extend(mock.patch.object(RELEASE, name, value) for name, value in prohibited.items())
        patches.append(mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context))
        with PatchedLock(self), _MultiPatch(tuple(patches)):
            result = RELEASE.snapshot_bootstrap_recovery(
                Path("/recovery-bundle"),
                Path("/source-bundle"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
            )

        self.assertEqual(result["status"], "bootstrap_recovery_snapshot_verified")
        self.assertEqual(result["run_id"], RECOVERY_RUN_ID)
        expected_stdout_keys = {
            "status",
            "run_id",
            "recovery_snapshot_sha256",
            "recovery_bundle_sha256",
            "source_bundle_sha256",
            "journal_pre_sha256",
            "requested_compose_config_hash",
            "observed_runtime_config_hash",
            "semantic_runtime_projection_sha256",
            "full_runtime_projection_sha256",
            "production_runtime_write",
            "control_artifact_write",
            "database_write",
            "provider_call",
            "secret_value_output",
        }
        self.assertEqual(set(result), expected_stdout_keys)
        self.assertRegex(result["recovery_snapshot_sha256"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(result["requested_compose_config_hash"], REQUESTED_HARDENED_CONFIG_HASH)
        self.assertEqual(result["observed_runtime_config_hash"], OBSERVED_HARDENED_CONFIG_HASH)
        for name in ("semantic_runtime_projection_sha256", "full_runtime_projection_sha256"):
            self.assertRegex(result[name], r"^sha256:[0-9a-f]{64}$")
        for name in (
            "production_runtime_write",
            "control_artifact_write",
            "database_write",
            "provider_call",
            "secret_value_output",
        ):
            self.assertIs(result[name], False)
        self.assertNotIn(fixture["sentinel"], canonical(result).decode())
        for operation in prohibited.values():
            operation.assert_not_called()

        stdout = io.StringIO()
        arguments = types.SimpleNamespace(
            command="snapshot-bootstrap-recovery",
            bundle_dir=Path("/recovery-bundle"),
            source_bundle_dir=Path("/source-bundle"),
            run_id=RECOVERY_RUN_ID,
            transition_permit=fixture["permit"].path,
            transition_permit_sha256=fixture["permit"].digest,
            bootstrap_prepare_receipt_sha256=context["prepare_digest"],
            expected_current_flowise_container_id=RECOVERY_FLOWISE_ID,
            expected_observed_runtime_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
        )
        with mock.patch.object(RELEASE, "parse_args", return_value=arguments), mock.patch.object(
            RELEASE,
            "snapshot_bootstrap_recovery",
            return_value=result,
        ), mock.patch("sys.stdout", stdout):
            RELEASE.main([])
        self.assertEqual(
            stdout.getvalue(),
            json.dumps(result, sort_keys=True, separators=(",", ":")) + "\n",
        )

    def test_bootstrap_recovery_observation_rejects_every_live_authority_drift_without_secret_leak(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        base_documents = fixture["documents"]
        variants = []

        replaced = copy.deepcopy(base_documents)
        replaced[RELEASE.FLOWISE_CONTAINER]["Id"] = "e" * 64
        variants.append(("container", {"documents": replaced}, "CONTAINER_ID"))

        label = copy.deepcopy(base_documents)
        label[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = "f" * 64
        variants.append(("label", {"documents": label}, "OBSERVED_CONFIG_HASH"))

        malformed_label = copy.deepcopy(base_documents)
        malformed_label[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = "malformed"
        variants.append(("malformed-label", {"documents": malformed_label}, "CONFIG_HASH_INVALID"))

        image = copy.deepcopy(base_documents)
        image[RELEASE.FLOWISE_CONTAINER]["Config"]["Image"] = CANDIDATE_TAG
        variants.append(("image", {"documents": image}, "ACTIVE_IMAGE"))

        sidecar = copy.deepcopy(base_documents)
        sidecar[RELEASE.POSTGRES_CONTAINER]["RestartCount"] = 1
        variants.append(("sidecar", {"documents": sidecar}, "SIDECAR_DRIFT"))

        network = copy.deepcopy(base_documents)
        network[RELEASE.FLOWISE_CONTAINER]["NetworkSettings"]["Networks"][
            "flowise_flowise_network"
        ]["NetworkID"] = "f" * 64
        variants.append(("network", {"documents": network}, "NETWORK"))

        changed_live_bytes = copy.deepcopy(fixture["live_bytes"])
        changed_live_bytes[RELEASE.LIVE_COMPOSE] = b"compose-bytes-drift"
        variants.append(("live-files", {"live_bytes": changed_live_bytes}, "LIVE_FILES_NOT_HHH"))

        metadata = copy.deepcopy(fixture["prepare"]["live_metadata"])
        metadata["env"][2] = 0o644
        variants.append(("live-file-metadata", {"live_metadata": metadata}, "LIVE_FILE_METADATA_DRIFT"))

        environment = copy.deepcopy(base_documents)
        environment[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"].append("UNEXPECTED_RUNTIME_FLAG=true")
        variants.append(("environment", {"documents": environment}, "RUNTIME_ENVIRONMENT_MISMATCH"))

        database = copy.deepcopy(fixture["prepare"]["baseline"]["database"])
        database["migration_count"] += 1
        variants.append(("database", {"database": database}, "DATABASE_DRIFT"))

        legacy_inventory = copy.deepcopy(fixture["prepare"]["baseline"]["legacy_journal_inventory"])
        legacy_inventory["unresolved_rollback_count"] = 1
        variants.append(("legacy-journal", {"legacy_inventory": legacy_inventory}, "LEGACY_JOURNAL_DRIFT"))

        current_inventory = {"present": True, "unresolved_rollback_count": 1}
        variants.append(("second-unresolved", {"current_inventory": current_inventory}, "CURRENT_JOURNAL_DRIFT"))
        variants.append(("key", {"key": b"x" * 32}, "KEY_CAS"))
        variants.append(("ping", {"ping_error": RELEASE.DeployError("PRIVATE_PING_FAILED")}, "PRIVATE_PING_FAILED"))
        variants.append(
            (
                "seccomp-authority",
                {"seccomp_authority": digest(b"other-seccomp")},
                "SECCOMP_NOT_AUTHORIZED",
            )
        )
        variants.append(
            (
                "full-runtime-authority",
                {"full_runtime_authority": digest(b"other-runtime")},
                "FULL_RUNTIME_NOT_AUTHORIZED",
            )
        )
        variants.append(
            (
                "postgres-authority",
                {"postgres_authority": "a" * 64},
                "SIDECAR_DRIFT_flowise-postgres",
            )
        )
        variants.append(
            (
                "nginx-authority",
                {"nginx_authority": "b" * 64},
                f"SIDECAR_DRIFT_{RELEASE.NGINX_CONTAINER}",
            )
        )
        variants.append(
            (
                "migration-count-authority",
                {
                    "migration_count_authority": fixture["prepare"]["baseline"]["database"][
                        "migration_count"
                    ]
                    + 1
                },
                "DATABASE_DRIFT",
            )
        )
        variants.append(
            (
                "migration-name-authority",
                {"migration_name_authority": digest(b"other-migration-names")},
                "DATABASE_DRIFT",
            )
        )

        for label, overrides, expected_error in variants:
            writer = mock.Mock()
            with self.subTest(label=label), _MultiPatch(
                self._bootstrap_recovery_observation_patches(fixture, **overrides)
                + (
                    mock.patch.object(RELEASE, "_write_receipt", writer),
                    mock.patch.object(RELEASE, "_journal", writer),
                    mock.patch.object(RELEASE, "install_config_set", writer),
                    mock.patch.object(RELEASE, "compose_recreate", writer),
                    mock.patch.object(RELEASE, "load_candidate", writer),
                )
            ), self.assertRaisesRegex(RELEASE.DeployError, expected_error) as raised:
                RELEASE._bootstrap_recovery_observation(
                    context,
                    expected_current_flowise_container_id=RECOVERY_FLOWISE_ID,
                    expected_observed_runtime_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
                    require_interrupted_journal=True,
                )
            writer.assert_not_called()
            self.assertNotIn(fixture["sentinel"], str(raised.exception))

    def test_bootstrap_recovery_double_observation_and_snapshot_digest_are_cas_bound(self):
        fixture = bootstrap_recovery_fixture()
        observation = {"material": {"stable": True}, "snapshot": {}, "runtime": {}, "database": {}}
        drifted = copy.deepcopy(observation)
        drifted["material"]["stable"] = False
        with mock.patch.object(
            RELEASE,
            "_bootstrap_recovery_observation",
            side_effect=[observation, drifted],
        ), self.assertRaisesRegex(RELEASE.DeployError, "OBSERVATION_CAS_MISMATCH"):
            RELEASE._capture_stable_bootstrap_recovery(
                fixture["context"],
                expected_current_flowise_container_id=RECOVERY_FLOWISE_ID,
                expected_observed_runtime_config_hash=OBSERVED_HARDENED_CONFIG_HASH,
                require_interrupted_journal=True,
            )

    def test_bootstrap_recovery_static_context_binds_new_and_source_bundles_permit_receipt_and_journal(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        prepared = fixture["prepare"]
        target_compose = b"target-compose"
        target_seccomp = b"target-seccomp"
        target_env = RELEASE.render_env(
            context["expected"]["legacy_env"],
            fixture["source_bundle"].image_tag,
        )
        target_config = copy.deepcopy(context["expected"]["hardened_config"])
        target_config["services"]["flowise"]["image"] = fixture["source_bundle"].image_tag
        verify_recovery = mock.Mock(return_value=fixture["recovery_bundle"])
        verify_source = mock.Mock(return_value=fixture["source_bundle"])
        controls_absent = mock.Mock()
        patches = (
            mock.patch.object(RELEASE, "verify_bundle", verify_recovery),
            mock.patch.object(RELEASE, "verify_source_bundle", verify_source),
            mock.patch.object(
                RELEASE,
                "_validate_bootstrap_recovery_run_topology",
                return_value=False,
            ),
            mock.patch.object(RELEASE, "_validate_transition_permit_parent"),
            mock.patch.object(RELEASE, "_validate_transition_permit_directory"),
            mock.patch.object(RELEASE, "verify_transition_permit", return_value=fixture["permit"]),
            mock.patch.object(
                RELEASE,
                "_read_receipt",
                return_value=(context["run_dir"], prepared),
            ),
            mock.patch.object(
                RELEASE,
                "_read_canonical_run_journal",
                return_value=(context["journal"], context["journal_data"], context["journal_pre_sha256"]),
            ),
            mock.patch.object(RELEASE, "_require_control_absent", controls_absent),
            mock.patch.object(RELEASE, "persistent_key", return_value=TEST_KEY),
            mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=context["expected"]),
            mock.patch.object(
                RELEASE,
                "_load_staged",
                return_value=(Path("/staged/target_bundle"), target_env, target_compose, target_seccomp),
            ),
            mock.patch.object(RELEASE, "compose_config", return_value=target_config),
            mock.patch.object(RELEASE, "validate_hardened_compose"),
            mock.patch.object(
                RELEASE,
                "compose_service_hash",
                return_value=prepared["target_bundle"]["compose_config_hash"],
            ),
        )
        with _MultiPatch(patches):
            result = RELEASE._bootstrap_recovery_static_context(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                require_interrupted_journal=True,
                allow_existing_complete_receipt=False,
            )
        self.assertIs(result["recovery_bundle"], fixture["recovery_bundle"])
        self.assertIs(result["source_bundle"], fixture["source_bundle"])
        self.assertEqual(result["journal_pre_sha256"], context["journal_pre_sha256"])
        verify_recovery.assert_called_once_with(Path("/recovery"))
        verify_source.assert_called_once_with(Path("/source"))
        self.assertEqual(controls_absent.call_count, 2)

        receipt_read = mock.Mock()
        with mock.patch.object(
            RELEASE,
            "_validate_bootstrap_recovery_run_topology",
            return_value=False,
        ), mock.patch.object(
            RELEASE, "verify_bundle", return_value=fixture["source_bundle"]
        ), mock.patch.object(
            RELEASE, "verify_source_bundle", return_value=fixture["source_bundle"]
        ), mock.patch.object(RELEASE, "_read_receipt", receipt_read), self.assertRaisesRegex(
            RELEASE.DeployError, "BUNDLES_NOT_DISTINCT"
        ):
            RELEASE._bootstrap_recovery_static_context(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                require_interrupted_journal=True,
                allow_existing_complete_receipt=False,
            )
        receipt_read.assert_not_called()

    def test_bootstrap_recovery_interrupted_journal_and_prepare_authority_are_exact(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        journal_args = {
            "run_id": RECOVERY_RUN_ID,
            "permit_digest": fixture["permit"].digest,
            "source_bundle_digest": fixture["source_bundle"].bundle_digest,
            "source_bundle_release_id": fixture["source_bundle"].release_id,
            "prepare_digest": context["prepare_digest"],
        }
        RELEASE._validate_bootstrap_recovery_interrupted_journal(context["journal"], **journal_args)
        for label, mutate in (
            ("phase", lambda value: value.update({"phase": "hardened_config_installing"})),
            ("state", lambda value: value.update({"state": "complete_hardened_baseline"})),
            ("live-write", lambda value: value.update({"live_write_started": False})),
            ("recreate", lambda value: value.update({"hardened_recreate_started": False})),
            ("rollback", lambda value: value.update({"rollback_attempted": True})),
            ("permit", lambda value: value.update({"permit_digest": digest(b"other")})),
            ("bundle", lambda value: value.update({"target_bundle_digest": digest(b"other")})),
            ("receipt", lambda value: value.update({"bootstrap_prepare_receipt_sha256": digest(b"other")})),
            ("unknown-key", lambda value: value.update({"unexpected_authority": True})),
            ("complete-marker", lambda value: value.update({"bootstrap_complete_receipt_sha256": digest(b"complete")})),
            ("rollback-marker", lambda value: value.update({"bootstrap_rollback_receipt_sha256": digest(b"rollback")})),
        ):
            mutated = copy.deepcopy(context["journal"])
            mutate(mutated)
            with self.subTest(layer="journal", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE._validate_bootstrap_recovery_interrupted_journal(mutated, **journal_args)

        receipt_args = {
            "run_id": RECOVERY_RUN_ID,
            "prepare_digest": context["prepare_digest"],
            "permit": fixture["permit"],
            "source_bundle": fixture["source_bundle"],
        }
        RELEASE._validate_bootstrap_recovery_prepare_receipt(fixture["prepare"], **receipt_args)
        for label, mutate in (
            ("run", lambda value: value.update({"run_id": RUN_ID})),
            ("permit", lambda value: value.update({"permit": {"digest": digest(b"other")}})),
            (
                "source-bundle",
                lambda value: value["target_bundle"].update({"bundle_digest": digest(b"other")}),
            ),
            ("target-hash", lambda value: value["target_bundle"].update({"compose_config_hash": "bad"})),
            ("legacy-image", lambda value: value["legacy"].update({"image_tag": CANDIDATE_TAG})),
            (
                "baseline-container",
                lambda value: value["baseline"]["containers"][RELEASE.NGINX_CONTAINER].update({"id": "bad"}),
            ),
            ("unknown-key", lambda value: value.update({"unexpected_authority": True})),
        ):
            mutated = copy.deepcopy(fixture["prepare"])
            mutate(mutated)
            with self.subTest(layer="prepare", label=label), self.assertRaises(RELEASE.DeployError):
                RELEASE._validate_bootstrap_recovery_prepare_receipt(mutated, **receipt_args)

    def test_generic_recovery_never_mutates_or_rolls_back_the_observed_adoption_incident(self):
        fixture = bootstrap_recovery_fixture()
        exact = fixture["journal"]
        variants = (
            ("exact", exact, "BOOTSTRAP_OBSERVED_RECOVERY_REQUIRED"),
            (
                "phase-drift",
                {**exact, "phase": "hardened_config_installing"},
                "BOOTSTRAP_RECOVERY_INTERRUPTED_STATE_MISMATCH",
            ),
            (
                "flag-drift",
                {**exact, "rollback_attempted": True},
                "BOOTSTRAP_RECOVERY_INTERRUPTED_STATE_MISMATCH",
            ),
            (
                "generic-rolling-back-state",
                {**exact, "state": "rolling_back"},
                "BOOTSTRAP_OBSERVED_RECOVERY_STATE_DRIFT",
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RECOVERY_RUN_ID
            run_dir.mkdir()
            journal_path = run_dir / "journal.json"
            journal_path.write_bytes(b"present")
            for label, journal, expected_error in variants:
                generic_receipt_read = mock.Mock(
                    side_effect=AssertionError("incident must not enter generic receipt recovery")
                )
                writes = mock.Mock(
                    side_effect=AssertionError("incident recovery must remain zero-write")
                )
                with self.subTest(label=label), mock.patch.object(
                    RELEASE, "RUNS_DIR", runs_dir
                ), mock.patch.object(
                    RELEASE, "_validate_inventory_directory"
                ), mock.patch.object(
                    RELEASE, "read_regular", return_value=canonical(journal)
                ), mock.patch.object(
                    RELEASE, "_read_receipt", generic_receipt_read
                ), mock.patch.object(
                    RELEASE, "_journal", writes
                ), mock.patch.object(
                    RELEASE, "_execute_legacy_rollback_transaction", writes
                ), self.assertRaisesRegex(
                    RELEASE.DeployError, expected_error
                ):
                    RELEASE._recover_interrupted_runs()
                generic_receipt_read.assert_not_called()
                writes.assert_not_called()

    def test_bootstrap_recovery_scope_and_control_collisions_fail_before_lock_or_write(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        lock = mock.Mock(side_effect=AssertionError("scope failure must happen before lock"))
        writer = mock.Mock()
        with mock.patch.object(RELEASE, "require_root"), mock.patch.object(
            RELEASE, "acquire_lock", lock
        ), mock.patch.object(RELEASE, "_journal", writer), self.assertRaisesRegex(
            RELEASE.DeployError, "RUN_NOT_AUTHORIZED"
        ):
            RELEASE.snapshot_bootstrap_recovery(
                Path("/recovery"),
                Path("/source"),
                RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
            )
        lock.assert_not_called()
        writer.assert_not_called()

        for label, kwargs, error in (
            ("permit", {"transition_permit_sha256": "bad"}, "AUTHORITY_DIGEST_INVALID"),
            ("receipt", {"bootstrap_prepare_receipt_sha256": "bad"}, "AUTHORITY_DIGEST_INVALID"),
            ("container", {"expected_current_flowise_container_id": "bad"}, "EXPECTED_CONTAINER_ID_INVALID"),
            ("label", {"expected_observed_runtime_config_hash": "bad"}, "EXPECTED_CONFIG_HASH_INVALID"),
            (
                "well-formed-other-permit",
                {"transition_permit_sha256": digest(b"other-permit")},
                "AUTHORITY_NOT_AUTHORIZED",
            ),
            (
                "well-formed-other-receipt",
                {"bootstrap_prepare_receipt_sha256": digest(b"other-prepare")},
                "AUTHORITY_NOT_AUTHORIZED",
            ),
            (
                "well-formed-other-container",
                {"expected_current_flowise_container_id": "a" * 64},
                "CONTAINER_NOT_AUTHORIZED",
            ),
            (
                "well-formed-other-label",
                {"expected_observed_runtime_config_hash": "b" * 64},
                "CONFIG_HASH_NOT_AUTHORIZED",
            ),
        ):
            arguments = {
                "run_id": RECOVERY_RUN_ID,
                "transition_permit_sha256": fixture["permit"].digest,
                "bootstrap_prepare_receipt_sha256": context["prepare_digest"],
                "expected_current_flowise_container_id": RECOVERY_FLOWISE_ID,
                "expected_observed_runtime_config_hash": OBSERVED_HARDENED_CONFIG_HASH,
                **kwargs,
            }
            with self.subTest(label=label), self.assertRaisesRegex(RELEASE.DeployError, error):
                RELEASE._validate_bootstrap_recovery_scope(**arguments)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ("bootstrap-complete-receipt.json", "bootstrap-rollback-receipt.json"):
                path = root / name
                path.write_bytes(b"occupied")
                with self.subTest(control=name), self.assertRaisesRegex(RELEASE.DeployError, "ALREADY_EXISTS"):
                    RELEASE._require_control_absent(path, "BOOTSTRAP_RECOVERY_CONTROL")

    def test_bootstrap_recovery_authority_constants_are_the_exact_observed_incident_facts(self):
        self.assertEqual(
            {
                "run_id": RELEASE.BOOTSTRAP_RECOVERY_RUN_ID,
                "source_release_id": RELEASE.BOOTSTRAP_RECOVERY_SOURCE_RELEASE_ID,
                "source_bundle_digest": RELEASE.BOOTSTRAP_RECOVERY_SOURCE_BUNDLE_DIGEST,
                "permit_digest": RELEASE.BOOTSTRAP_RECOVERY_PERMIT_DIGEST,
                "prepare_digest": RELEASE.BOOTSTRAP_RECOVERY_PREPARE_DIGEST,
                "flowise_container_id": RELEASE.BOOTSTRAP_RECOVERY_FLOWISE_CONTAINER_ID,
                "postgres_container_id": RELEASE.BOOTSTRAP_RECOVERY_POSTGRES_CONTAINER_ID,
                "nginx_container_id": RELEASE.BOOTSTRAP_RECOVERY_NGINX_CONTAINER_ID,
                "requested_config_hash": RELEASE.BOOTSTRAP_RECOVERY_REQUESTED_CONFIG_HASH,
                "observed_config_hash": RELEASE.BOOTSTRAP_RECOVERY_OBSERVED_CONFIG_HASH,
                "legacy_image_config_digest": RELEASE.BOOTSTRAP_RECOVERY_LEGACY_IMAGE_CONFIG_DIGEST,
                "seccomp_digest": RELEASE.BOOTSTRAP_RECOVERY_SECCOMP_CANONICAL_DIGEST,
                "full_runtime_projection_digest": (
                    RELEASE.BOOTSTRAP_RECOVERY_FULL_RUNTIME_PROJECTION_DIGEST
                ),
                "migration_count": RELEASE.BOOTSTRAP_RECOVERY_MIGRATION_COUNT,
                "migration_name_digest": RELEASE.BOOTSTRAP_RECOVERY_MIGRATION_NAME_DIGEST,
            },
            {
                "run_id": "20260728T171644Z-4914e862",
                "source_release_id": "git-56196c3cb4a3123f657614274a2227071920ba01",
                "source_bundle_digest": (
                    "sha256:61f511a2887afd75da2a2e2ab0bc94399c9c4af944a98920f4bb76c00a98c924"
                ),
                "permit_digest": (
                    "sha256:a8afbf9ca32ef4cc9ead605a81f8624db1cf5538e0a23cccb2e46a3b76f0ada3"
                ),
                "prepare_digest": (
                    "sha256:51402626a07b4b573e17b058e27a6e0df02dd7b34016df465f571ace949e6f2c"
                ),
                "flowise_container_id": (
                    "953d213d666de29fde0b99f4a908ca46e7d642f8bd3126235e8284f82d5e7e39"
                ),
                "postgres_container_id": (
                    "326fc99b16037b719a664b7ecbf9f6ee57f5b4d3cebf1395c65066319f514492"
                ),
                "nginx_container_id": (
                    "0a468dd7d2dd55b05c3804fb67eea62801c83bf431d8f8587ed431bbb4a1f0eb"
                ),
                "requested_config_hash": (
                    "8642827174f0ca74dd1a6fc5a8334f116eafe97f9386c1610d5719555e9d3200"
                ),
                "observed_config_hash": (
                    "d6f328312028f66b37193fa244ad57119afb6fc1df9360b67eb3856c9764fb86"
                ),
                "legacy_image_config_digest": (
                    "sha256:a8f38dca92292711a781432dc7700218273eececa331446d0678251cf6fe2067"
                ),
                "seccomp_digest": (
                    "sha256:8bc9daff33eb5909c662dad46e9600c6cdfcf4327e84e30b94395176738d27cf"
                ),
                "full_runtime_projection_digest": (
                    "sha256:41b684e72f394cb90b84c863a2732ea1b489ca646d1f37f1004becd575ccd874"
                ),
                "migration_count": 59,
                "migration_name_digest": (
                    "sha256:a30f16eb1af7cb810e97cd45df464e97255d9bc8a2d9aaabbac8787b4396b5b6"
                ),
            },
        )

    def test_bootstrap_recovery_run_topology_is_exact_no_follow_and_phase_aware(self):
        expected_directories = {
            "legacy",
            "legacy/docker",
            "legacy/docker/seccomp",
            "hardened_active",
            "hardened_active/docker",
            "hardened_active/docker/seccomp",
            "target_bundle",
            "target_bundle/docker",
            "target_bundle/docker/seccomp",
        }
        base_files = {
            "journal.json",
            "bootstrap-prepare-receipt.json",
            "legacy/.env.production",
            "legacy/docker-compose.prod.yml",
            "legacy/image.tar.gz",
            "hardened_active/.env.production",
            "hardened_active/docker-compose.prod.yml",
            "hardened_active/docker/seccomp/chromium.json",
            "target_bundle/.env.production",
            "target_bundle/docker-compose.prod.yml",
            "target_bundle/docker/seccomp/chromium.json",
        }
        run_dir = RELEASE.RUNS_DIR / RECOVERY_RUN_ID

        class Entry:
            def __init__(self, relative, kind="file", *, mode=None, nlink=1, size=1):
                self.path = str(run_dir / relative)
                self.relative = relative
                self.kind = kind
                self.mode = mode
                self.nlink = nlink
                self.size = size

            def stat(self, *, follow_symlinks):
                if follow_symlinks is not False:
                    raise AssertionError("topology enumeration must never follow symlinks")
                kind_mode = {
                    "directory": stat.S_IFDIR,
                    "file": stat.S_IFREG,
                    "symlink": stat.S_IFLNK,
                }[self.kind]
                default_mode = 0o700 if self.kind == "directory" else 0o600
                return types.SimpleNamespace(
                    st_mode=kind_mode | (default_mode if self.mode is None else self.mode),
                    st_uid=0,
                    st_gid=0,
                    st_nlink=self.nlink,
                    st_size=self.size,
                )

        def scanner(entries):
            by_parent = {}
            for entry in entries:
                by_parent.setdefault(str(Path(entry.path).parent), []).append(entry)
            return lambda parent: list(by_parent.get(str(parent), []))

        def entries(*, complete=False):
            result = [Entry(path, "directory") for path in expected_directories]
            result.extend(Entry(path) for path in base_files)
            if complete:
                result.append(Entry("bootstrap-complete-receipt.json"))
            return result

        with mock.patch.object(RELEASE, "_validate_secure_run_directory"), mock.patch.object(
            RELEASE.os,
            "scandir",
            side_effect=scanner(entries()),
        ):
            self.assertIs(
                RELEASE._validate_bootstrap_recovery_run_topology(
                    run_dir,
                    complete_receipt="absent",
                ),
                False,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "COMPLETE_RECEIPT_MISSING"):
                RELEASE._validate_bootstrap_recovery_run_topology(
                    run_dir,
                    complete_receipt="present",
                )

        with mock.patch.object(RELEASE, "_validate_secure_run_directory"), mock.patch.object(
            RELEASE.os,
            "scandir",
            side_effect=scanner(entries(complete=True)),
        ):
            self.assertIs(
                RELEASE._validate_bootstrap_recovery_run_topology(
                    run_dir,
                    complete_receipt="either",
                ),
                True,
            )
            with self.assertRaisesRegex(RELEASE.DeployError, "COMPLETE_RECEIPT_UNEXPECTED"):
                RELEASE._validate_bootstrap_recovery_run_topology(
                    run_dir,
                    complete_receipt="absent",
                )

        topology_variants = (
            (
                "symlink",
                entries() + [Entry("attacker", "symlink")],
                "TOPOLOGY_SYMLINK_FORBIDDEN",
            ),
            (
                "extra-file",
                entries() + [Entry("attacker.json")],
                "TOPOLOGY_FILE_SET_INVALID",
            ),
            (
                "missing-directory",
                [entry for entry in entries() if entry.relative != "target_bundle/docker/seccomp"],
                "TOPOLOGY_DIRECTORY_SET_INVALID",
            ),
            (
                "unsafe-file-mode",
                [
                    Entry(entry.relative, entry.kind, mode=0o644)
                    if entry.relative == "journal.json"
                    else entry
                    for entry in entries()
                ],
                "TOPOLOGY_FILE_METADATA_INVALID",
            ),
            (
                "hardlinked-file",
                [
                    Entry(entry.relative, entry.kind, nlink=2)
                    if entry.relative == "journal.json"
                    else entry
                    for entry in entries()
                ],
                "TOPOLOGY_FILE_METADATA_INVALID",
            ),
        )
        for label, variant_entries, expected_error in topology_variants:
            with self.subTest(label=label), mock.patch.object(
                RELEASE,
                "_validate_secure_run_directory",
            ), mock.patch.object(
                RELEASE.os,
                "scandir",
                side_effect=scanner(variant_entries),
            ), self.assertRaisesRegex(RELEASE.DeployError, expected_error):
                RELEASE._validate_bootstrap_recovery_run_topology(
                    run_dir,
                    complete_receipt="either",
                )

        with self.assertRaisesRegex(RELEASE.DeployError, "TOPOLOGY_PHASE_INVALID"):
            RELEASE._validate_bootstrap_recovery_run_topology(
                run_dir,
                complete_receipt="unknown",
            )

    def test_recovery_existing_lock_never_creates_or_follows_a_missing_lock(self):
        safe_temporary_parent = None
        for candidate in (Path(tempfile.gettempdir()), Path("/tmp")):
            try:
                resolved = candidate.resolve(strict=True)
                info = resolved.lstat()
            except OSError:
                continue
            mode = stat.S_IMODE(info.st_mode)
            if (
                stat.S_ISDIR(info.st_mode)
                and not stat.S_ISLNK(info.st_mode)
                and info.st_uid == 0
                and (not mode & 0o022 or mode & stat.S_ISVTX)
                and os.access(resolved, os.W_OK)
            ):
                safe_temporary_parent = resolved
                break
        self.assertIsNotNone(safe_temporary_parent, "no safe writable system temporary parent")

        with tempfile.TemporaryDirectory(
            dir=safe_temporary_parent,
            prefix="flowise-lock-portability-",
        ) as directory:
            lock_dir = Path(directory)
            base_dir = lock_dir / "production-root"
            base_dir.mkdir()
            lock_path = lock_dir / "flowise-production-release.lock"
            self.assertFalse(lock_path.is_relative_to(base_dir))
            creator = mock.Mock(side_effect=AssertionError("recovery must not create lock state"))
            with mock.patch.object(RELEASE, "BASE_DIR", base_dir), mock.patch.object(
                RELEASE,
                "LOCK_DIR",
                lock_dir,
            ), mock.patch.object(
                RELEASE,
                "LOCK_PATH",
                lock_path,
            ), mock.patch.object(
                RELEASE,
                "_validate_inventory_directory",
            ), mock.patch.object(
                RELEASE,
                "_ensure_lock_directory",
                creator,
            ), self.assertRaisesRegex(RELEASE.DeployError, "DEPLOY_EXISTING_LOCK_OPEN_FAILED"):
                RELEASE.acquire_existing_lock()
            self.assertFalse(lock_path.exists())
            creator.assert_not_called()

            target = lock_dir / "attacker-target"
            target.write_bytes(b"unchanged")
            lock_path.symlink_to(target)
            with mock.patch.object(RELEASE, "LOCK_DIR", lock_dir), mock.patch.object(
                RELEASE,
                "LOCK_PATH",
                lock_path,
            ), mock.patch.object(
                RELEASE,
                "_validate_inventory_directory",
            ), self.assertRaisesRegex(RELEASE.DeployError, "DEPLOY_EXISTING_LOCK_OPEN_FAILED"):
                RELEASE.acquire_existing_lock()
            self.assertEqual(target.read_bytes(), b"unchanged")

    def test_bootstrap_recovery_cli_requires_every_digest_id_hash_and_completion_cas(self):
        fixture = bootstrap_recovery_fixture()
        context = fixture["context"]
        common = [
            "--bundle-dir",
            "/recovery",
            "--source-bundle-dir",
            "/source",
            "--run-id",
            RECOVERY_RUN_ID,
            "--transition-permit",
            "/permit",
            "--transition-permit-sha256",
            fixture["permit"].digest,
            "--bootstrap-prepare-receipt-sha256",
            context["prepare_digest"],
            "--expected-current-flowise-container-id",
            RECOVERY_FLOWISE_ID,
            "--expected-observed-runtime-config-hash",
            OBSERVED_HARDENED_CONFIG_HASH,
        ]
        snapshot = RELEASE.parse_args(["snapshot-bootstrap-recovery", *common])
        self.assertEqual(snapshot.command, "snapshot-bootstrap-recovery")
        self.assertEqual(snapshot.run_id, RECOVERY_RUN_ID)
        self.assertEqual(snapshot.expected_current_flowise_container_id, RECOVERY_FLOWISE_ID)
        complete = RELEASE.parse_args(
            [
                "complete-bootstrap-recovery",
                *common,
                "--expected-recovery-snapshot-sha256",
                digest(b"snapshot"),
            ]
        )
        self.assertEqual(complete.expected_recovery_snapshot_sha256, digest(b"snapshot"))

        for label, command in (
            ("snapshot-missing-source", ["snapshot-bootstrap-recovery", *common[2:]]),
            ("complete-missing-cas", ["complete-bootstrap-recovery", *common]),
            (
                "malformed-container",
                [
                    "snapshot-bootstrap-recovery",
                    *common[:-3],
                    "bad",
                    *common[-2:],
                ],
            ),
            (
                "uppercase-label",
                ["snapshot-bootstrap-recovery", *common[:-1], OBSERVED_HARDENED_CONFIG_HASH.upper()],
            ),
        ):
            with self.subTest(label=label), mock.patch("sys.stderr", io.StringIO()), self.assertRaises(SystemExit):
                RELEASE.parse_args(command)

    def test_complete_bootstrap_recovery_writes_only_immutable_receipt_then_terminal_journal(self):
        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = fixture["context"]
        events = []
        receipts = []
        journals = []

        def write_receipt(path, document):
            events.append("receipt")
            receipts.append((Path(path), copy.deepcopy(document)))
            return digest(canonical(document))

        def write_journal(path, document):
            events.append("journal")
            journals.append((Path(path), copy.deepcopy(document)))

        def read_journal(_run_dir):
            if journals:
                document = journals[-1][1]
                data = canonical(document)
                return document, data, digest(data)
            return context["journal"], context["journal_data"], context["journal_pre_sha256"]

        def read_published_receipt(_run_id):
            document = receipts[-1][1]
            data = canonical(document)
            return context["run_dir"], document, data, digest(data)

        prohibited = {
            name: mock.Mock(side_effect=AssertionError(f"{name} is outside the recovery write set"))
            for name in (
                "install_config_set",
                "compose_recreate",
                "load_candidate",
                "atomic_write",
                "_execute_legacy_rollback_transaction",
            )
        }
        patches = (
            mock.patch.object(
                RELEASE,
                "_validate_bootstrap_recovery_run_topology",
                side_effect=recovery_topology_stub(lambda: bool(receipts)),
            ),
            mock.patch.object(
                RELEASE,
                "_read_canonical_run_journal",
                side_effect=read_journal,
            ),
            mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
            mock.patch.object(
                RELEASE,
                "_capture_stable_bootstrap_recovery",
                return_value=(observation, snapshot_digest),
            ),
            mock.patch.object(RELEASE, "_write_receipt", side_effect=write_receipt),
            mock.patch.object(
                RELEASE,
                "_read_existing_bootstrap_recovery_receipt",
                side_effect=read_published_receipt,
            ),
            mock.patch.object(RELEASE, "_journal", side_effect=write_journal),
            mock.patch.object(RELEASE, "utc_now", return_value="2026-07-28T17:30:00Z"),
            *(mock.patch.object(RELEASE, name, value) for name, value in prohibited.items()),
        )
        with PatchedLock(self), _MultiPatch(patches):
            result = RELEASE.complete_bootstrap_recovery(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
                snapshot_digest,
            )

        self.assertEqual(events, ["receipt", "journal"])
        self.assertEqual(len(receipts), 1)
        self.assertEqual(len(journals), 1)
        complete_receipt = receipts[0][1]
        terminal_journal = journals[0][1]
        self.assertEqual(complete_receipt["operation"], "bootstrap")
        self.assertEqual(complete_receipt["state"], "complete_hardened_baseline")
        self.assertEqual(complete_receipt["completion_mode"], RELEASE.BOOTSTRAP_RECOVERY_COMPLETION_MODE)
        self.assertEqual(complete_receipt["recovery"]["recovery_snapshot_sha256"], snapshot_digest)
        self.assertEqual(
            complete_receipt["recovery"]["runtime"]["current_flowise_container_id"],
            RECOVERY_FLOWISE_ID,
        )
        self.assertEqual(terminal_journal["state"], "complete_hardened_baseline")
        self.assertEqual(terminal_journal["phase"], "complete")
        self.assertEqual(
            terminal_journal["recovery_authority"],
            RELEASE._recovery_authority_from_receipt(complete_receipt),
        )
        self.assertIs(result["control_artifact_write"], True)
        self.assertIs(result["production_runtime_write"], False)
        self.assertIs(result["database_write"], False)
        self.assertIs(result["provider_call"], False)
        self.assertIs(result["secret_value_output"], False)
        self.assertEqual(result["current_flowise_container_id"], RECOVERY_FLOWISE_ID)
        self.assertEqual(result["requested_compose_config_hash"], REQUESTED_HARDENED_CONFIG_HASH)
        self.assertEqual(result["observed_runtime_config_hash"], OBSERVED_HARDENED_CONFIG_HASH)
        self.assertNotIn(fixture["sentinel"], canonical(result).decode())
        self.assertNotIn(fixture["sentinel"], canonical(complete_receipt).decode())
        for operation in prohibited.values():
            operation.assert_not_called()

        receipt_write = mock.Mock()
        journal_write = mock.Mock()
        with PatchedLock(self), _MultiPatch(
            (
                mock.patch.object(
                    RELEASE,
                    "_validate_bootstrap_recovery_run_topology",
                    side_effect=recovery_topology_stub(False),
                ),
                mock.patch.object(
                    RELEASE,
                    "_read_canonical_run_journal",
                    return_value=(context["journal"], context["journal_data"], context["journal_pre_sha256"]),
                ),
                mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                mock.patch.object(
                    RELEASE,
                    "_capture_stable_bootstrap_recovery",
                    return_value=(observation, snapshot_digest),
                ),
                mock.patch.object(RELEASE, "_write_receipt", receipt_write),
                mock.patch.object(RELEASE, "_journal", journal_write),
            )
        ), self.assertRaisesRegex(RELEASE.DeployError, "SNAPSHOT_DIGEST_MISMATCH"):
            RELEASE.complete_bootstrap_recovery(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
                digest(b"stale-snapshot"),
            )
        receipt_write.assert_not_called()
        journal_write.assert_not_called()

    def test_complete_bootstrap_recovery_resumes_receipt_written_journal_missing_without_rewrite(self):
        class JournalCrash(BaseException):
            pass

        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RECOVERY_RUN_ID
            run_dir.mkdir()
            context = copy.deepcopy(fixture["context"])
            context["run_dir"] = run_dir
            written = {}
            receipt_write_count = 0

            def publish(path, document):
                nonlocal receipt_write_count
                receipt_write_count += 1
                data = canonical(document)
                Path(path).write_bytes(data)
                os.chmod(path, 0o600)
                written.update({"receipt": copy.deepcopy(document), "data": data, "digest": digest(data)})
                return written["digest"]

            with PatchedLock(self), mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), _MultiPatch(
                (
                    mock.patch.object(
                        RELEASE,
                        "_validate_bootstrap_recovery_run_topology",
                        side_effect=recovery_topology_stub(lambda: bool(written)),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_canonical_run_journal",
                        return_value=(context["journal"], context["journal_data"], context["journal_pre_sha256"]),
                    ),
                    mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                    mock.patch.object(
                        RELEASE,
                        "_capture_stable_bootstrap_recovery",
                        return_value=(observation, snapshot_digest),
                    ),
                    mock.patch.object(RELEASE, "_write_receipt", side_effect=publish),
                    mock.patch.object(
                        RELEASE,
                        "_read_existing_bootstrap_recovery_receipt",
                        side_effect=lambda _run_id: (
                            run_dir,
                            written["receipt"],
                            written["data"],
                            written["digest"],
                        ),
                    ),
                    mock.patch.object(RELEASE, "_journal", side_effect=JournalCrash()),
                    mock.patch.object(RELEASE, "utc_now", return_value="2026-07-28T17:31:00Z"),
                    mock.patch.object(RELEASE, "install_config_set", side_effect=AssertionError("runtime write")),
                    mock.patch.object(RELEASE, "compose_recreate", side_effect=AssertionError("runtime write")),
                    mock.patch.object(RELEASE, "load_candidate", side_effect=AssertionError("image write")),
                )
            ), self.assertRaises(JournalCrash):
                RELEASE.complete_bootstrap_recovery(
                    Path("/recovery"),
                    Path("/source"),
                    RECOVERY_RUN_ID,
                    fixture["permit"].path,
                    fixture["permit"].digest,
                    context["prepare_digest"],
                    RECOVERY_FLOWISE_ID,
                    OBSERVED_HARDENED_CONFIG_HASH,
                    snapshot_digest,
                )
            self.assertEqual(receipt_write_count, 1)
            self.assertTrue((run_dir / "bootstrap-complete-receipt.json").is_file())
            context["complete_receipt_present"] = True

            repaired = []

            def read_repaired_journal(_run_dir):
                if repaired:
                    document = repaired[-1]
                    data = canonical(document)
                    return document, data, digest(data)
                return context["journal"], context["journal_data"], context["journal_pre_sha256"]

            with PatchedLock(self), mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), _MultiPatch(
                (
                    mock.patch.object(
                        RELEASE,
                        "_validate_bootstrap_recovery_run_topology",
                        side_effect=recovery_topology_stub(True),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_canonical_run_journal",
                        side_effect=read_repaired_journal,
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_existing_bootstrap_recovery_receipt",
                        return_value=(run_dir, written["receipt"], written["data"], written["digest"]),
                    ),
                    mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                    mock.patch.object(
                        RELEASE,
                        "_capture_stable_bootstrap_recovery",
                        return_value=(observation, snapshot_digest),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_write_receipt",
                        side_effect=AssertionError("immutable receipt must not be rewritten"),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_journal",
                        side_effect=lambda _root, value: repaired.append(copy.deepcopy(value)),
                    ),
                )
            ):
                result = RELEASE.complete_bootstrap_recovery(
                    Path("/recovery"),
                    Path("/source"),
                    RECOVERY_RUN_ID,
                    fixture["permit"].path,
                    fixture["permit"].digest,
                    context["prepare_digest"],
                    RECOVERY_FLOWISE_ID,
                    OBSERVED_HARDENED_CONFIG_HASH,
                    snapshot_digest,
                )
            self.assertEqual(receipt_write_count, 1)
            self.assertEqual(len(repaired), 1)
            self.assertIs(result["journal_repaired_after_receipt"], True)
            self.assertIs(result["idempotent_replay"], False)

    def test_complete_bootstrap_recovery_terminal_replay_is_zero_write_and_mismatch_never_overwrites(self):
        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = copy.deepcopy(fixture["context"])
        context["complete_receipt_present"] = True
        complete_receipt = RELEASE._build_bootstrap_recovery_complete_receipt(
            context,
            observation,
            snapshot_digest,
            "2026-07-28T17:32:00Z",
        )
        receipt_data = canonical(complete_receipt)
        receipt_digest = digest(receipt_data)
        terminal = copy.deepcopy(context["journal"])
        terminal.update(
            {
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "completion_mode": RELEASE.BOOTSTRAP_RECOVERY_COMPLETION_MODE,
                "bootstrap_complete_receipt_sha256": receipt_digest,
                "recovery_authority": RELEASE._recovery_authority_from_receipt(complete_receipt),
                "updated_at": "2026-07-28T17:32:01Z",
            }
        )
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RECOVERY_RUN_ID
            run_dir.mkdir()
            (run_dir / "bootstrap-complete-receipt.json").write_bytes(b"present")
            writer = mock.Mock()
            patches = (
                mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                mock.patch.object(
                    RELEASE,
                    "_validate_bootstrap_recovery_run_topology",
                    side_effect=recovery_topology_stub(True),
                ),
                mock.patch.object(
                    RELEASE,
                    "_read_canonical_run_journal",
                    return_value=(terminal, canonical(terminal), digest(canonical(terminal))),
                ),
                mock.patch.object(
                    RELEASE,
                    "_read_existing_bootstrap_recovery_receipt",
                    return_value=(run_dir, complete_receipt, receipt_data, receipt_digest),
                ),
                mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                mock.patch.object(
                    RELEASE,
                    "_capture_stable_bootstrap_recovery",
                    return_value=(observation, snapshot_digest),
                ),
                mock.patch.object(RELEASE, "_write_receipt", writer),
                mock.patch.object(RELEASE, "_journal", writer),
            )
            with PatchedLock(self), _MultiPatch(patches):
                result = RELEASE.complete_bootstrap_recovery(
                    Path("/recovery"),
                    Path("/source"),
                    RECOVERY_RUN_ID,
                    fixture["permit"].path,
                    fixture["permit"].digest,
                    context["prepare_digest"],
                    RECOVERY_FLOWISE_ID,
                    OBSERVED_HARDENED_CONFIG_HASH,
                    snapshot_digest,
                )
            writer.assert_not_called()
            self.assertIs(result["idempotent_replay"], True)
            self.assertIs(result["control_artifact_write"], False)
            self.assertIs(result["provider_call"], False)
            self.assertIs(result["secret_value_output"], False)

            for label, existing, terminal_value, error in (
                (
                    "receipt",
                    {**complete_receipt, "provider_call": True},
                    terminal,
                    "COMPLETE_RECEIPT_MISMATCH",
                ),
                (
                    "journal",
                    complete_receipt,
                    {**terminal, "recovery_authority": {"tampered": True}},
                    "TERMINAL_JOURNAL",
                ),
            ):
                existing_data = canonical(existing)
                writes = mock.Mock()
                with self.subTest(label=label), PatchedLock(self), _MultiPatch(
                    (
                        mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                        mock.patch.object(
                            RELEASE,
                            "_validate_bootstrap_recovery_run_topology",
                            side_effect=recovery_topology_stub(True),
                        ),
                        mock.patch.object(
                            RELEASE,
                            "_read_canonical_run_journal",
                            return_value=(terminal_value, canonical(terminal_value), digest(canonical(terminal_value))),
                        ),
                        mock.patch.object(
                            RELEASE,
                            "_read_existing_bootstrap_recovery_receipt",
                            return_value=(run_dir, existing, existing_data, digest(existing_data)),
                        ),
                        mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                        mock.patch.object(
                            RELEASE,
                            "_capture_stable_bootstrap_recovery",
                            return_value=(observation, snapshot_digest),
                        ),
                        mock.patch.object(RELEASE, "_write_receipt", writes),
                        mock.patch.object(RELEASE, "_journal", writes),
                    )
                ), self.assertRaisesRegex(RELEASE.DeployError, error):
                    RELEASE.complete_bootstrap_recovery(
                        Path("/recovery"),
                        Path("/source"),
                        RECOVERY_RUN_ID,
                        fixture["permit"].path,
                        fixture["permit"].digest,
                        context["prepare_digest"],
                        RECOVERY_FLOWISE_ID,
                        OBSERVED_HARDENED_CONFIG_HASH,
                        snapshot_digest,
                    )
                writes.assert_not_called()

    def test_complete_bootstrap_recovery_rechecks_receipt_and_terminal_journal_cas_before_write(self):
        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = copy.deepcopy(fixture["context"])
        context["complete_receipt_present"] = True
        complete_receipt = RELEASE._build_bootstrap_recovery_complete_receipt(
            context,
            observation,
            snapshot_digest,
            "2026-07-28T17:32:00Z",
        )
        receipt_data = canonical(complete_receipt)
        receipt_digest = digest(receipt_data)
        terminal = copy.deepcopy(context["journal"])
        terminal.update(
            {
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "completion_mode": RELEASE.BOOTSTRAP_RECOVERY_COMPLETION_MODE,
                "bootstrap_complete_receipt_sha256": receipt_digest,
                "recovery_authority": RELEASE._recovery_authority_from_receipt(complete_receipt),
                "updated_at": "2026-07-28T17:32:01Z",
            }
        )

        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RECOVERY_RUN_ID
            run_dir.mkdir()
            (run_dir / "bootstrap-complete-receipt.json").write_bytes(b"present")
            tampered_receipt = {**complete_receipt, "provider_call": True}
            tampered_receipt_data = canonical(tampered_receipt)
            writes = mock.Mock()
            with self.subTest(control="receipt"), PatchedLock(self), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                    mock.patch.object(
                        RELEASE,
                        "_validate_bootstrap_recovery_run_topology",
                        side_effect=recovery_topology_stub(True),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_canonical_run_journal",
                        return_value=(
                            context["journal"],
                            context["journal_data"],
                            context["journal_pre_sha256"],
                        ),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_existing_bootstrap_recovery_receipt",
                        side_effect=[
                            (run_dir, complete_receipt, receipt_data, receipt_digest),
                            (
                                run_dir,
                                tampered_receipt,
                                tampered_receipt_data,
                                digest(tampered_receipt_data),
                            ),
                        ],
                    ),
                    mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                    mock.patch.object(
                        RELEASE,
                        "_capture_stable_bootstrap_recovery",
                        return_value=(observation, snapshot_digest),
                    ),
                    mock.patch.object(RELEASE, "_write_receipt", writes),
                    mock.patch.object(RELEASE, "_journal", writes),
                )
            ), self.assertRaisesRegex(RELEASE.DeployError, "COMPLETE_RECEIPT_CAS_MISMATCH"):
                RELEASE.complete_bootstrap_recovery(
                    Path("/recovery"),
                    Path("/source"),
                    RECOVERY_RUN_ID,
                    fixture["permit"].path,
                    fixture["permit"].digest,
                    context["prepare_digest"],
                    RECOVERY_FLOWISE_ID,
                    OBSERVED_HARDENED_CONFIG_HASH,
                    snapshot_digest,
                )
            writes.assert_not_called()

            drifted_terminal = copy.deepcopy(terminal)
            drifted_terminal["updated_at"] = "2026-07-28T17:32:02Z"
            terminal_data = canonical(terminal)
            drifted_terminal_data = canonical(drifted_terminal)
            writes.reset_mock()
            with self.subTest(control="terminal-journal"), PatchedLock(self), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "RUNS_DIR", runs_dir),
                    mock.patch.object(
                        RELEASE,
                        "_validate_bootstrap_recovery_run_topology",
                        side_effect=recovery_topology_stub(True),
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_canonical_run_journal",
                        side_effect=[
                            (terminal, terminal_data, digest(terminal_data)),
                            (
                                drifted_terminal,
                                drifted_terminal_data,
                                digest(drifted_terminal_data),
                            ),
                        ],
                    ),
                    mock.patch.object(
                        RELEASE,
                        "_read_existing_bootstrap_recovery_receipt",
                        return_value=(run_dir, complete_receipt, receipt_data, receipt_digest),
                    ),
                    mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                    mock.patch.object(
                        RELEASE,
                        "_capture_stable_bootstrap_recovery",
                        return_value=(observation, snapshot_digest),
                    ),
                    mock.patch.object(RELEASE, "_write_receipt", writes),
                    mock.patch.object(RELEASE, "_journal", writes),
                )
            ), self.assertRaisesRegex(RELEASE.DeployError, "TERMINAL_JOURNAL_CAS_MISMATCH"):
                RELEASE.complete_bootstrap_recovery(
                    Path("/recovery"),
                    Path("/source"),
                    RECOVERY_RUN_ID,
                    fixture["permit"].path,
                    fixture["permit"].digest,
                    context["prepare_digest"],
                    RECOVERY_FLOWISE_ID,
                    OBSERVED_HARDENED_CONFIG_HASH,
                    snapshot_digest,
                )
            writes.assert_not_called()

    def test_bootstrap_recovery_terminal_journal_rechecks_preimage_before_its_only_write(self):
        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = fixture["context"]
        complete_receipt = RELEASE._build_bootstrap_recovery_complete_receipt(
            context,
            observation,
            snapshot_digest,
            "2026-07-28T17:32:00Z",
        )
        complete_digest = digest(canonical(complete_receipt))
        drifted = copy.deepcopy(context["journal"])
        drifted["updated_at"] = "2026-07-28T17:32:01Z"
        drifted_data = canonical(drifted)
        writes = mock.Mock(
            side_effect=AssertionError("journal preimage drift must remain zero-write")
        )
        with mock.patch.object(
            RELEASE,
            "_validate_bootstrap_recovery_run_topology",
            side_effect=recovery_topology_stub(True),
        ), mock.patch.object(
            RELEASE,
            "_read_canonical_run_journal",
            return_value=(drifted, drifted_data, digest(drifted_data)),
        ), mock.patch.object(
            RELEASE,
            "_journal",
            writes,
        ), self.assertRaisesRegex(
            RELEASE.DeployError,
            "JOURNAL_PREIMAGE_CAS_MISMATCH",
        ):
            RELEASE._complete_bootstrap_recovery_journal(
                context["run_dir"],
                context["journal"],
                complete_receipt,
                complete_digest,
            )
        writes.assert_not_called()

    def test_generic_terminal_recovery_rejects_consistently_tampered_receipt_and_journal(self):
        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = fixture["context"]
        complete_receipt = RELEASE._build_bootstrap_recovery_complete_receipt(
            context,
            observation,
            snapshot_digest,
            "2026-07-28T17:32:00Z",
        )
        authority_patches = (
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_SECCOMP_CANONICAL_DIGEST",
                TEST_SECCOMP_DIGEST,
            ),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_FULL_RUNTIME_PROJECTION_DIGEST",
                fixture["full_runtime_projection_digest"],
            ),
            mock.patch.object(RELEASE, "BOOTSTRAP_RECOVERY_POSTGRES_CONTAINER_ID", POSTGRES_ID),
            mock.patch.object(RELEASE, "BOOTSTRAP_RECOVERY_NGINX_CONTAINER_ID", NGINX_ID),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_MIGRATION_COUNT",
                fixture["prepare"]["baseline"]["database"]["migration_count"],
            ),
            mock.patch.object(
                RELEASE,
                "BOOTSTRAP_RECOVERY_MIGRATION_NAME_DIGEST",
                fixture["prepare"]["baseline"]["database"]["migration_name_sha256"],
            ),
        )
        with _MultiPatch(authority_patches):
            RELEASE._validate_bootstrap_recovery_terminal_receipt_authority(complete_receipt)

        tampered_receipt = copy.deepcopy(complete_receipt)
        other_requested_hash = "a" * 64
        tampered_receipt["hardened_active"]["compose_config_hash"] = other_requested_hash
        tampered_receipt["runtime"]["requested_compose_config_hash"] = other_requested_hash
        tampered_receipt["recovery"]["runtime"][
            "requested_compose_config_hash"
        ] = other_requested_hash
        tampered_receipt_data = canonical(tampered_receipt)
        tampered_receipt_digest = digest(tampered_receipt_data)
        terminal_journal = copy.deepcopy(context["journal"])
        terminal_journal.update(
            {
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "completion_mode": RELEASE.BOOTSTRAP_RECOVERY_COMPLETION_MODE,
                "bootstrap_complete_receipt_sha256": tampered_receipt_digest,
                "recovery_authority": RELEASE._recovery_authority_from_receipt(
                    tampered_receipt
                ),
                "updated_at": "2026-07-28T17:32:01Z",
            }
        )
        terminal_journal_data = canonical(terminal_journal)
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory)
            run_dir = runs_dir / RECOVERY_RUN_ID
            run_dir.mkdir()
            (run_dir / "journal.json").write_bytes(b"present")
            writes = mock.Mock(
                side_effect=AssertionError("tampered terminal authority must remain zero-write")
            )

            def read_control(path, **_kwargs):
                if Path(path).name == "journal.json":
                    return terminal_journal_data
                if Path(path).name == "bootstrap-complete-receipt.json":
                    return tampered_receipt_data
                raise AssertionError(f"unexpected control read: {Path(path).name}")

            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE,
                "_validate_inventory_directory",
            ), mock.patch.object(
                RELEASE,
                "_validate_bootstrap_recovery_run_topology",
                side_effect=recovery_topology_stub(True),
            ), mock.patch.object(
                RELEASE,
                "read_regular",
                side_effect=read_control,
            ), mock.patch.object(
                RELEASE,
                "_read_receipt",
                return_value=(run_dir, fixture["prepare"]),
            ), mock.patch.object(
                RELEASE,
                "_journal",
                writes,
            ), mock.patch.object(
                RELEASE,
                "_execute_legacy_rollback_transaction",
                writes,
            ), _MultiPatch(authority_patches), self.assertRaisesRegex(
                RELEASE.DeployError,
                "TERMINAL_ACTIVE_AUTHORITY_INVALID",
            ):
                RELEASE._recover_interrupted_runs()
            writes.assert_not_called()

    def test_recovery_receipt_publish_collision_and_control_roundtrip_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bootstrap-complete-receipt.json"
            original = b"pre-existing-immutable-receipt"
            path.write_bytes(original)
            with mock.patch.object(RELEASE.os, "fchown"), self.assertRaisesRegex(
                RELEASE.DeployError, "RECEIPT_ALREADY_EXISTS"
            ):
                RELEASE._write_receipt(path, {"schema_version": 1, "state": "replacement"})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(sorted(item.name for item in path.parent.iterdir()), [path.name])

        fixture = bootstrap_recovery_fixture()
        observation, snapshot_digest = self._capture_bootstrap_recovery_fixture(fixture)
        context = fixture["context"]
        journal_write = mock.Mock()
        with PatchedLock(self), _MultiPatch(
            (
                mock.patch.object(
                    RELEASE,
                    "_validate_bootstrap_recovery_run_topology",
                    side_effect=recovery_topology_stub(False),
                ),
                mock.patch.object(
                    RELEASE,
                    "_read_canonical_run_journal",
                    return_value=(context["journal"], context["journal_data"], context["journal_pre_sha256"]),
                ),
                mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                mock.patch.object(
                    RELEASE,
                    "_capture_stable_bootstrap_recovery",
                    return_value=(observation, snapshot_digest),
                ),
                mock.patch.object(RELEASE, "_write_receipt", return_value=digest(b"published")),
                mock.patch.object(
                    RELEASE,
                    "_read_existing_bootstrap_recovery_receipt",
                    return_value=(context["run_dir"], {"tampered": True}, canonical({"tampered": True}), digest(b"tampered")),
                ),
                mock.patch.object(RELEASE, "_journal", journal_write),
            )
        ), self.assertRaisesRegex(RELEASE.DeployError, "COMPLETE_RECEIPT_ROUNDTRIP_MISMATCH"):
            RELEASE.complete_bootstrap_recovery(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
                snapshot_digest,
            )
        journal_write.assert_not_called()

        published = []
        journals = []

        def receipt_write(_path, document):
            published.append(copy.deepcopy(document))
            return digest(canonical(document))

        def receipt_read(_run_id):
            document = published[-1]
            data = canonical(document)
            return context["run_dir"], document, data, digest(data)

        with PatchedLock(self), _MultiPatch(
            (
                mock.patch.object(
                    RELEASE,
                    "_validate_bootstrap_recovery_run_topology",
                    side_effect=recovery_topology_stub(lambda: bool(published)),
                ),
                mock.patch.object(
                    RELEASE,
                    "_read_canonical_run_journal",
                    return_value=(context["journal"], context["journal_data"], context["journal_pre_sha256"]),
                ),
                mock.patch.object(RELEASE, "_bootstrap_recovery_static_context", return_value=context),
                mock.patch.object(
                    RELEASE,
                    "_capture_stable_bootstrap_recovery",
                    return_value=(observation, snapshot_digest),
                ),
                mock.patch.object(RELEASE, "_write_receipt", side_effect=receipt_write),
                mock.patch.object(RELEASE, "_read_existing_bootstrap_recovery_receipt", side_effect=receipt_read),
                mock.patch.object(
                    RELEASE,
                    "_journal",
                    side_effect=lambda _root, value: journals.append(copy.deepcopy(value)),
                ),
                mock.patch.object(RELEASE, "utc_now", return_value="2026-07-28T17:33:00Z"),
            )
        ), self.assertRaisesRegex(RELEASE.DeployError, "TERMINAL_JOURNAL_ROUNDTRIP_MISMATCH"):
            RELEASE.complete_bootstrap_recovery(
                Path("/recovery"),
                Path("/source"),
                RECOVERY_RUN_ID,
                fixture["permit"].path,
                fixture["permit"].digest,
                context["prepare_digest"],
                RECOVERY_FLOWISE_ID,
                OBSERVED_HARDENED_CONFIG_HASH,
                snapshot_digest,
            )
        self.assertEqual(len(published), 1)
        self.assertEqual(len(journals), 1)

    def test_bootstrap_runtime_environment_is_exact_image_overlay_and_secret_safe_hmac(self):
        image_environment = {"NODE_OPTIONS": "--max-old-space-size=4096", "OVERRIDDEN": "image"}
        compose_environment = {**HARDENED_ENVIRONMENT, "OVERRIDDEN": "compose"}
        expected = RELEASE.expected_container_environment(image_environment, compose_environment)
        self.assertEqual(expected["OVERRIDDEN"], "compose")
        self.assertEqual(expected["NODE_OPTIONS"], "--max-old-space-size=4096")

        config, _ = resolved_compose()
        config["services"]["flowise"]["image"] = LEGACY_TAG
        runtime = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
        runtime[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"] = [
            f"{name}={value}" for name, value in sorted(expected.items())
        ]
        RELEASE.validate_bootstrap_hardened_runtime(
            runtime,
            image_tag=LEGACY_TAG,
            image_digest=LEGACY_DIGEST,
            expected_config_hash="4" * 64,
            expected_environment=expected,
            expected_compose=config,
            expected_network_identity=network_identity(),
        )
        for label, mutate in (
            ("extra", lambda entries: entries.append("UNEXPECTED_FLAG=true")),
            ("missing-image-env", lambda entries: entries.__setitem__(slice(None), [item for item in entries if not item.startswith("NODE_OPTIONS=")])),
        ):
            with self.subTest(label=label):
                drifted = copy.deepcopy(runtime)
                mutate(drifted[RELEASE.FLOWISE_CONTAINER]["Config"]["Env"])
                with self.assertRaisesRegex(RELEASE.DeployError, "FLOWISE_RUNTIME_ENVIRONMENT_MISMATCH"):
                    RELEASE.validate_bootstrap_hardened_runtime(
                        drifted,
                        image_tag=LEGACY_TAG,
                        image_digest=LEGACY_DIGEST,
                        expected_config_hash="4" * 64,
                        expected_environment=expected,
                        expected_compose=config,
                        expected_network_identity=network_identity(),
                    )
        duplicate = copy.deepcopy(runtime[RELEASE.FLOWISE_CONTAINER])
        duplicate["Config"]["Env"].append("NODE_OPTIONS=duplicate")
        with self.assertRaisesRegex(RELEASE.DeployError, "CONTAINER_ENVIRONMENT_DUPLICATE_KEY"):
            RELEASE._container_env(duplicate)

        secret = "receipt-must-never-contain-this-secret"
        secret_environment = {"FLOWISE_SECRETKEY_OVERWRITE": secret, "NODE_OPTIONS": "safe"}
        binding = RELEASE.runtime_environment_binding(secret_environment, TEST_KEY)
        self.assertEqual(binding["runtime_environment_keys"], sorted(secret_environment))
        self.assertNotIn(secret, canonical(binding).decode())
        wrong = {**binding, "runtime_environment_hmac_sha256": digest(b"wrong")}
        with self.assertRaises(RELEASE.DeployError) as raised:
            RELEASE._validate_runtime_environment_binding(wrong, secret_environment, TEST_KEY, "TEST")
        self.assertNotIn(secret, str(raised.exception))

    def test_legacy_rollback_classifier_accepts_only_six_authorized_file_states_before_write(self):
        prepared = bootstrap_prepare_receipt()
        observed = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        flowise = observed[RELEASE.FLOWISE_CONTAINER]
        flowise["Config"]["Labels"]["com.docker.compose.config-hash"] = prepared["hardened_active"]["compose_config_hash"]
        flowise["Config"]["Env"] = [f"{name}={value}" for name, value in sorted(HARDENED_ENVIRONMENT.items())]
        expected = {
            "legacy_config": {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}},
            "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
            "hardened_config": resolved_compose()[0],
            "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
        }
        expected["hardened_config"]["services"]["flowise"]["image"] = LEGACY_TAG
        snapshot = {"authorized": True}
        legal = {"LLL", "HLL", "HHL", "HHH", "LHH", "LLH"}

        def hashes_for(state):
            return {
                name: prepared["legacy" if token == "L" else "hardened_active"]["files"][name]
                for name, token in zip(("seccomp", "compose", "env"), state)
            }

        common = (
            mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=observed),
            mock.patch.object(RELEASE, "_validate_legacy_restore_sidecars", return_value=snapshot),
            mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
            mock.patch.object(RELEASE, "_hardened_runtime_stable_projection", return_value={"stable": True}),
            mock.patch.object(RELEASE, "_expected_hardened_runtime_stable_projection", return_value={"stable": True}),
            mock.patch.object(RELEASE, "validate_database_runtime_identity"),
            mock.patch.object(RELEASE, "validate_key_continuity"),
            mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
            mock.patch.object(RELEASE, "_legacy_rollback_complete", return_value=None),
        )
        for state in ("LLL", "LLH", "LHL", "LHH", "HLL", "HLH", "HHL", "HHH"):
            journal_write = mock.Mock()
            restore = mock.Mock(return_value={})
            with self.subTest(state=state), _MultiPatch(
                common
                + (
                    mock.patch.object(RELEASE, "_live_hashes", return_value=hashes_for(state)),
                    mock.patch.object(RELEASE, "_journal", journal_write),
                    mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
                )
            ):
                if state in legal:
                    RELEASE._execute_legacy_rollback_transaction(
                        Path("/run"),
                        prepared,
                        {"operation": "bootstrap", "run_id": RUN_ID},
                        TEST_KEY,
                        intent_phase="intent",
                        failure_phase="failed",
                        failure_code="FAILED",
                    )
                    journal_write.assert_called_once()
                    restore.assert_called_once()
                else:
                    with self.assertRaisesRegex(RELEASE.DeployError, "LIVE_FILE_STATE_UNAUTHORIZED"):
                        RELEASE._execute_legacy_rollback_transaction(
                            Path("/run"),
                            prepared,
                            {"operation": "bootstrap", "run_id": RUN_ID},
                            TEST_KEY,
                            intent_phase="intent",
                            failure_phase="failed",
                            failure_code="FAILED",
                        )
                    journal_write.assert_not_called()
                    restore.assert_not_called()

    def test_legacy_rollback_rejects_candidate_image_or_unknown_config_before_marker(self):
        prepared = bootstrap_prepare_receipt()
        expected = {
            "legacy_config": {},
            "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
            "hardened_config": {},
            "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
        }
        variants = []
        candidate_tag = documents(CANDIDATE_TAG, LEGACY_DIGEST, FLOWISE_ID)
        variants.append(("tag", candidate_tag))
        candidate_digest = documents(LEGACY_TAG, CANDIDATE_DIGEST, FLOWISE_ID)
        variants.append(("digest", candidate_digest))
        unknown_hash = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        unknown_hash[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"]["com.docker.compose.config-hash"] = "f" * 64
        variants.append(("config", unknown_hash))
        for label, observed in variants:
            marker = mock.Mock()
            restore = mock.Mock()
            with self.subTest(label=label), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=observed),
                    mock.patch.object(RELEASE, "_validate_legacy_restore_sidecars", return_value={}),
                    mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
                    mock.patch.object(RELEASE, "_journal", marker),
                    mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
                )
            ), self.assertRaises(RELEASE.DeployError):
                RELEASE._execute_legacy_rollback_transaction(
                    Path("/run"),
                    prepared,
                    {"operation": "bootstrap", "run_id": RUN_ID},
                    TEST_KEY,
                    intent_phase="intent",
                    failure_phase="failed",
                    failure_code="FAILED",
                )
            marker.assert_not_called()
            restore.assert_not_called()

    def test_ordered_legacy_file_restore_resumes_from_crash_without_invalid_state(self):
        class SimulatedCrash(BaseException):
            pass

        prepared = bootstrap_prepare_receipt()
        expected = {"legacy_env": b"legacy-env", "legacy_compose": b"legacy-compose"}
        state = list("HHH")
        remove_count = 0
        checkpoints = []

        def live_hashes():
            return {
                name: prepared["legacy" if token == "L" else "hardened_active"]["files"][name]
                for name, token in zip(("seccomp", "compose", "env"), state)
            }

        def remove_seccomp():
            nonlocal remove_count
            remove_count += 1
            state[0] = "L"

        def write(path, _data, *_args):
            if Path(path) == RELEASE.LIVE_COMPOSE:
                state[1] = "L"
            elif Path(path) == RELEASE.LIVE_ENV:
                state[2] = "L"

        def crash_after_first_step(_run_dir, journal):
            checkpoints.append(journal["rollback_step"])
            raise SimulatedCrash()

        journal = {"operation": "bootstrap", "run_id": RUN_ID}
        with _MultiPatch(
            (
                mock.patch.object(RELEASE, "_remove_live_seccomp", side_effect=remove_seccomp),
                mock.patch.object(RELEASE, "_live_hashes", side_effect=live_hashes),
                mock.patch.object(RELEASE, "atomic_write", side_effect=write),
                mock.patch.object(
                    RELEASE,
                    "sha256_file",
                    side_effect=lambda path: prepared["legacy"]["files"]["compose" if Path(path) == RELEASE.LIVE_COMPOSE else "env"],
                ),
                mock.patch.object(RELEASE, "_journal", side_effect=crash_after_first_step),
            )
        ), self.assertRaises(SimulatedCrash):
            RELEASE._install_legacy_files_from_state(Path("/run"), prepared, expected, "HHH", journal)
        self.assertEqual("".join(state), "LHH")
        self.assertEqual(checkpoints, ["LHH"])

        checkpoints.clear()
        with _MultiPatch(
            (
                mock.patch.object(RELEASE, "_remove_live_seccomp", side_effect=remove_seccomp),
                mock.patch.object(RELEASE, "_live_hashes", side_effect=live_hashes),
                mock.patch.object(RELEASE, "atomic_write", side_effect=write),
                mock.patch.object(
                    RELEASE,
                    "sha256_file",
                    side_effect=lambda path: prepared["legacy"]["files"]["compose" if Path(path) == RELEASE.LIVE_COMPOSE else "env"],
                ),
                mock.patch.object(RELEASE, "_journal", side_effect=lambda _root, value: checkpoints.append(value["rollback_step"])),
            )
        ):
            RELEASE._install_legacy_files_from_state(Path("/run"), prepared, expected, "".join(state), journal)
        self.assertEqual("".join(state), "LLL")
        self.assertEqual(checkpoints, ["LLH", "LLL"])
        self.assertEqual(remove_count, 1)

    def test_secure_role_chain_rejects_nested_symlink_and_staged_hardlink_before_mutation(self):
        prepared = bootstrap_prepare_receipt()
        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory) / "deployments"
            run_dir = runs_dir / RUN_ID
            (run_dir / "legacy/docker").mkdir(parents=True)
            reader = mock.Mock()
            writer = mock.Mock()
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(RELEASE, "_verify_staged_file", reader), mock.patch.object(
                RELEASE, "atomic_write", writer
            ), self.assertRaisesRegex(RELEASE.DeployError, "RUN_ROLE_SECCOMP_DIRECTORY_UNAVAILABLE"):
                RELEASE._load_staged(prepared, "legacy", run_dir)
            reader.assert_not_called()
            writer.assert_not_called()

        for role, prepared, operation in (
            ("rollback", receipt(), RELEASE._ensure_rollback_image),
            ("legacy", bootstrap_prepare_receipt(), RELEASE._verify_frozen_legacy_archive),
        ):
            with self.subTest(role=role), tempfile.TemporaryDirectory() as directory:
                runs_dir = Path(directory) / "deployments"
                run_dir = runs_dir / RUN_ID
                (run_dir / role / "docker").mkdir(parents=True)
                identity = mock.Mock()
                archive_contract = mock.Mock()
                inspect = mock.Mock()
                load = mock.Mock()
                with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                    RELEASE, "_validate_inventory_directory"
                ), mock.patch.object(RELEASE, "verify_regular_identity", identity), mock.patch.object(
                    RELEASE,
                    "verify_archive_contract" if role == "rollback" else "verify_legacy_archive_contract",
                    archive_contract,
                ), mock.patch.object(RELEASE, "inspect_image", inspect), mock.patch.object(
                    RELEASE, "load_candidate", load
                ), self.assertRaisesRegex(RELEASE.DeployError, "RUN_ROLE_SECCOMP_DIRECTORY_UNAVAILABLE"):
                    operation(run_dir, prepared)
                identity.assert_not_called()
                archive_contract.assert_not_called()
                inspect.assert_not_called()
                load.assert_not_called()

        for nested in ("docker", "docker/seccomp"):
            with self.subTest(nested=nested), tempfile.TemporaryDirectory() as directory:
                runs_dir = Path(directory) / "deployments"
                run_dir = runs_dir / RUN_ID
                role = run_dir / "legacy"
                role.mkdir(parents=True)
                target = Path(directory) / "attacker"
                target.mkdir()
                if nested == "docker/seccomp":
                    (role / "docker").mkdir()
                (role / nested).symlink_to(target, target_is_directory=True)
                reader = mock.Mock()
                writer = mock.Mock()
                with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                    RELEASE, "_validate_inventory_directory"
                ), mock.patch.object(RELEASE, "_verify_staged_file", reader), mock.patch.object(
                    RELEASE, "atomic_write", writer
                ), self.assertRaisesRegex(RELEASE.DeployError, "RUN_ROLE_.*_DIRECTORY_UNSAFE"):
                    RELEASE._load_staged(prepared, "legacy", run_dir)
                reader.assert_not_called()
                writer.assert_not_called()

        with tempfile.TemporaryDirectory() as directory:
            runs_dir = Path(directory) / "deployments"
            run_dir = runs_dir / RUN_ID
            role = run_dir / "legacy"
            (role / "docker/seccomp").mkdir(parents=True)
            env = role / ".env.production"
            env.write_bytes(b"legacy-env")
            os.link(env, role / "attacker-hardlink")
            (role / "docker-compose.prod.yml").write_bytes(b"legacy-compose")
            original_fstat = os.fstat

            def root_owned_stat(descriptor):
                value = original_fstat(descriptor)
                return types.SimpleNamespace(
                    st_mode=value.st_mode,
                    st_nlink=value.st_nlink,
                    st_uid=0,
                    st_gid=0,
                    st_size=value.st_size,
                    st_dev=value.st_dev,
                    st_ino=value.st_ino,
                    st_mtime_ns=value.st_mtime_ns,
                )

            writer = mock.Mock()
            with mock.patch.object(RELEASE, "RUNS_DIR", runs_dir), mock.patch.object(
                RELEASE, "_validate_inventory_directory"
            ), mock.patch.object(RELEASE.os, "fstat", side_effect=root_owned_stat), mock.patch.object(
                RELEASE, "atomic_write", writer
            ), self.assertRaisesRegex(RELEASE.DeployError, "FILE_UNSAFE_.env.production"):
                RELEASE._load_staged(prepared, "legacy", run_dir)
            writer.assert_not_called()

    def test_automatic_and_manual_mid_recreate_absence_survives_two_crashes_without_extra_recreate(self):
        class MidRecreateCrash(BaseException):
            pass

        for operation in ("bootstrap", "bootstrap-rollback"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                run_dir = Path(directory) / RUN_ID
                prepared = bootstrap_prepare_receipt()
                hardened = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
                hardened[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
                    "com.docker.compose.config-hash"
                ] = prepared["hardened_active"]["compose_config_hash"]
                restored = documents(LEGACY_TAG, LEGACY_DIGEST, "a" * 64)
                restored[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
                    "com.docker.compose.config-hash"
                ] = prepared["legacy"]["live_computed_config_hash"]
                prepared["legacy"]["runtime_projection_digest"] = RELEASE.runtime_projection_digest(restored)
                prepared["baseline"]["containers"] = RELEASE.container_snapshot(hardened)
                legacy_config = {
                    "services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}
                }
                hardened_config, _ = resolved_compose()
                hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
                expected = {
                    "legacy_env": b"legacy-env",
                    "legacy_compose": b"legacy-compose",
                    "legacy_config": legacy_config,
                    "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
                    "hardened_config": hardened_config,
                    "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
                }
                current = copy.deepcopy(hardened)
                file_state = list("HHH")
                recreate_count = 0
                persisted = []

                def inspect_recovery():
                    return copy.deepcopy(current)

                def live_hashes():
                    return {
                        name: prepared["legacy" if token == "L" else "hardened_active"]["files"][name]
                        for name, token in zip(("seccomp", "compose", "env"), file_state)
                    }

                def install(*_args, **_kwargs):
                    file_state[:] = list("LLL")

                def recreate():
                    nonlocal recreate_count, current
                    recreate_count += 1
                    current = {
                        RELEASE.POSTGRES_CONTAINER: copy.deepcopy(hardened[RELEASE.POSTGRES_CONTAINER]),
                        RELEASE.NGINX_CONTAINER: copy.deepcopy(hardened[RELEASE.NGINX_CONTAINER]),
                    }
                    if recreate_count <= 2:
                        raise MidRecreateCrash()
                    current = copy.deepcopy(restored)

                journal = {
                    "schema_version": 1,
                    "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                    "operation": operation,
                    "state": "in_progress",
                    "phase": "rollback_validated",
                    "run_id": RUN_ID,
                    "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
                }
                if operation == "bootstrap":
                    journal.update(
                        {
                            "permit_digest": prepared["permit"]["digest"],
                            "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                        }
                    )
                    intent_phase = "automatic_legacy_rollback_restoring"
                else:
                    journal["bootstrap_complete_receipt_sha256"] = digest(b"bootstrap-complete")
                    intent_phase = "manual_legacy_rollback_restoring"

                patches = (
                    mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", side_effect=inspect_recovery),
                    mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
                    mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                    mock.patch.object(RELEASE, "_live_hashes", side_effect=live_hashes),
                    mock.patch.object(
                        RELEASE,
                        "_journal",
                        side_effect=lambda _root, value: persisted.append(copy.deepcopy(value)),
                    ),
                    mock.patch.object(RELEASE, "_ensure_legacy_image"),
                    mock.patch.object(RELEASE, "_install_legacy_files_from_state", side_effect=install),
                    mock.patch.object(
                        RELEASE,
                        "_resolved_live",
                        return_value=(
                            legacy_config,
                            prepared["legacy"]["live_computed_config_hash"],
                            copy.deepcopy(LEGACY_ENVIRONMENT),
                        ),
                    ),
                    mock.patch.object(RELEASE, "compose_recreate", side_effect=recreate),
                    mock.patch.object(RELEASE, "inspect_containers", side_effect=lambda: copy.deepcopy(current)),
                    mock.patch.object(
                        RELEASE,
                        "validate_legacy_runtime",
                        return_value={"runtime_policy": "legacy_frozen_v1"},
                    ),
                    mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                    mock.patch.object(RELEASE, "validate_key_continuity"),
                    mock.patch.object(RELEASE, "runtime_pings"),
                )
                with _MultiPatch(patches):
                    for expected_count in (1, 2):
                        with self.assertRaises(MidRecreateCrash):
                            RELEASE._execute_legacy_rollback_transaction(
                                run_dir,
                                prepared,
                                journal,
                                TEST_KEY,
                                intent_phase=intent_phase,
                                failure_phase="failed",
                                failure_code="FAILED",
                            )
                        self.assertEqual(recreate_count, expected_count)
                        self.assertEqual(journal["phase"], "legacy_recreate_starting")
                        self.assertEqual(journal["rollback_step"], "legacy_recreate_starting")
                        marker = journal["flowise_absent_recovery"]
                        self.assertEqual(marker["origin"], "legacy_recreate_starting")
                        self.assertEqual(
                            marker["bootstrap_prepare_receipt_sha256"],
                            digest(b"bootstrap-prepare"),
                        )
                        self.assertEqual(
                            marker["pre_recreate_flowise_container_id"],
                            FLOWISE_ID,
                        )
                        if operation == "bootstrap-rollback":
                            self.assertEqual(
                                marker["bootstrap_complete_receipt_sha256"],
                                digest(b"bootstrap-complete"),
                            )
                    runtime = RELEASE._execute_legacy_rollback_transaction(
                        run_dir,
                        prepared,
                        journal,
                        TEST_KEY,
                        intent_phase=intent_phase,
                        failure_phase="failed",
                        failure_code="FAILED",
                    )
                    self.assertEqual(runtime["runtime_policy"], "legacy_frozen_v1")
                    self.assertEqual(recreate_count, 3)
                    # Simulate a caller crash before its terminal journal/receipt.
                    repeated = RELEASE._execute_legacy_rollback_transaction(
                        run_dir,
                        prepared,
                        journal,
                        TEST_KEY,
                        intent_phase=intent_phase,
                        failure_phase="failed",
                        failure_code="FAILED",
                    )
                self.assertEqual(repeated["runtime_policy"], "legacy_frozen_v1")
                self.assertEqual(recreate_count, 3)
                self.assertTrue(persisted)

    def test_checkpointed_recreate_new_id_failure_is_terminal_without_second_recreate(self):
        prepared = bootstrap_prepare_receipt()
        observed = documents(LEGACY_TAG, LEGACY_DIGEST, "9" * 64)
        observed[RELEASE.FLOWISE_CONTAINER]["Config"]["Labels"][
            "com.docker.compose.config-hash"
        ] = prepared["legacy"]["live_computed_config_hash"]
        prepared["legacy"]["runtime_projection_digest"] = RELEASE.runtime_projection_digest(observed)
        prepared["baseline"]["containers"] = RELEASE.container_snapshot(observed)
        expected = {
            "legacy_config": {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}},
            "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
            "hardened_config": {},
            "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
        }
        base_journal = {
            "schema_version": 1,
            "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap-rollback",
            "state": "rolling_back",
            "phase": "legacy_recreate_starting",
            "rollback_step": "legacy_recreate_starting",
            "run_id": RUN_ID,
            "permit_digest": prepared["permit"]["digest"],
            "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
            "target_bundle_release_id": prepared["target_bundle"]["release_id"],
            "active_legacy_release_id": prepared["legacy"]["release_id"],
            "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
            "bootstrap_complete_receipt_sha256": digest(b"bootstrap-complete"),
        }
        base_journal["flowise_absent_recovery"] = RELEASE._legacy_recreate_window_marker(
            base_journal,
            "legacy_recreate_starting",
            FLOWISE_ID,
        )

        for label, state, ping_error in (
            ("stopped", {"Status": "exited"}, None),
            ("unhealthy", {"Status": "running", "Health": {"Status": "unhealthy"}}, None),
            ("ping", {"Status": "running", "Health": {"Status": "healthy"}}, RELEASE.DeployError("PING_FAILED")),
        ):
            current = copy.deepcopy(observed)
            current[RELEASE.FLOWISE_CONTAINER]["State"] = state
            journal = copy.deepcopy(base_journal)
            recreate = mock.Mock()
            persisted = []
            patches = (
                mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=current),
                mock.patch.object(RELEASE, "_legacy_restore_expected_state", return_value=expected),
                mock.patch.object(RELEASE, "database_state", return_value=prepared["baseline"]["database"]),
                mock.patch.object(RELEASE, "_live_hashes", return_value=prepared["legacy"]["files"]),
                mock.patch.object(
                    RELEASE,
                    "validate_legacy_runtime",
                    return_value={"runtime_policy": "legacy_frozen_v1"},
                ),
                mock.patch.object(RELEASE, "validate_database_runtime_identity"),
                mock.patch.object(RELEASE, "validate_key_continuity"),
                mock.patch.object(RELEASE, "runtime_pings", side_effect=ping_error),
                mock.patch.object(RELEASE, "_restore_legacy_frozen", recreate),
                mock.patch.object(
                    RELEASE,
                    "_journal",
                    side_effect=lambda _root, value: persisted.append(copy.deepcopy(value)),
                ),
            )
            with self.subTest(label=label), _MultiPatch(patches), self.assertRaisesRegex(
                RELEASE.DeployError,
                "FAILED",
            ):
                RELEASE._execute_legacy_rollback_transaction(
                    Path("/run") / RUN_ID,
                    prepared,
                    journal,
                    TEST_KEY,
                    intent_phase="manual_legacy_rollback_restoring",
                    failure_phase="manual_legacy_rollback_failed",
                    failure_code="FAILED",
                )
            recreate.assert_not_called()
            self.assertEqual(journal["state"], "rollback_failed_manual_intervention_required")
            self.assertEqual(len(persisted), 1)

    def test_pre_recreate_old_id_and_invalid_marker_never_skip_or_repeat_unsafely(self):
        prepared = bootstrap_prepare_receipt()
        observed = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        classification = {
            "file_state": "LLL",
            "runtime_profile": "legacy",
            "runtime_config_hash": prepared["legacy"]["live_computed_config_hash"],
            "flowise_container_id": FLOWISE_ID,
            "snapshot": {},
            "expected": {},
        }
        journal = {
            "operation": "bootstrap",
            "state": "rolling_back",
            "phase": "legacy_recreate_starting",
            "rollback_step": "legacy_recreate_starting",
            "run_id": RUN_ID,
            "permit_digest": prepared["permit"]["digest"],
            "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
            "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
        }
        journal["flowise_absent_recovery"] = RELEASE._legacy_recreate_window_marker(
            journal,
            "legacy_recreate_starting",
            FLOWISE_ID,
        )
        restore = mock.Mock(return_value={"runtime_policy": "legacy_frozen_v1"})
        completion = mock.Mock(return_value={"runtime_policy": "legacy_frozen_v1"})
        with _MultiPatch(
            (
                mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=observed),
                mock.patch.object(RELEASE, "_classify_legacy_rollback_live_state", return_value=classification),
                mock.patch.object(RELEASE, "_legacy_rollback_complete", completion),
                mock.patch.object(RELEASE, "_journal"),
                mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
            )
        ):
            RELEASE._execute_legacy_rollback_transaction(
                Path("/run") / RUN_ID,
                prepared,
                journal,
                TEST_KEY,
                intent_phase="automatic_legacy_rollback_restoring",
                failure_phase="failed",
                failure_code="FAILED",
            )
        completion.assert_not_called()
        restore.assert_called_once()

        for label, marker in (("missing", None), ("corrupt", {"origin": "legacy_recreate_starting"})):
            invalid = copy.deepcopy(journal)
            invalid["state"] = "rolling_back"
            invalid["phase"] = "legacy_recreate_starting"
            invalid["rollback_step"] = "legacy_recreate_starting"
            if marker is None:
                invalid.pop("flowise_absent_recovery", None)
            else:
                invalid["flowise_absent_recovery"] = marker
            write = mock.Mock()
            restore = mock.Mock()
            with self.subTest(label=label), _MultiPatch(
                (
                    mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=observed),
                    mock.patch.object(RELEASE, "_classify_legacy_rollback_live_state", return_value=classification),
                    mock.patch.object(RELEASE, "_journal", write),
                    mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
                )
            ), self.assertRaisesRegex(
                RELEASE.DeployError,
                "(RESUME_PROGRESS_MISMATCH|RECREATE_WINDOW_MARKER_INVALID)",
            ):
                RELEASE._execute_legacy_rollback_transaction(
                    Path("/run") / RUN_ID,
                    prepared,
                    invalid,
                    TEST_KEY,
                    intent_phase="automatic_legacy_rollback_restoring",
                    failure_phase="failed",
                    failure_code="FAILED",
                )
            write.assert_not_called()
            restore.assert_not_called()

    def test_present_corrupt_recreate_marker_in_generic_or_file_phase_is_zero_write(self):
        prepared = bootstrap_prepare_receipt()
        observed = documents(LEGACY_TAG, LEGACY_DIGEST, FLOWISE_ID)
        base = {
            "operation": "bootstrap",
            "state": "rolling_back",
            "run_id": RUN_ID,
            "permit_digest": prepared["permit"]["digest"],
            "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
            "bootstrap_prepare_receipt_sha256": digest(b"bootstrap-prepare"),
        }
        exact_marker = RELEASE._legacy_recreate_window_marker(
            base,
            "legacy_recreate_starting",
            FLOWISE_ID,
        )
        corrupt_markers = {
            "missing-fields": {"origin": "legacy_recreate_starting"},
            "extra-field": {**exact_marker, "unexpected": "value"},
            "receipt-mismatch": {
                **exact_marker,
                "bootstrap_prepare_receipt_sha256": digest(b"other-prepare"),
            },
        }
        for phase in (
            "automatic_legacy_rollback_restoring",
            "legacy_rollback_files_restoring",
        ):
            for label, marker in corrupt_markers.items():
                journal = {
                    **base,
                    "phase": phase,
                    "rollback_step": "LLL",
                    "flowise_absent_recovery": copy.deepcopy(marker),
                }
                inspect = mock.Mock(return_value=observed)
                write = mock.Mock()
                restore = mock.Mock()
                with self.subTest(phase=phase, marker=label), _MultiPatch(
                    (
                        mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", inspect),
                        mock.patch.object(RELEASE, "_journal", write),
                        mock.patch.object(RELEASE, "_restore_legacy_frozen", restore),
                    )
                ), self.assertRaisesRegex(RELEASE.DeployError, "RECREATE_WINDOW_MARKER_INVALID"):
                    RELEASE._execute_legacy_rollback_transaction(
                        Path("/run") / RUN_ID,
                        prepared,
                        journal,
                        TEST_KEY,
                        intent_phase="automatic_legacy_rollback_restoring",
                        failure_phase="failed",
                        failure_code="FAILED",
                    )
                inspect.assert_not_called()
                write.assert_not_called()
                restore.assert_not_called()

    def test_manual_legacy_rollback_crash_after_recreate_resumes_without_second_recreate(self):
        class SimulatedCrash(BaseException):
            pass

        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory)
            prepared = bootstrap_prepare_receipt()
            prepare_digest = digest(b"bootstrap-prepare")
            complete_digest = digest(b"bootstrap-complete")
            hardened_config, _ = resolved_compose()
            hardened_config["services"]["flowise"]["image"] = LEGACY_TAG
            legacy_config = {"services": {"flowise": {"environment": copy.deepcopy(LEGACY_ENVIRONMENT)}}}
            hardened_snapshot = {"containers": "hardened"}
            legacy_snapshot = {"containers": "legacy"}
            complete = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "run_id": RUN_ID,
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle": prepared["target_bundle"],
                "hardened_active": prepared["hardened_active"],
                "runtime": {"containers": hardened_snapshot},
            }
            current_journal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "target_bundle_release_id": prepared["target_bundle"]["release_id"],
                "active_legacy_release_id": prepared["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "bootstrap_complete_receipt_sha256": complete_digest,
            }
            fresh = {
                "file_state": "HHH",
                "runtime_profile": "hardened",
                "runtime_config_hash": prepared["hardened_active"]["compose_config_hash"],
                "snapshot": hardened_snapshot,
                "expected": {
                    "hardened_config": hardened_config,
                    "hardened_environment": copy.deepcopy(HARDENED_ENVIRONMENT),
                },
            }
            restored = {
                "file_state": "LLL",
                "runtime_profile": "legacy",
                "runtime_config_hash": prepared["legacy"]["live_computed_config_hash"],
                "snapshot": legacy_snapshot,
                "expected": {
                    "legacy_config": legacy_config,
                    "legacy_environment": copy.deepcopy(LEGACY_ENVIRONMENT),
                },
            }
            runtime = {"containers": legacy_snapshot, "runtime_policy": "legacy_frozen_v1"}

            def read_receipt(_run_id, name, _expected_digest=None):
                return run_dir, prepared if name == "bootstrap-prepare" else complete

            def read_journal(_run_dir):
                return copy.deepcopy(current_journal)

            def persist_journal(_run_dir, document):
                current_journal.clear()
                current_journal.update(copy.deepcopy(document))

            def complete_recreate(*args, **_kwargs):
                rollback_journal = args[4]
                rollback_journal["state"] = "rolling_back"
                rollback_journal["phase"] = "legacy_recreate_starting"
                rollback_journal["rollback_step"] = "legacy_recreate_starting"
                rollback_journal["flowise_absent_recovery"] = RELEASE._legacy_recreate_window_marker(
                    rollback_journal,
                    "legacy_recreate_starting",
                    FLOWISE_ID,
                )
                persist_journal(run_dir, rollback_journal)
                return runtime

            recreate = mock.Mock(side_effect=complete_recreate)
            receipt_write = mock.Mock(side_effect=[SimulatedCrash(), digest(b"bootstrap-rollback")])
            classifications = mock.Mock(side_effect=[fresh, fresh, restored])
            completion = mock.Mock(return_value=runtime)
            recreated_documents = documents(LEGACY_TAG, LEGACY_DIGEST, "9" * 64)
            patches = (
                mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                mock.patch.object(RELEASE, "_read_run_journal", side_effect=read_journal),
                mock.patch.object(RELEASE, "current_journal_inventory", return_value={"present": False}),
                mock.patch.object(RELEASE, "persistent_key", return_value=TEST_KEY),
                mock.patch.object(RELEASE, "inspect_containers", return_value={}),
                mock.patch.object(RELEASE, "inspect_legacy_recovery_containers", return_value=recreated_documents),
                mock.patch.object(RELEASE, "_classify_legacy_rollback_live_state", side_effect=classifications),
                mock.patch.object(RELEASE, "_snapshot_matches_except_flowise_liveness", return_value=True),
                mock.patch.object(RELEASE, "_legacy_rollback_complete", side_effect=completion),
                mock.patch.object(RELEASE, "validate_container_health"),
                mock.patch.object(RELEASE, "validate_bootstrap_hardened_runtime"),
                mock.patch.object(RELEASE, "runtime_pings"),
                mock.patch.object(RELEASE, "_journal", side_effect=persist_journal),
                mock.patch.object(RELEASE, "_restore_legacy_frozen", recreate),
                mock.patch.object(RELEASE, "_write_receipt", side_effect=receipt_write),
            )
            with _MultiPatch(patches):
                with PatchedLock(self), self.assertRaises(SimulatedCrash):
                    RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
                self.assertEqual(current_journal["state"], "rolling_back")
                self.assertEqual(recreate.call_count, 1)
                with PatchedLock(self):
                    result = RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
            self.assertEqual(result["status"], "manual_legacy_rollback_complete")
            self.assertEqual(current_journal["state"], "manual_legacy_rollback_complete")
            self.assertEqual(recreate.call_count, 1)
            self.assertEqual(receipt_write.call_count, 2)

    def test_manual_legacy_rollback_resume_requires_same_receipt_pair_before_write(self):
        run_dir = Path("/run")
        prepared = bootstrap_prepare_receipt()
        prepare_digest = digest(b"bootstrap-prepare")
        complete_digest = digest(b"bootstrap-complete")
        complete = {
            "schema_version": 1,
            "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap",
            "state": "complete_hardened_baseline",
            "run_id": RUN_ID,
            "bootstrap_prepare_receipt_sha256": prepare_digest,
            "permit_digest": prepared["permit"]["digest"],
            "target_bundle": prepared["target_bundle"],
            "hardened_active": prepared["hardened_active"],
        }
        rolling = {
            "schema_version": 1,
            "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap-rollback",
            "state": "rolling_back",
            "phase": "manual_legacy_rollback_restoring",
            "rollback_step": "HHH",
            "run_id": RUN_ID,
            "permit_digest": prepared["permit"]["digest"],
            "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
            "target_bundle_release_id": prepared["target_bundle"]["release_id"],
            "active_legacy_release_id": prepared["legacy"]["release_id"],
            "bootstrap_prepare_receipt_sha256": digest(b"different-prepare"),
            "bootstrap_complete_receipt_sha256": complete_digest,
        }

        def read_receipt(_run_id, name, _expected_digest=None):
            return run_dir, prepared if name == "bootstrap-prepare" else complete

        inventory = mock.Mock()
        marker = mock.Mock()
        restore = mock.Mock()
        inspect_recovery = mock.Mock(return_value={})
        with PatchedLock(self), mock.patch.object(
            RELEASE, "_read_receipt", side_effect=read_receipt
        ), mock.patch.object(RELEASE, "_read_run_journal", return_value=rolling), mock.patch.object(
            RELEASE, "current_journal_inventory", inventory
        ), mock.patch.object(RELEASE, "_journal", marker), mock.patch.object(
            RELEASE, "_restore_legacy_frozen", restore
        ), mock.patch.object(
            RELEASE, "inspect_legacy_recovery_containers", inspect_recovery
        ), self.assertRaisesRegex(RELEASE.DeployError, "JOURNAL_BINDING_MISMATCH"):
            RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
        inventory.assert_not_called()
        marker.assert_not_called()
        restore.assert_not_called()
        inspect_recovery.assert_not_called()

    def test_fresh_bootstrap_rollback_requires_exact_terminal_journal_before_write(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / RUN_ID
            prepared = bootstrap_prepare_receipt()
            prepare_digest = digest(b"bootstrap-prepare")
            complete_digest = digest(b"bootstrap-complete")
            complete = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "run_id": RUN_ID,
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle": prepared["target_bundle"],
                "hardened_active": prepared["hardened_active"],
            }
            valid = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "target_bundle_release_id": prepared["target_bundle"]["release_id"],
                "active_legacy_release_id": prepared["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "bootstrap_complete_receipt_sha256": complete_digest,
            }

            def read_receipt(_run_id, name, _expected_digest=None):
                return run_dir, prepared if name == "bootstrap-prepare" else complete

            variants = {
                "schema": ("schema_version", 2),
                "policy": ("policy", {**RELEASE.LEGACY_BOOTSTRAP_POLICY, "mode": "drift"}),
                "phase": ("phase", "drift"),
                "prepare": ("bootstrap_prepare_receipt_sha256", digest(b"other-prepare")),
                "complete": ("bootstrap_complete_receipt_sha256", digest(b"other-complete")),
                "permit": ("permit_digest", digest(b"other-permit")),
                "bundle": ("target_bundle_digest", digest(b"other-bundle")),
                "release": ("target_bundle_release_id", "git-" + "f" * 40),
                "legacy": ("active_legacy_release_id", "git-" + "e" * 40),
            }
            for label, (field, value) in variants.items():
                drifted = copy.deepcopy(valid)
                drifted[field] = value
                inventory = mock.Mock()
                inspect = mock.Mock()
                write = mock.Mock()
                restore = mock.Mock()
                patches = (
                    mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                    mock.patch.object(RELEASE, "_read_run_journal", return_value=drifted),
                    mock.patch.object(RELEASE, "current_journal_inventory", inventory),
                    mock.patch.object(RELEASE, "inspect_containers", inspect),
                    mock.patch.object(RELEASE, "_journal", write),
                    mock.patch.object(RELEASE, "_execute_legacy_rollback_transaction", restore),
                )
                with self.subTest(label=label), PatchedLock(self), _MultiPatch(patches), self.assertRaises(
                    RELEASE.DeployError
                ):
                    RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
                inventory.assert_not_called()
                inspect.assert_not_called()
                write.assert_not_called()
                restore.assert_not_called()

    def test_public_bootstrap_rollback_allows_flowise_liveness_degradation(self):
        with tempfile.TemporaryDirectory() as directory:
            run_dir = Path(directory) / RUN_ID
            prepared = bootstrap_prepare_receipt()
            prepare_digest = digest(b"bootstrap-prepare")
            complete_digest = digest(b"bootstrap-complete")
            healthy = hardened_documents(LEGACY_TAG, LEGACY_DIGEST)
            healthy_snapshot = RELEASE.container_snapshot(healthy)
            complete = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "run_id": RUN_ID,
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle": prepared["target_bundle"],
                "hardened_active": prepared["hardened_active"],
                "runtime": {"containers": healthy_snapshot},
            }
            terminal = {
                "schema_version": 1,
                "policy": dict(RELEASE.LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap",
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "run_id": RUN_ID,
                "permit_digest": prepared["permit"]["digest"],
                "target_bundle_digest": prepared["target_bundle"]["bundle_digest"],
                "target_bundle_release_id": prepared["target_bundle"]["release_id"],
                "active_legacy_release_id": prepared["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "bootstrap_complete_receipt_sha256": complete_digest,
            }

            def read_receipt(_run_id, name, _expected_digest=None):
                return run_dir, prepared if name == "bootstrap-prepare" else complete

            for label, state in (
                ("stopped", {"Status": "exited"}),
                ("unhealthy", {"Status": "running", "Health": {"Status": "unhealthy"}}),
            ):
                before = copy.deepcopy(healthy)
                before[RELEASE.FLOWISE_CONTAINER]["State"] = state
                classification = {
                    "file_state": "HHH",
                    "runtime_profile": "hardened",
                    "runtime_config_hash": prepared["hardened_active"]["compose_config_hash"],
                    "flowise_container_id": FLOWISE_ID,
                    "snapshot": RELEASE.container_snapshot(before),
                    "expected": {},
                }
                restore = mock.Mock(return_value={"runtime_policy": "legacy_frozen_v1"})
                health = mock.Mock(side_effect=AssertionError("must not pre-block degraded recovery"))
                ping = mock.Mock(side_effect=AssertionError("must not pre-block degraded recovery"))
                patches = (
                    mock.patch.object(RELEASE, "_read_receipt", side_effect=read_receipt),
                    mock.patch.object(RELEASE, "_read_run_journal", return_value=copy.deepcopy(terminal)),
                    mock.patch.object(RELEASE, "current_journal_inventory", return_value={"present": False}),
                    mock.patch.object(RELEASE, "persistent_key", return_value=TEST_KEY),
                    mock.patch.object(RELEASE, "inspect_containers", return_value=before),
                    mock.patch.object(RELEASE, "_classify_legacy_rollback_live_state", return_value=classification),
                    mock.patch.object(RELEASE, "validate_container_health", health),
                    mock.patch.object(RELEASE, "runtime_pings", ping),
                    mock.patch.object(RELEASE, "_journal"),
                    mock.patch.object(RELEASE, "_execute_legacy_rollback_transaction", restore),
                    mock.patch.object(RELEASE, "_write_receipt", return_value=digest(b"rollback")),
                )
                with self.subTest(label=label), PatchedLock(self), _MultiPatch(patches):
                    result = RELEASE.bootstrap_rollback(RUN_ID, prepare_digest, complete_digest)
                self.assertEqual(result["status"], "manual_legacy_rollback_complete")
                restore.assert_called_once()
                health.assert_not_called()
                ping.assert_not_called()

    def test_rollback_archive_timeout_terminates_and_reaps_both_processes_and_removes_temp(self):
        class FakeStdout:
            def __init__(self):
                self.closed = False

            def close(self):
                self.closed = True

        class FakeProcess:
            def __init__(self, timeout_once=False):
                self.stdout = FakeStdout()
                self.timeout_once = timeout_once
                self.wait_count = 0
                self.terminated = False
                self.killed = False
                self.reaped = False

            def poll(self):
                return None if not self.reaped else 0

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.killed = True

            def wait(self, timeout=None):
                self.wait_count += 1
                if self.timeout_once and self.wait_count == 1:
                    raise subprocess.TimeoutExpired("gzip", timeout or 0)
                self.reaped = True
                return 0

        docker = FakeProcess()
        gzip_process = FakeProcess(timeout_once=True)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "rollback.tar.gz"
            with mock.patch.object(RELEASE.subprocess, "Popen", side_effect=[docker, gzip_process]), self.assertRaisesRegex(
                RELEASE.DeployError, "ROLLBACK_ARCHIVE_SAVE_TIMEOUT"
            ):
                RELEASE.save_rollback_archive(ROLLBACK_TAG, output)
            self.assertTrue(docker.terminated)
            self.assertTrue(gzip_process.terminated)
            self.assertTrue(docker.reaped)
            self.assertTrue(gzip_process.reaped)
            self.assertFalse(output.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])


class _MultiPatch:
    def __init__(self, patches):
        self.patches = list(patches)

    def __enter__(self):
        for patcher in self.patches:
            patcher.start()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        for patcher in reversed(self.patches):
            patcher.stop()


if __name__ == "__main__":
    unittest.main()
