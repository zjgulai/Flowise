#!/usr/bin/env python3
"""Fail-closed, manifest-bound production release wrapper for Flowise.

The wrapper deliberately has no third-party Python dependencies.  It promotes a
verified offline deployment bundle, freezes the current live release as the
rollback target during ``prepare``, and only ever recreates the ``flowise``
Compose service.  PostgreSQL and the reverse proxy are observed, never managed.
"""

from __future__ import annotations

import argparse
import copy
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import tarfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


BASE_DIR = Path("/opt/flowise")
LIVE_ENV = BASE_DIR / ".env.production"
LIVE_COMPOSE = BASE_DIR / "docker-compose.prod.yml"
LIVE_SECCOMP = BASE_DIR / "docker/seccomp/chromium.json"
RUNS_DIR = BASE_DIR / "deployments"
LEGACY_RELEASES_DIR = BASE_DIR / "releases"
TRANSITION_PERMITS_DIR = BASE_DIR / "transition-permits"
LOCK_DIR = Path("/run/lock/flowise-production-release")
LOCK_PATH = LOCK_DIR / "deploy.lock"
PERSISTENT_KEY = Path("/var/lib/docker/volumes/flowise_flowise_data/_data/encryption.key")

FLOWISE_CONTAINER = "flowise-chinese"
POSTGRES_CONTAINER = "flowise-postgres"
NGINX_CONTAINER = "ai_video_nginx"
MANAGED_CONTAINERS = (FLOWISE_CONTAINER, POSTGRES_CONTAINER, NGINX_CONTAINER)
PUBLIC_ORIGIN = "https://flowise.lute-tlz-dddd.top"
PRIVATE_PING = "http://172.20.0.1:3000/api/v1/ping"
SCRIPT_PATH = Path(__file__).resolve()

SAFE_ENV = {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "HOME": "/root",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "DOCKER_HOST": "unix:///var/run/docker.sock",
}

DIGEST_RE = re.compile(r"sha256:[0-9a-f]{64}\Z")
REVISION_RE = re.compile(r"[0-9a-f]{40}\Z")
RUN_ID_RE = re.compile(r"[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}\Z")
CONFIG_HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
DOCKER_ID_RE = re.compile(r"[0-9a-f]{64}\Z")
ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
LEGACY_BOOTSTRAP_REVISION = "c947339b7033c930be37591918f59c7725800bbe"
LEGACY_BOOTSTRAP_REPOSITORY_URLS = (
    "https://github.com/zjgulai/Flowise",
    "https://github.com/zjgulai/Flowise.git",
)

EXPECTED_BUNDLE_FILES = {
    "image_archive": "image.tar.gz",
    "release_manifest": "release-manifest.json",
    "release_evidence": "evidence.txt",
    "production_compose": "docker-compose.prod.yml",
    "chromium_seccomp": "docker/seccomp/chromium.json",
    "production_wrapper": "scripts/flowise-production-release.py",
}
EXPECTED_BOUNDARIES = {
    "production_write": False,
    "registry_push": False,
    "provider_call": False,
    "secrets_read": False,
}
EXPECTED_TOOLCHAIN = {"node": "v24.18.0", "package_manager": "pnpm@10.26.0", "pnpm": "10.26.0"}
EXPECTED_BUILDX_VERSION = "v0.34.1"
EXPECTED_BUILDKIT_VERSION = "v0.30.0"
EXPECTED_MANIFEST_INPUTS = (
    ".npmrc",
    ".nvmrc",
    "Dockerfile",
    "docker-compose.prod.yml",
    "docker/seccomp/chromium.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/deployment-bundle.mjs",
    "scripts/flowise-production-release.py",
    "scripts/publish-verified-image.sh",
    "scripts/release-manifest.mjs",
    "scripts/verify-chromium-sandbox.sh",
    "scripts/verify-release-candidate.sh",
    "scripts/verify-release-source.sh",
    "scripts/verify-security.sh",
)
EXPECTED_EVIDENCE_KEYS = (
    "source",
    "revision",
    "image_tag",
    "store_identity",
    "image_config_digest",
    "platform",
    "buildx_version",
    "buildkit_version",
    "archive_bytes",
    "archive_sha256",
    "manifest_sha256",
    "isolated_smoke",
    "chromium_profile_sha256",
    "production_compose_sha256",
    "production_wrapper_sha256",
    "chromium_sandbox",
    "raw_chromium_sandbox",
    "playwright_sandbox",
    "puppeteer_sandbox",
    "clone3_namespace",
    "unsafe_chromium_flags",
    "registry_push",
)
EXPECTED_FLOWISE_SERVICE_KEYS = {
    "cap_drop",
    "command",
    "container_name",
    "depends_on",
    "deploy",
    "entrypoint",
    "environment",
    "healthcheck",
    "image",
    "init",
    "logging",
    "networks",
    "pids_limit",
    "ports",
    "read_only",
    "restart",
    "security_opt",
    "tmpfs",
    "user",
    "volumes",
}
EXPECTED_TMPFS = (
    "/tmp:rw,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=1777",
    "/dev/shm:rw,nosuid,nodev,noexec,size=256m,uid=1000,gid=1000,mode=1777",
    "/usr/src/flowise/packages/server/logs:rw,nosuid,nodev,size=32m,uid=1000,gid=1000,mode=0700",
)
EXPECTED_TMPFS_BY_PATH = {item.split(":", 1)[0]: item.split(":", 1)[1] for item in EXPECTED_TMPFS}
EXPECTED_RUNTIME_LOG_CONFIG = {
    "Type": "json-file",
    "Config": {"labels": "service_name,environment", "max-file": "3", "max-size": "10m"},
}
EXPECTED_RUNTIME_HEALTHCHECK = {
    "Test": ["CMD", "curl", "-fsS", "http://localhost:3000/api/v1/ping"],
    "Interval": 30_000_000_000,
    "Timeout": 10_000_000_000,
    "Retries": 3,
    "StartPeriod": 60_000_000_000,
}
EXPECTED_FLOWISE_DEPLOY = {
    "resources": {
        "limits": {"cpus": 2, "memory": "4294967296", "pids": 512},
        "reservations": {"cpus": 1, "memory": "2147483648"},
    },
    "placement": {},
}
EXPECTED_FLOWISE_HEALTHCHECK = {
    "test": ["CMD", "curl", "-fsS", "http://localhost:3000/api/v1/ping"],
    "timeout": "10s",
    "interval": "30s",
    "retries": 3,
    "start_period": "1m0s",
}
EXPECTED_FLOWISE_LOGGING = {
    "driver": "json-file",
    "options": {"labels": "service_name,environment", "max-file": "3", "max-size": "10m"},
}
EXPECTED_TOP_LEVEL_VOLUMES = {
    "flowise_data": {"name": "flowise_flowise_data", "driver": "local"},
    "postgres_data": {"name": "flowise_postgres_data", "driver": "local"},
}
EXPECTED_TOP_LEVEL_NETWORKS = {
    "flowise_network": {
        "name": "flowise_flowise_network",
        "driver": "bridge",
        "ipam": {"config": [{"subnet": "172.28.0.0/16"}]},
    },
    "reverse_proxy_network": {"name": "lighthouse_ai_video_net", "ipam": {}, "external": True},
}
EXPECTED_DATABASE_ENVIRONMENT_KEYS = {
    "DATABASE_TYPE",
    "DATABASE_HOST",
    "DATABASE_PORT",
    "DATABASE_NAME",
    "DATABASE_USER",
    "DATABASE_PASSWORD",
    "DATABASE_PATH",
    "DATABASE_SSL",
    "DATABASE_REJECT_UNAUTHORIZED",
}
ROLLBACK_ATTEMPTED_STATE = "rollback_attempted_manual_confirmation_required"
LEGACY_BOOTSTRAP_POLICY = {
    "mode": "legacy_c947_to_hardened_c947_v1",
    "rollback": "legacy_frozen_v1",
    "runtime_config_hash": "permit_bound_label_vs_live_computed_v1",
}
RECEIPT_POLICY_BY_NAME = {
    "bootstrap-prepare": LEGACY_BOOTSTRAP_POLICY,
    "bootstrap-complete": LEGACY_BOOTSTRAP_POLICY,
    "bootstrap-rollback": LEGACY_BOOTSTRAP_POLICY,
}
CURRENT_CONTROL_BASENAMES = {
    "journal.json",
    "prepare-receipt.json",
    "cutover-receipt.json",
    "rollback-receipt.json",
    "bootstrap-prepare-receipt.json",
    "bootstrap-complete-receipt.json",
    "bootstrap-rollback-receipt.json",
}
CURRENT_TERMINAL_STATES = {
    "prepared",
    "complete_candidate_active",
    "manual_rollback_complete",
    "failed",
    "failed_before_live_write",
    "rolled_back",
    "interrupted_prepare_aborted",
    "interrupted_run_recovered_to_rollback",
    "prepared_legacy_frozen",
    "complete_hardened_baseline",
    "bootstrap_rolled_back_legacy",
    "bootstrap_failed_before_live_write",
    "interrupted_bootstrap_before_live_write",
    "interrupted_bootstrap_recovered_to_legacy",
    "manual_legacy_rollback_complete",
}
CURRENT_UNRESOLVED_STATES = {
    "in_progress",
    "rolling_back",
    ROLLBACK_ATTEMPTED_STATE,
    "rollback_failed_manual_intervention_required",
}
CURRENT_RECEIPT_CONTRACTS = {
    "prepare-receipt.json": ("prepare", "prepared"),
    "cutover-receipt.json": ("cutover", "complete_candidate_active"),
    "rollback-receipt.json": ("rollback", "manual_rollback_complete"),
    "bootstrap-prepare-receipt.json": ("bootstrap", "prepared_legacy_frozen"),
    "bootstrap-complete-receipt.json": ("bootstrap", "complete_hardened_baseline"),
    "bootstrap-rollback-receipt.json": ("bootstrap-rollback", "manual_legacy_rollback_complete"),
}
CURRENT_JOURNAL_STATES_BY_OPERATION = {
    "prepare": {"in_progress", "prepared", "failed", "interrupted_prepare_aborted"},
    "cutover": {
        "in_progress",
        "complete_candidate_active",
        "failed_before_live_write",
        "rolled_back",
        "interrupted_run_recovered_to_rollback",
        ROLLBACK_ATTEMPTED_STATE,
        "rolling_back",
        "rollback_failed_manual_intervention_required",
    },
    "rollback": {
        "in_progress",
        "manual_rollback_complete",
        ROLLBACK_ATTEMPTED_STATE,
        "rolling_back",
        "rollback_failed_manual_intervention_required",
    },
    "bootstrap": {
        "in_progress",
        "complete_hardened_baseline",
        "bootstrap_rolled_back_legacy",
        "bootstrap_failed_before_live_write",
        "interrupted_bootstrap_before_live_write",
        "interrupted_bootstrap_recovered_to_legacy",
        ROLLBACK_ATTEMPTED_STATE,
        "rolling_back",
        "rollback_failed_manual_intervention_required",
    },
    "bootstrap-rollback": {
        "in_progress",
        "manual_legacy_rollback_complete",
        ROLLBACK_ATTEMPTED_STATE,
        "rolling_back",
        "rollback_failed_manual_intervention_required",
    },
}
LEGACY_FIXED_CONTROL_BASENAMES = {
    "prepare-status.json",
    "cutover-status.json",
    "compose-cutover-status.json",
    "candidate-manifest-attempt.json",
}
LEGACY_CONTROL_KEYS = {
    "candidate-manifest-attempt.json": {
        "boundaries",
        "created_at",
        "image",
        "inputs",
        "release_id",
        "schema_version",
        "source",
        "toolchain",
    },
    "compose-cutover-status.json": {
        "candidate_compose_sha256",
        "live_compose_sha256",
        "phase",
        "production_write",
        "provider_call",
        "release_id",
        "rollback_compose_sha256",
        "run_id",
        "state",
        "updated_at",
    },
    "cutover-status.json": {
        "after",
        "before",
        "database_before",
        "effects",
        "key_continuity",
        "migration_up_executed",
        "migrations_unchanged",
        "operator_database_write",
        "phase",
        "production_database_write",
        "provider_call",
        "release_id",
        "run_id",
        "state",
        "updated_at",
    },
    "post-acceptance-rollback": {
        "after",
        "before",
        "migration_up_executed",
        "migrations_unchanged",
        "operator_database_write",
        "production_database_write",
        "provider_call",
        "run_id",
        "state",
        "updated_at",
    },
}
LEGACY_PREPARE_KEYS_BY_STATE_PHASE = {
    ("prepared", "prepared_cutover_ready"): {
        "after",
        "artifacts",
        "before",
        "candidate_image_id",
        "candidate_smoke",
        "container_recreated",
        "database",
        "key_continuity",
        "phase",
        "production_database_write",
        "provider_call",
        "release_id",
        "rollback_smoke",
        "run_id",
        "state",
        "updated_at",
    },
    ("failed", "candidate_loaded"): {
        "artifacts",
        "before",
        "candidate_image_id",
        "database",
        "error",
        "phase",
        "release_id",
        "run_id",
        "state",
        "updated_at",
    },
    ("failed", "validated_pre_load"): {
        "artifacts",
        "before",
        "database",
        "error",
        "phase",
        "release_id",
        "run_id",
        "state",
        "updated_at",
    },
    ("failed", "initialized"): {
        "error",
        "phase",
        "release_id",
        "run_id",
        "state",
        "updated_at",
    },
}


class DeployError(RuntimeError):
    """A sanitized, operator-actionable release failure."""


@dataclass(frozen=True)
class Bundle:
    root: Path
    document: dict[str, Any]
    manifest: dict[str, Any]
    files: dict[str, Path]
    file_entries: dict[str, dict[str, Any]]
    release_id: str
    revision: str
    image_tag: str
    image_config_digest: str
    bundle_digest: str


@dataclass(frozen=True)
class TransitionPermit:
    path: Path
    document: dict[str, Any]
    digest: str


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def canonical_json(document: Any) -> bytes:
    return (json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha256_bytes(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def verify_regular_identity(
    path: Path,
    *,
    expected_bytes: int,
    expected_digest: str,
    expected_uid: int = 0,
    expected_gid: int = 0,
    expected_mode: int = 0o600,
    expected_nlink: int = 1,
) -> None:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise DeployError(f"FILE_UNAVAILABLE_{path.name}") from error
    try:
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != expected_nlink
            or before.st_uid != expected_uid
            or before.st_gid != expected_gid
            or stat.S_IMODE(before.st_mode) != expected_mode
            or before.st_size != expected_bytes
        ):
            raise DeployError(f"FILE_METADATA_MISMATCH_{path.name}")
        digest = hashlib.sha256()
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise DeployError(f"FILE_CHANGED_WHILE_HASHED_{path.name}")
        if "sha256:" + digest.hexdigest() != expected_digest:
            raise DeployError(f"FILE_DIGEST_MISMATCH_{path.name}")
    finally:
        os.close(descriptor)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DeployError("JSON_DUPLICATE_KEY")
        result[key] = value
    return result


def parse_canonical_json(data: bytes, label: str) -> dict[str, Any]:
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeployError(f"{label}_JSON_INVALID") from error
    if not isinstance(document, dict) or canonical_json(document) != data:
        raise DeployError(f"{label}_JSON_NOT_CANONICAL")
    return document


def exact_keys(document: Any, keys: Iterable[str], label: str) -> None:
    if not isinstance(document, dict) or set(document) != set(keys):
        raise DeployError(f"{label}_FIELDS_INVALID")


def _policy_copy(policy: dict[str, str]) -> dict[str, str]:
    return dict(policy)


def _validate_policy(document: Any, expected: dict[str, str], label: str) -> None:
    exact_keys(document, expected, f"{label}_POLICY")
    if document != expected:
        raise DeployError(f"{label}_POLICY_INVALID")


def _validate_receipt_policy(document: dict[str, Any], name: str) -> None:
    expected = RECEIPT_POLICY_BY_NAME.get(name)
    if expected is None:
        raise DeployError("RECEIPT_POLICY_NAME_INVALID")
    _validate_policy(document.get("policy"), expected, name.upper().replace("-", "_"))


def _validate_network_identity_binding(value: Any, label: str) -> dict[str, dict[str, str]]:
    exact_keys(value, ("flowise_internal", "reverse_proxy"), label)
    if not isinstance(value, dict):
        raise DeployError(f"{label}_FIELDS_INVALID")
    expected_names = {
        "flowise_internal": EXPECTED_TOP_LEVEL_NETWORKS["flowise_network"]["name"],
        "reverse_proxy": EXPECTED_TOP_LEVEL_NETWORKS["reverse_proxy_network"]["name"],
    }
    normalized: dict[str, dict[str, str]] = {}
    for role, expected_name in expected_names.items():
        item = value.get(role)
        exact_keys(item, ("name", "network_id"), f"{label}_{role.upper()}")
        if not isinstance(item, dict):
            raise DeployError(f"{label}_{role.upper()}_FIELDS_INVALID")
        name = item.get("name")
        network_id = item.get("network_id")
        if name != expected_name or not isinstance(network_id, str) or not DOCKER_ID_RE.fullmatch(network_id):
            raise DeployError(f"{label}_{role.upper()}_INVALID")
        normalized[role] = {"name": expected_name, "network_id": network_id}
    if normalized["flowise_internal"]["network_id"] == normalized["reverse_proxy"]["network_id"]:
        raise DeployError(f"{label}_NETWORK_IDS_NOT_DISTINCT")
    return normalized


def require_root() -> None:
    if os.geteuid() != 0:
        raise DeployError("ROOT_REQUIRED")


def _safe_relative_path(root: Path, relative: str) -> Path:
    if (
        not isinstance(relative, str)
        or not relative
        or relative.startswith("/")
        or "\\" in relative
        or "\x00" in relative
        or Path(relative).parts != tuple(part for part in relative.split("/") if part)
        or any(part in (".", "..") for part in Path(relative).parts)
    ):
        raise DeployError("BUNDLE_PATH_INVALID")
    candidate = root.joinpath(*relative.split("/"))
    cursor = root
    try:
        root_info = root.lstat()
    except OSError as error:
        raise DeployError("BUNDLE_DIRECTORY_UNAVAILABLE") from error
    if not stat.S_ISDIR(root_info.st_mode) or stat.S_ISLNK(root_info.st_mode):
        raise DeployError("BUNDLE_DIRECTORY_UNSAFE")
    for part in relative.split("/")[:-1]:
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except OSError as error:
            raise DeployError("BUNDLE_PARENT_UNAVAILABLE") from error
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise DeployError("BUNDLE_PARENT_UNSAFE")
    return candidate


def read_regular(
    path: Path,
    *,
    maximum: int | None = None,
    expected_uid: int | None = None,
    expected_gid: int | None = None,
    expected_mode: int | None = None,
) -> bytes:
    flags = os.O_RDONLY | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise DeployError(f"FILE_UNAVAILABLE_{path.name}") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise DeployError(f"FILE_UNSAFE_{path.name}")
        if expected_uid is not None and before.st_uid != expected_uid:
            raise DeployError(f"FILE_OWNER_MISMATCH_{path.name}")
        if expected_gid is not None and before.st_gid != expected_gid:
            raise DeployError(f"FILE_GROUP_MISMATCH_{path.name}")
        if expected_mode is not None and stat.S_IMODE(before.st_mode) != expected_mode:
            raise DeployError(f"FILE_MODE_MISMATCH_{path.name}")
        if maximum is not None and before.st_size > maximum:
            raise DeployError(f"FILE_TOO_LARGE_{path.name}")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                raise DeployError(f"FILE_SHORT_READ_{path.name}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise DeployError(f"FILE_GREW_WHILE_READ_{path.name}")
        after = os.fstat(descriptor)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise DeployError(f"FILE_CHANGED_WHILE_READ_{path.name}")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def read_bundle_payload(path: Path, expected_bytes: int, expected_digest: str) -> bytes:
    data = read_regular(path, expected_uid=0, expected_gid=0, expected_mode=0o600)
    if len(data) != expected_bytes or sha256_bytes(data) != expected_digest:
        raise DeployError(f"BUNDLE_PAYLOAD_IDENTITY_MISMATCH_{path.name}")
    return data


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str) or not value.endswith("Z"):
        return False
    try:
        datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError:
        return False
    return True


def _archive_member_bytes(archive: tarfile.TarFile, name: str, maximum: int) -> bytes:
    members = [item for item in archive.getmembers() if item.name == name]
    if len(members) != 1 or not members[0].isfile() or members[0].size > maximum:
        raise DeployError("IMAGE_ARCHIVE_MEMBER_INVALID")
    stream = archive.extractfile(members[0])
    if stream is None:
        raise DeployError("IMAGE_ARCHIVE_MEMBER_UNREADABLE")
    return stream.read()


def _parse_archive_json(data: bytes) -> Any:
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeployError("IMAGE_ARCHIVE_JSON_INVALID") from error


def verify_archive_contract(
    archive_path: Path,
    *,
    image_tag: str,
    image_config_digest: str,
    revision: str,
    release_id: str,
    repository_url: str,
) -> dict[str, Any]:
    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            manifest = _parse_archive_json(_archive_member_bytes(archive, "manifest.json", 1024 * 1024))
            if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
                raise DeployError("IMAGE_ARCHIVE_MANIFEST_INVALID")
            entry = manifest[0]
            if entry.get("RepoTags") != [image_tag]:
                raise DeployError("IMAGE_ARCHIVE_TAG_MISMATCH")
            config_name = entry.get("Config")
            if not isinstance(config_name, str):
                raise DeployError("IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH")
            match = re.fullmatch(r"([0-9a-f]{64})\.json", config_name)
            if not match or f"sha256:{match.group(1)}" != image_config_digest:
                raise DeployError("IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH")
            config_bytes = _archive_member_bytes(archive, config_name, 16 * 1024 * 1024)
    except (tarfile.TarError, OSError) as error:
        raise DeployError("IMAGE_ARCHIVE_UNREADABLE") from error
    if sha256_bytes(config_bytes) != image_config_digest:
        raise DeployError("IMAGE_ARCHIVE_CONFIG_DIGEST_MISMATCH")
    config = _parse_archive_json(config_bytes)
    runtime = config.get("config") if isinstance(config, dict) else None
    labels = runtime.get("Labels") if isinstance(runtime, dict) else None
    expected_labels = {
        "org.opencontainers.image.revision": revision,
        "org.opencontainers.image.version": release_id,
        "org.opencontainers.image.source": repository_url,
    }
    if (
        not isinstance(runtime, dict)
        or config.get("os") != "linux"
        or config.get("architecture") != "amd64"
        or runtime.get("User") != "node"
        or runtime.get("WorkingDir") != "/usr/src/flowise"
        or runtime.get("Cmd") != ["node", "packages/server/bin/run", "start"]
        or not isinstance(labels, dict)
        or any(labels.get(key) != value for key, value in expected_labels.items())
        or not _valid_timestamp(labels.get("org.opencontainers.image.created"))
    ):
        raise DeployError("IMAGE_ARCHIVE_OCI_CONTRACT_MISMATCH")
    return {"platform": "linux/amd64", "oci_labels_verified": True}


def verify_legacy_archive_contract(
    archive_path: Path,
    *,
    image_tag: str,
    image_config_digest: str,
    revision: str,
    release_id: str,
    repository_url: str,
    created_at: str,
) -> dict[str, Any]:
    """Verify the frozen current image, including its exact OCI provenance."""

    try:
        with tarfile.open(archive_path, "r:gz") as archive:
            manifest = _parse_archive_json(_archive_member_bytes(archive, "manifest.json", 1024 * 1024))
            if not isinstance(manifest, list) or len(manifest) != 1 or not isinstance(manifest[0], dict):
                raise DeployError("LEGACY_IMAGE_ARCHIVE_MANIFEST_INVALID")
            entry = manifest[0]
            if entry.get("RepoTags") != [image_tag]:
                raise DeployError("LEGACY_IMAGE_ARCHIVE_TAG_MISMATCH")
            config_name = entry.get("Config")
            if not isinstance(config_name, str):
                raise DeployError("LEGACY_IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH")
            match = re.fullmatch(r"([0-9a-f]{64})\.json", config_name)
            if match is None or f"sha256:{match.group(1)}" != image_config_digest:
                raise DeployError("LEGACY_IMAGE_ARCHIVE_CONFIG_NAME_MISMATCH")
            config_bytes = _archive_member_bytes(archive, config_name, 16 * 1024 * 1024)
    except (tarfile.TarError, OSError) as error:
        raise DeployError("LEGACY_IMAGE_ARCHIVE_UNREADABLE") from error
    if sha256_bytes(config_bytes) != image_config_digest:
        raise DeployError("LEGACY_IMAGE_ARCHIVE_CONFIG_DIGEST_MISMATCH")
    config = _parse_archive_json(config_bytes)
    runtime = config.get("config") if isinstance(config, dict) else None
    labels = runtime.get("Labels") if isinstance(runtime, dict) else None
    labels = labels if isinstance(labels, dict) else {}
    if (
        not isinstance(runtime, dict)
        or config.get("os") != "linux"
        or config.get("architecture") != "amd64"
        or runtime.get("User") != "node"
        or runtime.get("WorkingDir") != "/usr/src/flowise"
        or runtime.get("Cmd") != ["node", "packages/server/bin/run", "start"]
        or labels.get("org.opencontainers.image.revision") != revision
        or labels.get("org.opencontainers.image.version") != release_id
        or labels.get("org.opencontainers.image.source") != repository_url
        or labels.get("org.opencontainers.image.created") != created_at
        or not _valid_timestamp(created_at)
    ):
        raise DeployError("LEGACY_IMAGE_ARCHIVE_RUNTIME_CONTRACT_MISMATCH")
    return {
        "platform": "linux/amd64",
        "revision_label": revision,
        "release_id": release_id,
        "repository_url": repository_url,
        "created_at": created_at,
        "image_environment": _environment_from_entries(runtime.get("Env") or [], "LEGACY_IMAGE"),
    }


def validate_release_manifest(manifest: dict[str, Any]) -> None:
    exact_keys(
        manifest,
        ("schema_version", "release_id", "created_at", "source", "toolchain", "inputs", "image", "boundaries"),
        "RELEASE_MANIFEST_ROOT",
    )
    if manifest.get("schema_version") != 1 or not _valid_timestamp(manifest.get("created_at")):
        raise DeployError("RELEASE_MANIFEST_HEADER_INVALID")
    source = manifest.get("source")
    if not isinstance(source, dict):
        raise DeployError("RELEASE_MANIFEST_SOURCE_FIELDS_INVALID")
    exact_keys(
        source,
        ("dirty_digest", "repository_url", "revision", "state", "tracked_patch", "untracked"),
        "RELEASE_MANIFEST_SOURCE",
    )
    if (
        source.get("state") != "clean"
        or source.get("dirty_digest") is not None
        or source.get("tracked_patch") is not None
        or source.get("untracked") != []
    ):
        raise DeployError("RELEASE_MANIFEST_SOURCE_NOT_CLEAN")
    exact_keys(manifest.get("toolchain"), ("node", "package_manager", "pnpm"), "RELEASE_MANIFEST_TOOLCHAIN")
    if manifest.get("toolchain") != EXPECTED_TOOLCHAIN:
        raise DeployError("RELEASE_MANIFEST_TOOLCHAIN_INVALID")
    inputs = manifest.get("inputs")
    if not isinstance(inputs, dict):
        raise DeployError("RELEASE_MANIFEST_INPUTS_FIELDS_INVALID")
    exact_keys(inputs, ("env_template", "files"), "RELEASE_MANIFEST_INPUTS")
    env_template = inputs.get("env_template")
    if not isinstance(env_template, dict):
        raise DeployError("RELEASE_MANIFEST_ENV_TEMPLATE_FIELDS_INVALID")
    exact_keys(env_template, ("keys", "keys_digest", "path"), "RELEASE_MANIFEST_ENV_TEMPLATE")
    env_keys = env_template.get("keys")
    if (
        env_template.get("path") != ".env.production.template"
        or not isinstance(env_keys, list)
        or any(not isinstance(key, str) or not ENV_KEY_RE.fullmatch(key) for key in env_keys)
        or env_keys != sorted(set(env_keys))
        or env_template.get("keys_digest") != sha256_bytes(("\n".join(env_keys) + "\n").encode())
    ):
        raise DeployError("RELEASE_MANIFEST_ENV_TEMPLATE_INVALID")
    input_files = inputs.get("files")
    if not isinstance(input_files, list):
        raise DeployError("RELEASE_MANIFEST_INPUT_FILES_INVALID")
    input_paths: list[str] = []
    for entry in input_files:
        exact_keys(entry, ("path", "bytes", "digest"), "RELEASE_MANIFEST_INPUT_FILE")
        if (
            not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("bytes"), int)
            or isinstance(entry.get("bytes"), bool)
            or entry.get("bytes") < 0
            or not isinstance(entry.get("digest"), str)
            or not DIGEST_RE.fullmatch(entry.get("digest"))
        ):
            raise DeployError("RELEASE_MANIFEST_INPUT_FILE_INVALID")
        input_paths.append(entry["path"])
    if tuple(input_paths) != EXPECTED_MANIFEST_INPUTS:
        raise DeployError("RELEASE_MANIFEST_INPUT_SET_INVALID")
    image = manifest.get("image")
    if not isinstance(image, dict):
        raise DeployError("RELEASE_MANIFEST_IMAGE_FIELDS_INVALID")
    exact_keys(image, ("archive", "config_digest", "distribution", "platform", "tag"), "RELEASE_MANIFEST_IMAGE")
    exact_keys(image.get("archive"), ("bytes", "digest"), "RELEASE_MANIFEST_ARCHIVE")
    boundaries = manifest.get("boundaries")
    if not isinstance(boundaries, dict):
        raise DeployError("RELEASE_MANIFEST_BOUNDARIES_FIELDS_INVALID")
    exact_keys(
        boundaries,
        ("production_unchanged", "production_write", "provider_call", "registry_push", "secrets_read", "stable"),
        "RELEASE_MANIFEST_BOUNDARIES",
    )
    if boundaries != {
        "production_unchanged": True,
        "production_write": False,
        "provider_call": False,
        "registry_push": False,
        "secrets_read": False,
        "stable": True,
    }:
        raise DeployError("RELEASE_MANIFEST_BOUNDARIES_INVALID")


def validate_release_evidence(
    data: bytes,
    *,
    manifest: dict[str, Any],
    entries: dict[str, dict[str, Any]],
    revision: str,
    image_tag: str,
    image_config_digest: str,
) -> dict[str, str]:
    """Validate the complete, ordered candidate-verification evidence schema."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DeployError("RELEASE_EVIDENCE_UTF8_INVALID") from error
    if not text.endswith("\n") or "\r" in text or "\x00" in text:
        raise DeployError("RELEASE_EVIDENCE_FORMAT_INVALID")
    lines = text[:-1].split("\n")
    if len(lines) != len(EXPECTED_EVIDENCE_KEYS):
        raise DeployError("RELEASE_EVIDENCE_SCHEMA_INVALID")
    evidence: dict[str, str] = {}
    for expected_key, line in zip(EXPECTED_EVIDENCE_KEYS, lines):
        key, separator, value = line.partition("=")
        if separator != "=" or key != expected_key or not value or key in evidence:
            raise DeployError("RELEASE_EVIDENCE_SCHEMA_INVALID")
        evidence[key] = value

    source = manifest["source"]["repository_url"]
    archive_entry = entries["image_archive"]
    expected = {
        "source": source,
        "revision": revision,
        "image_tag": image_tag,
        "store_identity": image_config_digest,
        "image_config_digest": image_config_digest,
        "platform": "linux/amd64",
        "buildx_version": EXPECTED_BUILDX_VERSION,
        "buildkit_version": EXPECTED_BUILDKIT_VERSION,
        "archive_bytes": str(archive_entry["bytes"]),
        "archive_sha256": archive_entry["digest"].removeprefix("sha256:"),
        "manifest_sha256": entries["release_manifest"]["digest"].removeprefix("sha256:"),
        "isolated_smoke": "passed",
        "chromium_profile_sha256": entries["chromium_seccomp"]["digest"].removeprefix("sha256:"),
        "production_compose_sha256": entries["production_compose"]["digest"].removeprefix("sha256:"),
        "production_wrapper_sha256": entries["production_wrapper"]["digest"].removeprefix("sha256:"),
        "chromium_sandbox": "passed",
        "raw_chromium_sandbox": "passed",
        "playwright_sandbox": "passed",
        "puppeteer_sandbox": "passed",
        "clone3_namespace": "blocked_enosys",
        "unsafe_chromium_flags": "false",
        "registry_push": "false",
    }
    if evidence != expected:
        raise DeployError("RELEASE_EVIDENCE_VALUE_MISMATCH")
    return evidence


def verify_bundle(bundle_dir: Path) -> Bundle:
    root = bundle_dir.absolute()
    bundle_path = _safe_relative_path(root, "deployment-bundle.json")
    bundle_bytes = read_regular(bundle_path, maximum=1024 * 1024, expected_uid=0, expected_gid=0, expected_mode=0o600)
    document = parse_canonical_json(bundle_bytes, "DEPLOYMENT_BUNDLE")
    exact_keys(document, ("schema_version", "created_at", "release", "files", "boundaries"), "BUNDLE_ROOT")
    if document["schema_version"] != 1 or not _valid_timestamp(document["created_at"]):
        raise DeployError("BUNDLE_HEADER_INVALID")
    if document["boundaries"] != EXPECTED_BOUNDARIES:
        raise DeployError("BUNDLE_BOUNDARIES_INVALID")
    release = document["release"]
    exact_keys(release, ("release_id", "revision", "image_tag", "image_config_digest"), "BUNDLE_RELEASE")
    revision = release.get("revision")
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        raise DeployError("BUNDLE_REVISION_INVALID")
    release_id = f"git-{revision}"
    image_tag = f"flowise-chinese:{release_id}"
    if release.get("release_id") != release_id or release.get("image_tag") != image_tag:
        raise DeployError("BUNDLE_RELEASE_IDENTITY_INVALID")
    image_config_digest = release.get("image_config_digest")
    if not isinstance(image_config_digest, str) or not DIGEST_RE.fullmatch(image_config_digest):
        raise DeployError("BUNDLE_IMAGE_CONFIG_DIGEST_INVALID")
    entries = document["files"]
    if not isinstance(entries, list) or [item.get("path") for item in entries if isinstance(item, dict)] != sorted(EXPECTED_BUNDLE_FILES.values()):
        raise DeployError("BUNDLE_FILES_NOT_SORTED")
    by_role: dict[str, dict[str, Any]] = {}
    files: dict[str, Path] = {}
    payload_data: dict[str, bytes] = {}
    for entry in entries:
        exact_keys(entry, ("role", "path", "bytes", "digest"), "BUNDLE_FILE")
        role, relative = entry["role"], entry["path"]
        if role in by_role or EXPECTED_BUNDLE_FILES.get(role) != relative:
            raise DeployError("BUNDLE_FILE_ROLE_INVALID")
        if not isinstance(entry["bytes"], int) or isinstance(entry["bytes"], bool) or entry["bytes"] <= 0:
            raise DeployError("BUNDLE_FILE_BYTES_INVALID")
        if not isinstance(entry["digest"], str) or not DIGEST_RE.fullmatch(entry["digest"]):
            raise DeployError("BUNDLE_FILE_DIGEST_INVALID")
        path = _safe_relative_path(root, relative)
        if role == "image_archive":
            verify_regular_identity(path, expected_bytes=entry["bytes"], expected_digest=entry["digest"])
        else:
            payload_data[role] = read_bundle_payload(path, entry["bytes"], entry["digest"])
        by_role[role] = entry
        files[role] = path
    if set(by_role) != set(EXPECTED_BUNDLE_FILES):
        raise DeployError("BUNDLE_FILE_SET_INVALID")
    if payload_data["production_wrapper"] != read_regular(SCRIPT_PATH, maximum=2 * 1024 * 1024):
        raise DeployError("BUNDLE_WRAPPER_EXECUTION_MISMATCH")
    manifest = parse_canonical_json(payload_data["release_manifest"], "RELEASE_MANIFEST")
    validate_release_manifest(manifest)
    manifest_inputs = {entry["path"]: entry for entry in manifest["inputs"]["files"]}
    for role in ("production_compose", "chromium_seccomp", "production_wrapper"):
        path = EXPECTED_BUNDLE_FILES[role]
        manifest_entry = manifest_inputs.get(path)
        bundle_entry = by_role[role]
        if manifest_entry != {
            "path": path,
            "bytes": bundle_entry["bytes"],
            "digest": bundle_entry["digest"],
        }:
            raise DeployError(f"BUNDLE_MANIFEST_INPUT_MISMATCH_{role.upper()}")
    source_value = manifest.get("source")
    image_value = manifest.get("image")
    boundaries_value = manifest.get("boundaries")
    source: dict[str, Any] = source_value if isinstance(source_value, dict) else {}
    image: dict[str, Any] = image_value if isinstance(image_value, dict) else {}
    archive_value = image.get("archive")
    archive: dict[str, Any] = archive_value if isinstance(archive_value, dict) else {}
    manifest_boundaries: dict[str, Any] = boundaries_value if isinstance(boundaries_value, dict) else {}
    if (
        manifest.get("schema_version") != 1
        or manifest.get("release_id") != release_id
        or source.get("revision") != revision
        or source.get("state") != "clean"
        or manifest_boundaries.get("stable") is not True
        or image.get("tag") != image_tag
        or image.get("config_digest") != image_config_digest
        or image.get("distribution") != "offline_archive"
        or image.get("platform") != "linux/amd64"
        or archive != {"bytes": by_role["image_archive"]["bytes"], "digest": by_role["image_archive"]["digest"]}
    ):
        raise DeployError("BUNDLE_RELEASE_MANIFEST_MISMATCH")
    validate_release_evidence(
        payload_data["release_evidence"],
        manifest=manifest,
        entries=by_role,
        revision=revision,
        image_tag=image_tag,
        image_config_digest=image_config_digest,
    )
    repository_url = source.get("repository_url")
    if not isinstance(repository_url, str) or not repository_url.startswith(("https://", "ssh://")):
        raise DeployError("BUNDLE_REPOSITORY_URL_INVALID")
    verify_archive_contract(
        files["image_archive"],
        image_tag=image_tag,
        image_config_digest=image_config_digest,
        revision=revision,
        release_id=release_id,
        repository_url=repository_url,
    )
    # Detect a root-side replacement that raced the archive semantic check.
    verify_regular_identity(
        files["image_archive"],
        expected_bytes=by_role["image_archive"]["bytes"],
        expected_digest=by_role["image_archive"]["digest"],
    )
    return Bundle(
        root=root,
        document=document,
        manifest=manifest,
        files=files,
        file_entries=by_role,
        release_id=release_id,
        revision=revision,
        image_tag=image_tag,
        image_config_digest=image_config_digest,
        bundle_digest=sha256_bytes(bundle_bytes),
    )


def verify_transition_permit(
    path: Path,
    expected_digest: str,
    *,
    bundle: Bundle,
    run_id: str,
) -> TransitionPermit:
    """Verify the one-run, exact-state authorization for the c947 bootstrap."""

    data = read_regular(
        path.absolute(),
        maximum=1024 * 1024,
        expected_uid=0,
        expected_gid=0,
        expected_mode=0o600,
    )
    actual_digest = sha256_bytes(data)
    if actual_digest != expected_digest:
        raise DeployError("TRANSITION_PERMIT_DIGEST_MISMATCH")
    document = parse_canonical_json(data, "TRANSITION_PERMIT")
    exact_keys(
        document,
        (
            "schema_version",
            "policy",
            "run_id",
            "target_bundle",
            "active_legacy",
            "containers",
            "live",
            "database",
            "network_identity",
            "legacy_journal_inventory",
        ),
        "TRANSITION_PERMIT_ROOT",
    )
    if document.get("schema_version") != 1 or document.get("run_id") != run_id:
        raise DeployError("TRANSITION_PERMIT_HEADER_INVALID")
    _validate_policy(document.get("policy"), LEGACY_BOOTSTRAP_POLICY, "TRANSITION_PERMIT")

    target_value = document.get("target_bundle")
    exact_keys(
        target_value,
        ("bundle_digest", "revision", "image_tag", "image_config_digest"),
        "TRANSITION_PERMIT_TARGET_BUNDLE",
    )
    if not isinstance(target_value, dict):
        raise DeployError("TRANSITION_PERMIT_TARGET_BUNDLE_FIELDS_INVALID")
    target: dict[str, Any] = target_value
    if target != {
        "bundle_digest": bundle.bundle_digest,
        "revision": bundle.revision,
        "image_tag": bundle.image_tag,
        "image_config_digest": bundle.image_config_digest,
    }:
        raise DeployError("TRANSITION_PERMIT_TARGET_BUNDLE_MISMATCH")

    active_value = document.get("active_legacy")
    exact_keys(
        active_value,
        (
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
        ),
        "TRANSITION_PERMIT_ACTIVE_LEGACY",
    )
    if not isinstance(active_value, dict):
        raise DeployError("TRANSITION_PERMIT_ACTIVE_LEGACY_FIELDS_INVALID")
    active: dict[str, Any] = active_value
    active_revision = active.get("revision")
    active_tag = active.get("image_tag")
    if (
        not isinstance(active_revision, str)
        or not REVISION_RE.fullmatch(active_revision)
        or active_revision != LEGACY_BOOTSTRAP_REVISION
        or active_tag != f"flowise-chinese:git-{active_revision}"
        or active.get("release_id") != f"git-{active_revision}"
        or active.get("repository_url") not in LEGACY_BOOTSTRAP_REPOSITORY_URLS
        or not _valid_timestamp(active.get("created_at"))
        or not isinstance(active.get("image_config_digest"), str)
        or not DIGEST_RE.fullmatch(active["image_config_digest"])
        or not isinstance(active.get("runtime_label_config_hash"), str)
        or not CONFIG_HASH_RE.fullmatch(active["runtime_label_config_hash"])
        or not isinstance(active.get("live_computed_config_hash"), str)
        or not CONFIG_HASH_RE.fullmatch(active["live_computed_config_hash"])
        or active["runtime_label_config_hash"] == active["live_computed_config_hash"]
        or not isinstance(active.get("runtime_projection_digest"), str)
        or not DIGEST_RE.fullmatch(active["runtime_projection_digest"])
        or not isinstance(active.get("runtime_environment_keys"), list)
        or any(
            not isinstance(name, str) or not ENV_KEY_RE.fullmatch(name)
            for name in active["runtime_environment_keys"]
        )
        or active["runtime_environment_keys"] != sorted(set(active["runtime_environment_keys"]))
        or not isinstance(active.get("runtime_environment_hmac_sha256"), str)
        or not DIGEST_RE.fullmatch(active["runtime_environment_hmac_sha256"])
    ):
        raise DeployError("TRANSITION_PERMIT_ACTIVE_LEGACY_INVALID")
    if (
        target["revision"] == active_revision
        or target["image_tag"] == active_tag
        or target["image_config_digest"] == active["image_config_digest"]
    ):
        raise DeployError("TRANSITION_PERMIT_TARGET_NOT_DISTINCT_FROM_ACTIVE_LEGACY")

    containers_value = document.get("containers")
    exact_keys(containers_value, MANAGED_CONTAINERS, "TRANSITION_PERMIT_CONTAINERS")
    if not isinstance(containers_value, dict):
        raise DeployError("TRANSITION_PERMIT_CONTAINERS_FIELDS_INVALID")
    containers: dict[str, Any] = containers_value
    if any(not isinstance(containers[name], str) or not DOCKER_ID_RE.fullmatch(containers[name]) for name in MANAGED_CONTAINERS):
        raise DeployError("TRANSITION_PERMIT_CONTAINER_ID_INVALID")

    _validate_network_identity_binding(
        document.get("network_identity"),
        "TRANSITION_PERMIT_NETWORK_IDENTITY",
    )

    live_value = document.get("live")
    exact_keys(live_value, ("env_sha256", "compose_sha256", "seccomp"), "TRANSITION_PERMIT_LIVE")
    if not isinstance(live_value, dict):
        raise DeployError("TRANSITION_PERMIT_LIVE_FIELDS_INVALID")
    live: dict[str, Any] = live_value
    exact_keys(live.get("seccomp"), ("present", "digest"), "TRANSITION_PERMIT_LIVE_SECCOMP")
    if (
        not isinstance(live.get("env_sha256"), str)
        or not DIGEST_RE.fullmatch(live["env_sha256"])
        or not isinstance(live.get("compose_sha256"), str)
        or not DIGEST_RE.fullmatch(live["compose_sha256"])
        or live["seccomp"] != {"present": False, "digest": None}
    ):
        raise DeployError("TRANSITION_PERMIT_LIVE_INVALID")

    database_value = document.get("database")
    exact_keys(database_value, ("migration_count", "migration_name_sha256"), "TRANSITION_PERMIT_DATABASE")
    if not isinstance(database_value, dict):
        raise DeployError("TRANSITION_PERMIT_DATABASE_FIELDS_INVALID")
    database: dict[str, Any] = database_value
    if (
        not isinstance(database.get("migration_count"), int)
        or isinstance(database.get("migration_count"), bool)
        or database["migration_count"] <= 0
        or not isinstance(database.get("migration_name_sha256"), str)
        or not DIGEST_RE.fullmatch(database["migration_name_sha256"])
    ):
        raise DeployError("TRANSITION_PERMIT_DATABASE_INVALID")

    inventory_value = document.get("legacy_journal_inventory")
    exact_keys(
        inventory_value,
        (
            "root_paths",
            "root_count",
            "run_count",
            "control_count",
            "canonical_inventory_sha256",
            "unresolved_rollback_count",
        ),
        "TRANSITION_PERMIT_LEGACY_JOURNAL_INVENTORY",
    )
    if not isinstance(inventory_value, dict):
        raise DeployError("TRANSITION_PERMIT_LEGACY_JOURNAL_INVENTORY_FIELDS_INVALID")
    inventory: dict[str, Any] = inventory_value
    roots = inventory.get("root_paths")
    expected_active_root = str(LEGACY_RELEASES_DIR / f"git-{active_revision}" / "deployments")
    if (
        not isinstance(roots, list)
        or not roots
        or roots != sorted(set(roots))
        or expected_active_root not in roots
        or any(
            not isinstance(root, str)
            or not re.fullmatch(r"/opt/flowise/releases/git-[0-9a-f]{40}/deployments", root)
            for root in roots
        )
        or not isinstance(inventory.get("root_count"), int)
        or isinstance(inventory.get("root_count"), bool)
        or inventory["root_count"] != len(roots)
        or not isinstance(inventory.get("run_count"), int)
        or isinstance(inventory.get("run_count"), bool)
        or inventory["run_count"] <= 0
        or not isinstance(inventory.get("control_count"), int)
        or isinstance(inventory.get("control_count"), bool)
        or inventory["control_count"] <= 0
        or not inventory["root_count"] <= inventory["run_count"] <= inventory["control_count"]
        or not isinstance(inventory.get("canonical_inventory_sha256"), str)
        or not DIGEST_RE.fullmatch(inventory["canonical_inventory_sha256"])
        or inventory.get("unresolved_rollback_count") != 0
    ):
        raise DeployError("TRANSITION_PERMIT_LEGACY_JOURNAL_INVENTORY_INVALID")
    return TransitionPermit(path=path.absolute(), document=document, digest=actual_digest)


def _validate_inventory_directory(
    path: Path,
    label: str,
    *,
    expected_mode: int = 0o700,
    allowed_uids: tuple[int, ...] = (0,),
    allowed_gids: tuple[int, ...] = (0,),
) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise DeployError(f"{label}_DIRECTORY_UNAVAILABLE") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid not in allowed_uids
        or info.st_gid not in allowed_gids
        or stat.S_IMODE(info.st_mode) != expected_mode
    ):
        raise DeployError(f"{label}_DIRECTORY_UNSAFE")


def _validate_secure_run_directory(run_dir: Path) -> None:
    if run_dir.parent != RUNS_DIR or not RUN_ID_RE.fullmatch(run_dir.name):
        raise DeployError("RUN_DIRECTORY_PATH_INVALID")
    _validate_inventory_directory(RUNS_DIR, "RUNS_ROOT")
    _validate_inventory_directory(run_dir, "RUN")


def _validate_secure_run_role(
    run_dir: Path,
    role: str,
) -> Path:
    if role not in {"candidate", "rollback", "legacy", "hardened_active", "target_bundle"}:
        raise DeployError("RUN_ROLE_INVALID")
    _validate_secure_run_directory(run_dir)
    role_root = run_dir / role
    _validate_inventory_directory(role_root, "RUN_ROLE")
    docker_root = role_root / "docker"
    seccomp_root = docker_root / "seccomp"
    for path, label in ((docker_root, "RUN_ROLE_DOCKER"), (seccomp_root, "RUN_ROLE_SECCOMP")):
        try:
            info = path.lstat()
        except FileNotFoundError as error:
            raise DeployError(f"{label}_DIRECTORY_UNAVAILABLE") from error
        except OSError as error:
            raise DeployError(f"{label}_DIRECTORY_UNAVAILABLE") from error
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise DeployError(f"{label}_DIRECTORY_UNSAFE")
        _validate_inventory_directory(path, label)
    return role_root


def _parse_control_json(path: Path, label: str) -> tuple[dict[str, Any], bytes]:
    data = read_regular(
        path,
        maximum=2 * 1024 * 1024,
        expected_uid=0,
        expected_gid=0,
        expected_mode=0o600,
    )
    try:
        document = json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeployError(f"{label}_CONTROL_JSON_INVALID") from error
    if not isinstance(document, dict):
        raise DeployError(f"{label}_CONTROL_JSON_INVALID")
    return document, data


def _legacy_control_kind(name: str) -> str | None:
    if name in LEGACY_FIXED_CONTROL_BASENAMES:
        return name
    match = re.fullmatch(
        r"post-acceptance-rollback-(?P<timestamp>[0-9]{8}T[0-9]{6}\.[0-9]{6}Z)\.json",
        name,
    )
    if match is not None:
        try:
            datetime.strptime(match.group("timestamp"), "%Y%m%dT%H%M%S.%fZ")
        except ValueError as error:
            raise DeployError("LEGACY_JOURNAL_POST_ROLLBACK_TIMESTAMP_INVALID") from error
        return "post-acceptance-rollback"
    return None


def _validate_legacy_control(document: dict[str, Any], kind: str) -> tuple[str | None, bool]:
    """Validate only the exact control shapes observed in the bound 41-file inventory."""

    if "operation" in document:
        raise DeployError("LEGACY_JOURNAL_CONTROL_SCHEMA_INVALID")
    state = document.get("state")
    phase = document.get("phase")
    if (
        state in {"in_progress", "rolling_back", ROLLBACK_ATTEMPTED_STATE}
        or isinstance(state, str)
        and (state.startswith("rollback_failed") or state.startswith("rollback_attempted"))
    ):
        return state if isinstance(state, str) else None, True
    if kind == "candidate-manifest-attempt.json":
        exact_keys(document, LEGACY_CONTROL_KEYS[kind], "LEGACY_JOURNAL_CANDIDATE_METADATA")
        return None, False
    allowed: dict[str, set[tuple[str, str | None]]] = {
        "prepare-status.json": {
            ("prepared", "prepared_cutover_ready"),
            ("failed", "initialized"),
            ("failed", "validated_pre_load"),
            ("failed", "candidate_loaded"),
        },
        "cutover-status.json": {
            ("complete_candidate_active", "complete_candidate_active"),
            ("rolled_back", "rolled_back"),
        },
        "compose-cutover-status.json": {
            ("failed_before_compose_promotion", "candidate_compose_not_promoted"),
            ("rolled_back", "rollback_compose_restored"),
            ("complete_candidate_active", "complete_candidate_compose_active"),
            ("post_acceptance_rolled_back", "post_acceptance_rollback_compose_restored"),
        },
        "post-acceptance-rollback": {("post_acceptance_rolled_back", None)},
    }
    if not isinstance(state, str) or (state, phase) not in allowed[kind]:
        raise DeployError("LEGACY_JOURNAL_CONTROL_STATE_UNKNOWN")
    if kind == "prepare-status.json":
        if not isinstance(phase, str):
            raise DeployError("LEGACY_JOURNAL_CONTROL_STATE_UNKNOWN")
        expected_keys = LEGACY_PREPARE_KEYS_BY_STATE_PHASE[(state, phase)]
    else:
        expected_keys = LEGACY_CONTROL_KEYS[kind]
    exact_keys(document, expected_keys, "LEGACY_JOURNAL_CONTROL_SCHEMA")
    return state, False


def _legacy_deployments_inventory(
    root: Path,
    *,
    relative_base: Path,
) -> tuple[list[dict[str, str]], int, dict[str, list[tuple[str, str | None]]]]:
    _validate_inventory_directory(root, "LEGACY_JOURNAL")
    records: list[dict[str, str]] = []
    unresolved = 0
    runs: dict[str, list[tuple[str, str | None]]] = {}
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        _validate_inventory_directory(current_path, "LEGACY_JOURNAL")
        for name in sorted(directory_names):
            child = current_path / name
            try:
                info = child.lstat()
            except OSError as error:
                raise DeployError("LEGACY_JOURNAL_PATH_UNAVAILABLE") from error
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise DeployError("LEGACY_JOURNAL_PATH_UNSAFE")
            _validate_inventory_directory(child, "LEGACY_JOURNAL")
        for name in sorted(file_names):
            path = current_path / name
            try:
                info = path.lstat()
            except OSError as error:
                raise DeployError("LEGACY_JOURNAL_PATH_UNAVAILABLE") from error
            if (
                stat.S_ISLNK(info.st_mode)
                or not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_uid != 0
                or info.st_gid != 0
                or stat.S_IMODE(info.st_mode) != 0o600
            ):
                raise DeployError("LEGACY_JOURNAL_PATH_UNSAFE")
            if path.suffix != ".json":
                continue
            kind = _legacy_control_kind(name)
            if kind is None:
                raise DeployError("LEGACY_JOURNAL_CONTROL_JSON_NAME_UNKNOWN")
            relative = path.relative_to(relative_base).as_posix()
            run_relative = path.relative_to(root)
            if len(run_relative.parts) != 2 or not RUN_ID_RE.fullmatch(run_relative.parts[0]):
                raise DeployError("LEGACY_JOURNAL_CONTROL_PATH_INVALID")
            run_key = run_relative.parts[0]
            document, _ = _parse_control_json(path, "LEGACY_JOURNAL")
            if kind != "candidate-manifest-attempt.json" and document.get("run_id") != run_key:
                raise DeployError("LEGACY_JOURNAL_RUN_ID_MISMATCH")
            expected_release_id = root.parent.name
            if kind != "post-acceptance-rollback" and document.get("release_id") != expected_release_id:
                raise DeployError("LEGACY_JOURNAL_RELEASE_ID_MISMATCH")
            state, item_unresolved = _validate_legacy_control(document, kind)
            canonical_digest = sha256_bytes(canonical_json(document))
            records.append({"path": relative, "canonical_sha256": canonical_digest})
            runs.setdefault(run_key, []).append((kind, state))
            unresolved += int(item_unresolved)
    return records, unresolved, runs


def _validate_legacy_run_associations(runs: dict[str, list[tuple[str, str | None]]]) -> None:
    if not runs:
        raise DeployError("LEGACY_JOURNAL_RUN_INVENTORY_EMPTY")
    for controls in runs.values():
        by_kind: dict[str, list[str | None]] = {}
        for kind, state in controls:
            by_kind.setdefault(kind, []).append(state)
        prepare_states = by_kind.get("prepare-status.json", [])
        cutover_states = by_kind.get("cutover-status.json", [])
        compose_states = by_kind.get("compose-cutover-status.json", [])
        post_states = by_kind.get("post-acceptance-rollback", [])
        candidate_manifests = by_kind.get("candidate-manifest-attempt.json", [])
        if (
            len(prepare_states) != 1
            or len(cutover_states) > 1
            or len(compose_states) > 1
            or len(post_states) > 1
            or len(candidate_manifests) > 1
        ):
            raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")
        if prepare_states[0] == "prepared":
            if len(cutover_states) != 1:
                raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")
        elif prepare_states[0] == "failed":
            if cutover_states or post_states or compose_states:
                raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")
        else:
            raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")
        if post_states and cutover_states != ["complete_candidate_active"]:
            raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")
        if compose_states == ["post_acceptance_rolled_back"] and not post_states:
            raise DeployError("LEGACY_JOURNAL_RUN_ASSOCIATION_INVALID")


def legacy_journal_inventory() -> dict[str, Any]:
    """Read, but never recover or mutate, release-scoped legacy journals."""

    _validate_inventory_directory(
        BASE_DIR,
        "LEGACY_JOURNAL_PARENT",
        expected_mode=0o755,
        allowed_uids=(0, 1000),
        allowed_gids=(0, 1000),
    )
    _validate_inventory_directory(LEGACY_RELEASES_DIR, "LEGACY_JOURNAL")
    roots: list[str] = []
    records: list[dict[str, str]] = []
    unresolved = 0
    runs: dict[str, list[tuple[str, str | None]]] = {}
    try:
        children = sorted(LEGACY_RELEASES_DIR.iterdir(), key=lambda path: path.name)
    except OSError as error:
        raise DeployError("LEGACY_JOURNAL_ROOT_ENUMERATION_FAILED") from error
    for release_root in children:
        if not re.fullmatch(r"git-[0-9a-f]{40}", release_root.name):
            raise DeployError("LEGACY_JOURNAL_RELEASE_ROOT_UNKNOWN")
        _validate_inventory_directory(release_root, "LEGACY_JOURNAL")
        deployments = release_root / "deployments"
        try:
            deployments_info = deployments.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise DeployError("LEGACY_JOURNAL_DEPLOYMENTS_UNAVAILABLE") from error
        if not stat.S_ISDIR(deployments_info.st_mode) or stat.S_ISLNK(deployments_info.st_mode):
            raise DeployError("LEGACY_JOURNAL_DEPLOYMENTS_UNSAFE")
        roots.append(str(deployments))
        root_records, root_unresolved, root_runs = _legacy_deployments_inventory(
            deployments,
            relative_base=LEGACY_RELEASES_DIR,
        )
        records.extend(root_records)
        unresolved += root_unresolved
        for run_key, controls in root_runs.items():
            scoped_key = f"{release_root.name}/{run_key}"
            if scoped_key in runs:
                raise DeployError("LEGACY_JOURNAL_RUN_DUPLICATE")
            runs[scoped_key] = controls
    if not roots or not records:
        raise DeployError("LEGACY_JOURNAL_INVENTORY_EMPTY")
    if unresolved:
        raise DeployError("LEGACY_JOURNAL_UNRESOLVED_ROLLBACK")
    _validate_legacy_run_associations(runs)
    records.sort(key=lambda item: item["path"])
    return {
        "root_paths": sorted(roots),
        "root_count": len(roots),
        "run_count": len(runs),
        "control_count": len(records),
        "canonical_inventory_sha256": sha256_bytes(canonical_json(records)),
        "unresolved_rollback_count": 0,
    }


def _current_deployments_inventory(
    root: Path,
    *,
    exclude_run_id: str | None = None,
) -> tuple[list[dict[str, str]], int]:
    _validate_inventory_directory(root, "CURRENT_JOURNAL")
    if exclude_run_id is not None and not RUN_ID_RE.fullmatch(exclude_run_id):
        raise DeployError("CURRENT_JOURNAL_EXCLUDED_RUN_ID_INVALID")
    records: list[dict[str, str]] = []
    unresolved = 0
    for current, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        _validate_inventory_directory(current_path, "CURRENT_JOURNAL")
        if current_path == root and any(not RUN_ID_RE.fullmatch(name) for name in directory_names):
            raise DeployError("CURRENT_JOURNAL_RUN_DIRECTORY_UNKNOWN")
        if current_path == root and exclude_run_id is not None:
            directory_names[:] = [name for name in directory_names if name != exclude_run_id]
        for name in sorted(directory_names):
            child = current_path / name
            try:
                info = child.lstat()
            except OSError as error:
                raise DeployError("CURRENT_JOURNAL_PATH_UNAVAILABLE") from error
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise DeployError("CURRENT_JOURNAL_PATH_UNSAFE")
            _validate_inventory_directory(child, "CURRENT_JOURNAL")
        for name in sorted(file_names):
            path = current_path / name
            try:
                info = path.lstat()
            except OSError as error:
                raise DeployError("CURRENT_JOURNAL_PATH_UNAVAILABLE") from error
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise DeployError("CURRENT_JOURNAL_PATH_UNSAFE")
            relative = path.relative_to(root)
            direct_control = (
                len(relative.parts) == 2
                and RUN_ID_RE.fullmatch(relative.parts[0]) is not None
                and path.suffix == ".json"
            )
            if name not in CURRENT_CONTROL_BASENAMES and not name.endswith("-receipt.json") and not direct_control:
                continue
            if name not in CURRENT_CONTROL_BASENAMES:
                raise DeployError("CURRENT_JOURNAL_CONTROL_JSON_NAME_UNKNOWN")
            if not direct_control:
                raise DeployError("CURRENT_JOURNAL_CONTROL_JSON_PATH_INVALID")
            document, data = _parse_control_json(path, "CURRENT_JOURNAL")
            state = document.get("state")
            operation = document.get("operation")
            if (
                document.get("run_id") != relative.parts[0]
                or not isinstance(state, str)
                or not isinstance(operation, str)
            ):
                raise DeployError("CURRENT_JOURNAL_CONTROL_JSON_STATE_INVALID")
            item_unresolved = state in CURRENT_UNRESOLVED_STATES
            if not item_unresolved and state not in CURRENT_TERMINAL_STATES:
                raise DeployError("CURRENT_JOURNAL_CONTROL_JSON_STATE_UNKNOWN")
            if name.endswith("-receipt.json"):
                receipt_name = name.removesuffix("-receipt.json")
                if receipt_name.startswith("bootstrap-"):
                    _validate_receipt_policy(document, receipt_name)
                if (operation, state) != CURRENT_RECEIPT_CONTRACTS[name]:
                    raise DeployError("CURRENT_JOURNAL_RECEIPT_CONTRACT_INVALID")
            elif state not in CURRENT_JOURNAL_STATES_BY_OPERATION.get(operation, set()):
                raise DeployError("CURRENT_JOURNAL_OPERATION_STATE_INVALID")
            elif operation.startswith("bootstrap"):
                _validate_policy(document.get("policy"), LEGACY_BOOTSTRAP_POLICY, "BOOTSTRAP_JOURNAL")
            records.append(
                {
                    "path": path.relative_to(root).as_posix(),
                    "canonical_sha256": sha256_bytes(canonical_json(document)),
                    "bytes_sha256": sha256_bytes(data),
                }
            )
            unresolved += int(item_unresolved)
    return records, unresolved


def current_journal_inventory(*, exclude_run_id: str | None = None) -> dict[str, Any]:
    """Reject unsafe or unresolved journals in the wrapper's current root."""

    if not RUNS_DIR.exists() and not RUNS_DIR.is_symlink():
        return {
            "root": str(RUNS_DIR),
            "present": False,
            "control_json_count": 0,
            "control_json_sha256": sha256_bytes(canonical_json([])),
            "unresolved_rollback_count": 0,
        }
    records, unresolved = _current_deployments_inventory(RUNS_DIR, exclude_run_id=exclude_run_id)
    if unresolved:
        raise DeployError("CURRENT_JOURNAL_UNRESOLVED_ROLLBACK")
    records.sort(key=lambda item: item["path"])
    return {
        "root": str(RUNS_DIR),
        "present": True,
        "control_json_count": len(records),
        "control_json_sha256": sha256_bytes(canonical_json(records)),
        "unresolved_rollback_count": 0,
    }


def run_command(args: list[str], *, input_data: bytes | None = None, timeout: int = 300) -> bytes:
    try:
        completed = subprocess.run(
            args,
            input=input_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            env=SAFE_ENV,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        raise DeployError(f"COMMAND_TIMEOUT_{Path(args[0]).name.upper()}") from error
    if completed.returncode != 0:
        raise DeployError(f"COMMAND_FAILED_{Path(args[0]).name.upper()}_{completed.returncode}")
    return completed.stdout


def _ensure_lock_directory() -> None:
    parent = LOCK_DIR.parent
    try:
        parent_info = parent.lstat()
    except OSError as error:
        raise DeployError("LOCK_PARENT_UNAVAILABLE") from error
    parent_mode = stat.S_IMODE(parent_info.st_mode)
    if (
        not stat.S_ISDIR(parent_info.st_mode)
        or stat.S_ISLNK(parent_info.st_mode)
        or parent_info.st_uid != 0
        or (parent_mode & 0o022 and not parent_mode & stat.S_ISVTX)
    ):
        raise DeployError("LOCK_PARENT_UNSAFE")
    try:
        LOCK_DIR.mkdir(mode=0o700)
        os.chown(LOCK_DIR, 0, 0)
        fsync_dir(parent)
    except FileExistsError:
        pass
    try:
        info = LOCK_DIR.lstat()
    except OSError as error:
        raise DeployError("LOCK_DIRECTORY_UNAVAILABLE") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise DeployError("LOCK_DIRECTORY_UNSAFE")


def _validate_lock_identity(descriptor: int) -> None:
    info = os.fstat(descriptor)
    try:
        path_info = LOCK_PATH.lstat()
    except OSError as error:
        raise DeployError("DEPLOY_LOCK_PATH_UNAVAILABLE") from error
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_nlink != 1
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o600
        or not stat.S_ISREG(path_info.st_mode)
        or stat.S_ISLNK(path_info.st_mode)
        or path_info.st_dev != info.st_dev
        or path_info.st_ino != info.st_ino
    ):
        raise DeployError("DEPLOY_LOCK_IDENTITY_UNSAFE")


def acquire_lock() -> int:
    _ensure_lock_directory()
    base_flags = os.O_RDWR | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        base_flags |= os.O_NOFOLLOW
    created = False
    try:
        descriptor = os.open(LOCK_PATH, base_flags | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        try:
            descriptor = os.open(LOCK_PATH, base_flags)
        except OSError as error:
            raise DeployError("DEPLOY_LOCK_OPEN_FAILED") from error
    try:
        if created:
            os.fchmod(descriptor, 0o600)
            os.fchown(descriptor, 0, 0)
    except Exception:
        os.close(descriptor)
        if created:
            try:
                LOCK_PATH.unlink()
                fsync_dir(LOCK_DIR)
            except OSError:
                pass
        raise
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _validate_lock_identity(descriptor)
    except BlockingIOError as error:
        os.close(descriptor)
        raise DeployError("DEPLOY_LOCK_BUSY") from error
    except Exception:
        os.close(descriptor)
        raise
    return descriptor


def fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, data: bytes, mode: int, uid: int = 0, gid: int = 0) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    try:
        descriptor = os.open(temporary, flags, mode)
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        view = memoryview(data)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                raise DeployError("ATOMIC_WRITE_SHORT")
            view = view[count:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        os.replace(temporary, path)
        fsync_dir(path.parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def atomic_json(path: Path, document: dict[str, Any]) -> None:
    atomic_write(path, canonical_json(document), 0o600)


def _validate_transition_permit_directory(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_DIRECTORY_UNAVAILABLE") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise DeployError("TRANSITION_PERMIT_DIRECTORY_UNSAFE")


def _validate_transition_permit_parent(path: Path) -> None:
    try:
        info = path.lstat()
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_PARENT_UNAVAILABLE") from error
    if (
        not stat.S_ISDIR(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or info.st_gid != 0
        or stat.S_IMODE(info.st_mode) & 0o022
    ):
        raise DeployError("TRANSITION_PERMIT_PARENT_UNSAFE")


def _ensure_transition_permit_directory() -> Path:
    """Create the fixed root-only permit directory, but never repair metadata."""

    parent = TRANSITION_PERMITS_DIR.parent
    _validate_transition_permit_parent(parent)
    created = False
    try:
        TRANSITION_PERMITS_DIR.mkdir(mode=0o700)
        created = True
    except FileExistsError:
        pass
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_DIRECTORY_CREATE_FAILED") from error
    if created:
        try:
            os.chown(TRANSITION_PERMITS_DIR, 0, 0, follow_symlinks=False)
            fsync_dir(parent)
        except OSError as error:
            raise DeployError("TRANSITION_PERMIT_DIRECTORY_CREATE_FAILED") from error
    _validate_transition_permit_directory(TRANSITION_PERMITS_DIR)
    return TRANSITION_PERMITS_DIR


def _quarantine_transition_permit(destination: Path, guard: Path) -> None:
    """Durably tombstone a linked-but-failed permit without reopening its run ID."""

    try:
        destination_info = destination.lstat()
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED") from error
    try:
        guard_info = guard.lstat()
    except FileNotFoundError:
        guard_info = None
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED") from error
    if guard_info is not None:
        if (
            stat.S_ISREG(destination_info.st_mode)
            and stat.S_ISREG(guard_info.st_mode)
            and destination_info.st_dev == guard_info.st_dev
            and destination_info.st_ino == guard_info.st_ino
            and destination_info.st_nlink >= 2
            and guard_info.st_nlink >= 2
        ):
            try:
                fsync_dir(destination.parent)
            except OSError:
                pass
    else:
        try:
            os.link(destination, guard, follow_symlinks=False)
            fsync_dir(destination.parent)
        except OSError:
            pass

    if not hasattr(os, "O_NOFOLLOW"):
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED")
    descriptor: int | None = None
    try:
        descriptor = os.open(destination, os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_dev != destination_info.st_dev
            or info.st_ino != destination_info.st_ino
        ):
            raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED")
        os.fchmod(descriptor, 0o000)
        os.fsync(descriptor)
        tombstone_info = os.fstat(descriptor)
        if (
            tombstone_info.st_dev != destination_info.st_dev
            or tombstone_info.st_ino != destination_info.st_ino
            or stat.S_IMODE(tombstone_info.st_mode) != 0o000
        ):
            raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED")
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED") from error
    finally:
        if descriptor is not None:
            os.close(descriptor)
    try:
        current = destination.lstat()
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED") from error
    if (
        current.st_dev != destination_info.st_dev
        or current.st_ino != destination_info.st_ino
        or stat.S_IMODE(current.st_mode) != 0o000
    ):
        raise DeployError("TRANSITION_PERMIT_QUARANTINE_FAILED")


def _install_transition_permit(run_id: str, data: bytes, *, bundle: Bundle) -> Path:
    """Install one immutable permit with a hard-link no-overwrite commit."""

    if not RUN_ID_RE.fullmatch(run_id):
        raise DeployError("RUN_ID_INVALID")
    if len(data) > 1024 * 1024:
        raise DeployError("TRANSITION_PERMIT_TOO_LARGE")
    document = parse_canonical_json(data, "TRANSITION_PERMIT")
    directory = _ensure_transition_permit_directory()
    destination = directory / f"{run_id}.json"
    try:
        destination.lstat()
    except FileNotFoundError:
        pass
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_DESTINATION_UNAVAILABLE") from error
    else:
        raise DeployError("TRANSITION_PERMIT_ALREADY_EXISTS")

    temporary = directory / f".{run_id}.{secrets.token_hex(12)}.tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if not hasattr(os, "O_NOFOLLOW"):
        raise DeployError("TRANSITION_PERMIT_NOFOLLOW_UNAVAILABLE")
    flags |= os.O_NOFOLLOW
    descriptor: int | None = None
    linked = False
    installed = False
    try:
        try:
            descriptor = os.open(temporary, flags, 0o600)
        except OSError as error:
            raise DeployError("TRANSITION_PERMIT_TEMP_CREATE_FAILED") from error
        view = memoryview(data)
        while view:
            count = os.write(descriptor, view)
            if count <= 0:
                raise DeployError("TRANSITION_PERMIT_SHORT_WRITE")
            view = view[count:]
        os.fchown(descriptor, 0, 0)
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
        completed_descriptor = descriptor
        descriptor = None
        os.close(completed_descriptor)
        expected_digest = sha256_bytes(data)
        verified_temporary = verify_transition_permit(
            temporary,
            expected_digest,
            bundle=bundle,
            run_id=run_id,
        )
        if (
            verified_temporary.document != document
            or verified_temporary.digest != expected_digest
            or verified_temporary.path != temporary.absolute()
        ):
            raise DeployError("TRANSITION_PERMIT_PREPUBLICATION_ROUNDTRIP_MISMATCH")
        verify_regular_identity(
            temporary,
            expected_bytes=len(data),
            expected_digest=expected_digest,
        )
        # Persist the temporary directory entry before linking it into the
        # fixed destination. A crash in the link/unlink window must recover
        # both names (nlink=2), never a lone consumable destination.
        fsync_dir(directory)
        try:
            os.link(temporary, destination, follow_symlinks=False)
        except FileExistsError as error:
            raise DeployError("TRANSITION_PERMIT_ALREADY_EXISTS") from error
        except OSError as error:
            raise DeployError("TRANSITION_PERMIT_INSTALL_FAILED") from error
        linked = True
        fsync_dir(directory)
        verify_regular_identity(
            destination,
            expected_bytes=len(data),
            expected_digest=expected_digest,
            expected_nlink=2,
        )
        _validate_transition_permit_directory(directory)
        temporary.unlink()
        fsync_dir(directory)
        installed = True
        return destination
    except OSError as error:
        raise DeployError("TRANSITION_PERMIT_INSTALL_FAILED") from error
    finally:
        if descriptor is not None:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if linked and not installed:
            _quarantine_transition_permit(destination, temporary)
        elif not installed:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                pass
            else:
                try:
                    fsync_dir(directory)
                except OSError:
                    pass


def freeze_verified_file(source: Path, destination: Path, *, expected_bytes: int, expected_digest: str) -> tuple[int, str]:
    """Copy a verified external file into a root-only run directory without reopening it."""
    if destination.exists() or destination.is_symlink():
        raise DeployError("FROZEN_FILE_DESTINATION_EXISTS")
    source_flags = os.O_RDONLY | os.O_CLOEXEC
    destination_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        source_flags |= os.O_NOFOLLOW
        destination_flags |= os.O_NOFOLLOW
    temporary = destination.parent / f".{destination.name}.{secrets.token_hex(12)}.tmp"
    source_descriptor: int | None = None
    destination_descriptor: int | None = None
    installed = False
    try:
        source_descriptor = os.open(source, source_flags)
        before = os.fstat(source_descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or before.st_uid != 0
            or before.st_gid != 0
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_size != expected_bytes
        ):
            raise DeployError("FROZEN_SOURCE_METADATA_MISMATCH")
        destination_descriptor = os.open(temporary, destination_flags, 0o600)
        os.fchmod(destination_descriptor, 0o600)
        os.fchown(destination_descriptor, 0, 0)
        digest = hashlib.sha256()
        copied = 0
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            copied += len(chunk)
            view = memoryview(chunk)
            while view:
                count = os.write(destination_descriptor, view)
                if count <= 0:
                    raise DeployError("FROZEN_FILE_SHORT_WRITE")
                view = view[count:]
        after = os.fstat(source_descriptor)
        stable_fields = ("st_dev", "st_ino", "st_mode", "st_nlink", "st_uid", "st_gid", "st_size", "st_mtime_ns")
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            raise DeployError("FROZEN_SOURCE_CHANGED_DURING_COPY")
        frozen_digest = "sha256:" + digest.hexdigest()
        if copied != expected_bytes or frozen_digest != expected_digest:
            raise DeployError("FROZEN_SOURCE_IDENTITY_MISMATCH")
        os.fsync(destination_descriptor)
        os.close(destination_descriptor)
        destination_descriptor = None
        os.replace(temporary, destination)
        fsync_dir(destination.parent)
        installed = True
        verify_regular_identity(
            destination,
            expected_bytes=expected_bytes,
            expected_digest=expected_digest,
        )
        return copied, frozen_digest
    except OSError as error:
        raise DeployError("FROZEN_FILE_COPY_FAILED") from error
    finally:
        if source_descriptor is not None:
            os.close(source_descriptor)
        if destination_descriptor is not None:
            os.close(destination_descriptor)
        if not installed:
            temporary.unlink(missing_ok=True)


def _secure_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0:
        raise DeployError(f"DIRECTORY_UNSAFE_{path.name}")
    if stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)


def live_file(path: Path, mode: int) -> tuple[bytes, tuple[int, int, int]]:
    info = path.lstat()
    if (info.st_uid, info.st_gid) not in ((0, 0), (1000, 1000)) or stat.S_IMODE(info.st_mode) != mode:
        raise DeployError(f"LIVE_FILE_METADATA_MISMATCH_{path.name}")
    data = read_regular(path, expected_uid=info.st_uid, expected_gid=info.st_gid, expected_mode=mode)
    return data, (info.st_uid, info.st_gid, mode)


def render_env(original: bytes, image_tag: str) -> bytes:
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError as error:
        raise DeployError("LIVE_ENV_UTF8_INVALID") from error
    if "\x00" in text or "\r" in text:
        raise DeployError("LIVE_ENV_FORMAT_INVALID")
    lines = text.splitlines()
    indexes = [index for index, line in enumerate(lines) if re.match(r"^FLOWISE_IMAGE=", line)]
    if len(indexes) != 1:
        raise DeployError("FLOWISE_IMAGE_ASSIGNMENT_INVALID")
    lines[indexes[0]] = f"FLOWISE_IMAGE={image_tag}"
    return ("\n".join(lines) + "\n").encode()


def compose_args(env_path: Path, compose_path: Path, project_dir: Path) -> list[str]:
    return [
        "docker",
        "compose",
        "--project-name",
        "flowise",
        "--project-directory",
        str(project_dir),
        "--env-file",
        str(env_path),
        "-f",
        str(compose_path),
    ]


def compose_config(env_path: Path, compose_path: Path, project_dir: Path) -> dict[str, Any]:
    output = run_command(compose_args(env_path, compose_path, project_dir) + ["config", "--format", "json"], timeout=90)
    try:
        value = json.loads(output)
    except json.JSONDecodeError as error:
        raise DeployError("COMPOSE_CONFIG_JSON_INVALID") from error
    if not isinstance(value, dict):
        raise DeployError("COMPOSE_CONFIG_INVALID")
    return value


def compose_service_hash(env_path: Path, compose_path: Path, project_dir: Path) -> str:
    output = run_command(compose_args(env_path, compose_path, project_dir) + ["config", "--hash", "flowise"], timeout=90)
    tokens = output.decode("ascii", errors="ignore").split()
    candidates = [token for token in tokens if CONFIG_HASH_RE.fullmatch(token)]
    if len(candidates) != 1:
        raise DeployError("COMPOSE_SERVICE_HASH_INVALID")
    return candidates[0]


def service_environment(config: dict[str, Any]) -> dict[str, str]:
    try:
        environment = config["services"]["flowise"]["environment"]
    except (KeyError, TypeError) as error:
        raise DeployError("FLOWISE_ENVIRONMENT_MISSING") from error
    if not isinstance(environment, dict):
        raise DeployError("FLOWISE_ENVIRONMENT_INVALID")
    return {str(key): "" if value is None else str(value) for key, value in environment.items()}


def _candidate_runtime_expectations(candidate: dict[str, Any]) -> dict[str, Any]:
    try:
        flowise = candidate["services"]["flowise"]
    except (KeyError, TypeError) as error:
        raise DeployError("COMPOSE_RUNTIME_RESOURCE_MISSING") from error
    if (
        candidate.get("volumes") != EXPECTED_TOP_LEVEL_VOLUMES
        or candidate.get("networks") != EXPECTED_TOP_LEVEL_NETWORKS
        or flowise.get("networks") != {"flowise_network": None, "reverse_proxy_network": None}
    ):
        raise DeployError("COMPOSE_RUNTIME_RESOURCE_INVALID")
    return {
        "volume_name": EXPECTED_TOP_LEVEL_VOLUMES["flowise_data"]["name"],
        "network_names": sorted(network["name"] for network in EXPECTED_TOP_LEVEL_NETWORKS.values()),
    }


def validate_compose(candidate: dict[str, Any], rollback: dict[str, Any], candidate_tag: str, rollback_tag: str, key: bytes) -> None:
    try:
        candidate_flowise = candidate["services"]["flowise"]
        rollback_flowise = rollback["services"]["flowise"]
    except (KeyError, TypeError) as error:
        raise DeployError("COMPOSE_FLOWISE_SERVICE_MISSING") from error
    if set(candidate.get("services") or {}) != {"flowise", "postgres"} or set(rollback.get("services") or {}) != {
        "flowise",
        "postgres",
    }:
        raise DeployError("COMPOSE_SERVICE_SET_MISMATCH")
    if candidate_flowise.get("image") != candidate_tag or rollback_flowise.get("image") != rollback_tag:
        raise DeployError("COMPOSE_IMAGE_MISMATCH")
    if "build" in candidate_flowise or "build" in rollback_flowise:
        raise DeployError("COMPOSE_BUILD_FORBIDDEN")
    candidate_without_image = copy.deepcopy(candidate)
    rollback_without_image = copy.deepcopy(rollback)
    candidate_without_image["services"]["flowise"]["image"] = "__FLOWISE_RELEASE_IMAGE__"
    rollback_without_image["services"]["flowise"]["image"] = "__FLOWISE_RELEASE_IMAGE__"
    if candidate_without_image != rollback_without_image:
        raise DeployError("COMPOSE_NON_IMAGE_DRIFT")
    if set(candidate_flowise) != EXPECTED_FLOWISE_SERVICE_KEYS:
        raise DeployError("COMPOSE_FLOWISE_SERVICE_ALLOWLIST_MISMATCH")
    candidate_sidecars = {key_name: value for key_name, value in candidate.get("services", {}).items() if key_name != "flowise"}
    rollback_sidecars = {key_name: value for key_name, value in rollback.get("services", {}).items() if key_name != "flowise"}
    if candidate_sidecars != rollback_sidecars:
        raise DeployError("COMPOSE_SIDECAR_DRIFT")
    environment = service_environment(candidate)
    if environment.get("FLOWISE_SECRETKEY_OVERWRITE", "").encode() != key:
        raise DeployError("COMPOSE_KEY_CONTINUITY_MISMATCH")
    required_environment = {
        "ADMIN_ONLY_MODE": "true",
        "PUBLIC_LOGIN_ENABLED": "true",
        "SECURE_COOKIES": "true",
        "HTTP_SECURITY_CHECK": "true",
        "PATH_TRAVERSAL_SAFETY": "true",
        "CUSTOM_MCP_SECURITY_CHECK": "true",
        "OAUTH2_SECURITY_CHECK": "true",
        "DATABASE_REJECT_UNAUTHORIZED": "true",
        "CORS_ALLOW_CREDENTIALS": "false",
        "DISABLE_FLOWISE_TELEMETRY": "true",
        "SHOW_COMMUNITY_NODES": "false",
        "ALLOW_BUILTIN_DEP": "false",
    }
    if any(environment.get(name) != value for name, value in required_environment.items()):
        raise DeployError("COMPOSE_ADMIN_LOGIN_CONTRACT_MISMATCH")
    try:
        postgres_environment = candidate["services"]["postgres"]["environment"]
    except (KeyError, TypeError) as error:
        raise DeployError("COMPOSE_POSTGRES_ENVIRONMENT_MISSING") from error
    if not isinstance(postgres_environment, dict):
        raise DeployError("COMPOSE_POSTGRES_ENVIRONMENT_INVALID")
    database_contract = {
        "DATABASE_TYPE": "postgres",
        "DATABASE_HOST": "postgres",
        "DATABASE_PORT": "5432",
        "DATABASE_PATH": "/usr/src/flowise/.flowise",
        "DATABASE_SSL": "false",
        "DATABASE_REJECT_UNAUTHORIZED": "true",
    }
    if (
        {name for name in environment if name.startswith("DATABASE_")} != EXPECTED_DATABASE_ENVIRONMENT_KEYS
        or
        any(environment.get(name) != value for name, value in database_contract.items())
        or not environment.get("DATABASE_NAME")
        or not environment.get("DATABASE_USER")
        or environment.get("DATABASE_NAME") != str(postgres_environment.get("POSTGRES_DB", ""))
        or environment.get("DATABASE_USER") != str(postgres_environment.get("POSTGRES_USER", ""))
        or environment.get("DATABASE_PASSWORD") != str(postgres_environment.get("POSTGRES_PASSWORD", ""))
    ):
        raise DeployError("COMPOSE_DATABASE_IDENTITY_MISMATCH")
    security = [str(item) for item in candidate_flowise.get("security_opt") or []]
    if security != ["no-new-privileges:true", "seccomp=./docker/seccomp/chromium.json"]:
        raise DeployError("COMPOSE_SECURITY_OPT_ALLOWLIST_MISMATCH")
    if (
        candidate_flowise.get("read_only") is not True
        or str(candidate_flowise.get("user")) != "1000:1000"
        or candidate_flowise.get("init") is not True
        or candidate_flowise.get("cap_drop") != ["ALL"]
        or candidate_flowise.get("pids_limit") != 512
        or candidate_flowise.get("restart") != "always"
        or candidate_flowise.get("container_name") != FLOWISE_CONTAINER
        or candidate_flowise.get("command") is not None
        or candidate_flowise.get("entrypoint") is not None
    ):
        raise DeployError("COMPOSE_RUNTIME_HARDENING_MISMATCH")
    if candidate_flowise.get("tmpfs") != list(EXPECTED_TMPFS):
        raise DeployError("COMPOSE_TMPFS_ALLOWLIST_MISMATCH")
    if (
        candidate_flowise.get("depends_on") != {"postgres": {"condition": "service_healthy", "required": True}}
        or candidate_flowise.get("deploy") != EXPECTED_FLOWISE_DEPLOY
        or candidate_flowise.get("healthcheck") != EXPECTED_FLOWISE_HEALTHCHECK
        or candidate_flowise.get("logging") != EXPECTED_FLOWISE_LOGGING
    ):
        raise DeployError("COMPOSE_NESTED_RUNTIME_CONTRACT_MISMATCH")
    if candidate_flowise.get("ports") != [
        {"mode": "ingress", "host_ip": "172.20.0.1", "target": 3000, "published": "3000", "protocol": "tcp"}
    ]:
        raise DeployError("COMPOSE_PORT_ALLOWLIST_MISMATCH")
    if candidate_flowise.get("volumes") != [
        {"type": "volume", "source": "flowise_data", "target": "/usr/src/flowise/.flowise", "volume": {}}
    ]:
        raise DeployError("COMPOSE_VOLUME_ALLOWLIST_MISMATCH")
    _candidate_runtime_expectations(candidate)


def validate_hardened_compose(config: dict[str, Any], image_tag: str, key: bytes) -> None:
    """Apply the existing candidate contract without comparing to a legacy rollback config."""

    reference = copy.deepcopy(config)
    validate_compose(config, reference, image_tag, image_tag, key)


def _environment_from_entries(entries: Any, label: str) -> dict[str, str]:
    if not isinstance(entries, list):
        raise DeployError(f"{label}_ENVIRONMENT_INVALID")
    result: dict[str, str] = {}
    for entry in entries:
        if not isinstance(entry, str):
            raise DeployError(f"{label}_ENVIRONMENT_INVALID")
        key, separator, value = entry.partition("=")
        if not separator or not ENV_KEY_RE.fullmatch(key):
            raise DeployError(f"{label}_ENVIRONMENT_INVALID")
        if key in result:
            raise DeployError(f"{label}_ENVIRONMENT_DUPLICATE_KEY")
        result[key] = value
    return result


def expected_container_environment(
    image_environment: dict[str, str],
    compose_environment: dict[str, str],
) -> dict[str, str]:
    if any(not ENV_KEY_RE.fullmatch(key) or not isinstance(value, str) for key, value in image_environment.items()):
        raise DeployError("IMAGE_ENVIRONMENT_INVALID")
    if any(not ENV_KEY_RE.fullmatch(key) or not isinstance(value, str) for key, value in compose_environment.items()):
        raise DeployError("COMPOSE_ENVIRONMENT_INVALID")
    return {**image_environment, **compose_environment}


def runtime_environment_binding(environment: dict[str, str], key: bytes) -> dict[str, Any]:
    if len(key) != 32:
        raise DeployError("RUNTIME_ENVIRONMENT_BINDING_KEY_INVALID")
    if any(not ENV_KEY_RE.fullmatch(name) or not isinstance(value, str) for name, value in environment.items()):
        raise DeployError("RUNTIME_ENVIRONMENT_BINDING_INPUT_INVALID")
    return {
        "runtime_environment_keys": sorted(environment),
        "runtime_environment_hmac_sha256": "sha256:"
        + hmac.new(key, canonical_json(environment), hashlib.sha256).hexdigest(),
    }


def _validate_runtime_environment_binding(
    metadata: dict[str, Any],
    environment: dict[str, str],
    key: bytes,
    label: str,
) -> None:
    keys = metadata.get("runtime_environment_keys")
    keyed_digest = metadata.get("runtime_environment_hmac_sha256")
    actual = runtime_environment_binding(environment, key)
    if (
        not isinstance(keys, list)
        or any(not isinstance(name, str) or not ENV_KEY_RE.fullmatch(name) for name in keys)
        or keys != sorted(set(keys))
        or not isinstance(keyed_digest, str)
        or not DIGEST_RE.fullmatch(keyed_digest)
        or actual["runtime_environment_keys"] != keys
        or not hmac.compare_digest(actual["runtime_environment_hmac_sha256"], keyed_digest)
    ):
        raise DeployError(f"{label}_RUNTIME_ENVIRONMENT_BINDING_MISMATCH")


def _image_config_digest(document: dict[str, Any]) -> str:
    descriptor = document.get("Descriptor") or {}
    annotations = descriptor.get("annotations") or descriptor.get("Annotations") or {}
    candidate = annotations.get("config.digest") or document.get("Id")
    if not isinstance(candidate, str) or not DIGEST_RE.fullmatch(candidate):
        raise DeployError("IMAGE_CONFIG_DIGEST_MISSING")
    return candidate


def inspect_image(
    image_tag: str,
    expected_digest: str | None = None,
    expected_revision: str | None = None,
    expected_repository_url: str | None = None,
) -> dict[str, Any]:
    try:
        document = json.loads(run_command(["docker", "image", "inspect", image_tag], timeout=60))[0]
    except (json.JSONDecodeError, IndexError, TypeError) as error:
        raise DeployError("IMAGE_INSPECT_INVALID") from error
    config = document.get("Config") or {}
    labels = config.get("Labels") or {}
    image_environment = _environment_from_entries(config.get("Env") or [], "IMAGE")
    digest = _image_config_digest(document)
    if expected_digest is not None and digest != expected_digest:
        raise DeployError("IMAGE_CONFIG_DIGEST_MISMATCH")
    if (
        document.get("Os") != "linux"
        or document.get("Architecture") != "amd64"
        or config.get("User") != "node"
        or config.get("WorkingDir") != "/usr/src/flowise"
        or config.get("Cmd") != ["node", "packages/server/bin/run", "start"]
    ):
        raise DeployError("IMAGE_RUNTIME_CONTRACT_MISMATCH")
    if expected_revision is not None and labels.get("org.opencontainers.image.revision") != expected_revision:
        raise DeployError("IMAGE_REVISION_LABEL_MISMATCH")
    if expected_revision is not None and (
        labels.get("org.opencontainers.image.version") != f"git-{expected_revision}"
        or not isinstance(labels.get("org.opencontainers.image.source"), str)
        or not labels.get("org.opencontainers.image.source")
        or not _valid_timestamp(labels.get("org.opencontainers.image.created"))
    ):
        raise DeployError("IMAGE_OCI_LABEL_CONTRACT_MISMATCH")
    if expected_repository_url is not None and labels.get("org.opencontainers.image.source") != expected_repository_url:
        raise DeployError("IMAGE_SOURCE_LABEL_MISMATCH")
    return {
        "image_tag": image_tag,
        "image_config_digest": digest,
        "revision": labels.get("org.opencontainers.image.revision"),
        "release_id": labels.get("org.opencontainers.image.version"),
        "repository_url": labels.get("org.opencontainers.image.source"),
        "created_at": labels.get("org.opencontainers.image.created"),
        "image_environment": image_environment,
    }


def inspect_containers() -> dict[str, dict[str, Any]]:
    try:
        documents = json.loads(run_command(["docker", "inspect", *MANAGED_CONTAINERS], timeout=45))
    except json.JSONDecodeError as error:
        raise DeployError("CONTAINER_INSPECT_INVALID") from error
    result = {str(item.get("Name", "")).lstrip("/"): item for item in documents if isinstance(item, dict)}
    if set(result) != set(MANAGED_CONTAINERS):
        raise DeployError("CONTAINER_SET_MISMATCH")
    return result


def inspect_legacy_recovery_containers() -> dict[str, dict[str, Any]]:
    """Inspect exact sidecars while treating a proven-absent Flowise as data.

    A force-recreate can leave the Flowise container absent.  The generic
    inspector intentionally rejects that shape, so recovery first binds the two
    mandatory sidecars and then distinguishes a genuinely absent Flowise name
    from an inspect/daemon failure.
    """

    try:
        sidecar_documents = json.loads(
            run_command(["docker", "inspect", POSTGRES_CONTAINER, NGINX_CONTAINER], timeout=45)
        )
    except (json.JSONDecodeError, TypeError) as error:
        raise DeployError("LEGACY_RECOVERY_SIDECAR_INSPECT_INVALID") from error
    if not isinstance(sidecar_documents, list):
        raise DeployError("LEGACY_RECOVERY_SIDECAR_INSPECT_INVALID")
    result = {
        str(item.get("Name", "")).lstrip("/"): item
        for item in sidecar_documents
        if isinstance(item, dict)
    }
    if len(sidecar_documents) != 2 or set(result) != {POSTGRES_CONTAINER, NGINX_CONTAINER}:
        raise DeployError("LEGACY_RECOVERY_SIDECAR_SET_MISMATCH")
    try:
        flowise_documents = json.loads(
            run_command(["docker", "inspect", FLOWISE_CONTAINER], timeout=45)
        )
    except DeployError as inspect_error:
        # A second, successful daemon query must prove that the exact name is
        # absent.  Any daemon/list failure propagates and cannot authorize a
        # recovery write.
        listing = run_command(
            [
                "docker",
                "container",
                "ls",
                "-a",
                "--filter",
                f"name=^/{FLOWISE_CONTAINER}$",
                "--format",
                "{{.Names}}",
            ],
            timeout=45,
        )
        if listing.strip():
            raise DeployError("LEGACY_RECOVERY_FLOWISE_INSPECT_FAILED") from inspect_error
        return result
    except (json.JSONDecodeError, TypeError) as error:
        raise DeployError("LEGACY_RECOVERY_FLOWISE_INSPECT_INVALID") from error
    if (
        not isinstance(flowise_documents, list)
        or len(flowise_documents) != 1
        or not isinstance(flowise_documents[0], dict)
        or str(flowise_documents[0].get("Name", "")).lstrip("/") != FLOWISE_CONTAINER
    ):
        raise DeployError("LEGACY_RECOVERY_FLOWISE_INSPECT_INVALID")
    result[FLOWISE_CONTAINER] = flowise_documents[0]
    return result


def _container_env(document: dict[str, Any]) -> dict[str, str]:
    return _environment_from_entries((document.get("Config") or {}).get("Env") or [], "CONTAINER")


def validate_database_runtime_identity(config: dict[str, Any], documents: dict[str, dict[str, Any]]) -> None:
    """Bind Flowise's database connection to the fingerprinted PostgreSQL sidecar."""

    flowise_environment = service_environment(config)
    try:
        postgres_service_environment = config["services"]["postgres"]["environment"]
        postgres_document = documents[POSTGRES_CONTAINER]
        flowise_document = documents[FLOWISE_CONTAINER]
    except (KeyError, TypeError) as error:
        raise DeployError("DATABASE_RUNTIME_IDENTITY_MISSING") from error
    if not isinstance(postgres_service_environment, dict):
        raise DeployError("DATABASE_RUNTIME_IDENTITY_INVALID")
    if {key for key in flowise_environment if key.startswith("DATABASE_")} != EXPECTED_DATABASE_ENVIRONMENT_KEYS:
        raise DeployError("DATABASE_RUNTIME_FLOWISE_ENVIRONMENT_MISMATCH")
    flowise_runtime_environment = _container_env(flowise_document)
    expected_flowise_database_environment = {
        key: flowise_environment[key] for key in EXPECTED_DATABASE_ENVIRONMENT_KEYS
    }
    actual_flowise_database_environment = {
        key: value for key, value in flowise_runtime_environment.items() if key.startswith("DATABASE_")
    }
    if actual_flowise_database_environment != expected_flowise_database_environment:
        raise DeployError("DATABASE_RUNTIME_FLOWISE_ENVIRONMENT_MISMATCH")
    postgres_runtime_environment = _container_env(postgres_document)
    expected_postgres_environment = {
        "PGDATA": "/var/lib/postgresql/data/pgdata",
        "POSTGRES_DB": flowise_environment.get("DATABASE_NAME"),
        "POSTGRES_USER": flowise_environment.get("DATABASE_USER"),
        "POSTGRES_PASSWORD": flowise_environment.get("DATABASE_PASSWORD"),
    }
    if (
        flowise_environment.get("DATABASE_TYPE") != "postgres"
        or flowise_environment.get("DATABASE_HOST") != "postgres"
        or flowise_environment.get("DATABASE_PORT") != "5432"
        or flowise_environment.get("DATABASE_SSL") != "false"
        or flowise_environment.get("DATABASE_REJECT_UNAUTHORIZED") != "true"
        or any(not value for value in expected_postgres_environment.values())
        or {str(key): "" if value is None else str(value) for key, value in postgres_service_environment.items()}
        != expected_postgres_environment
        or any(postgres_runtime_environment.get(key) != value for key, value in expected_postgres_environment.items())
    ):
        raise DeployError("DATABASE_RUNTIME_ENVIRONMENT_MISMATCH")

    expected_network = EXPECTED_TOP_LEVEL_NETWORKS["flowise_network"]["name"]
    postgres_networks = (postgres_document.get("NetworkSettings") or {}).get("Networks") or {}
    flowise_networks = (flowise_document.get("NetworkSettings") or {}).get("Networks") or {}
    if set(postgres_networks) != {expected_network} or expected_network not in flowise_networks:
        raise DeployError("DATABASE_RUNTIME_NETWORK_MISMATCH")
    postgres_endpoint = postgres_networks[expected_network]
    flowise_endpoint = flowise_networks[expected_network]
    if not isinstance(postgres_endpoint, dict) or not isinstance(flowise_endpoint, dict):
        raise DeployError("DATABASE_RUNTIME_NETWORK_IDENTITY_INVALID")
    aliases = {
        str(value)
        for key in ("Aliases", "DNSNames")
        for value in (postgres_endpoint.get(key) or [])
        if isinstance(value, str)
    }
    network_id = postgres_endpoint.get("NetworkID")
    if not network_id or flowise_endpoint.get("NetworkID") != network_id or "postgres" not in aliases:
        raise DeployError("DATABASE_RUNTIME_NETWORK_IDENTITY_MISMATCH")


def observe_runtime_network_identity(
    documents: dict[str, dict[str, Any]],
) -> dict[str, dict[str, str]]:
    """Return only the exact, non-secret network names and IDs."""

    internal_name = EXPECTED_TOP_LEVEL_NETWORKS["flowise_network"]["name"]
    proxy_name = EXPECTED_TOP_LEVEL_NETWORKS["reverse_proxy_network"]["name"]
    try:
        flowise_networks = documents[FLOWISE_CONTAINER]["NetworkSettings"]["Networks"]
        internal_id = flowise_networks[internal_name]["NetworkID"]
        proxy_id = flowise_networks[proxy_name]["NetworkID"]
    except (KeyError, TypeError) as error:
        raise DeployError("RUNTIME_NETWORK_ATTACHMENTS_MISSING") from error
    observed = {
        "flowise_internal": {"name": internal_name, "network_id": internal_id},
        "reverse_proxy": {"name": proxy_name, "network_id": proxy_id},
    }
    return validate_runtime_network_identity(documents, observed)


def validate_runtime_network_identity(
    documents: dict[str, dict[str, Any]],
    expected_identity: dict[str, Any],
) -> dict[str, dict[str, str]]:
    """Bind both Flowise attachments to the exact unchanged sidecar networks."""

    expected = _validate_network_identity_binding(expected_identity, "RUNTIME_NETWORK_IDENTITY")
    try:
        flowise_networks = documents[FLOWISE_CONTAINER]["NetworkSettings"]["Networks"]
        postgres_networks = documents[POSTGRES_CONTAINER]["NetworkSettings"]["Networks"]
        nginx_networks = documents[NGINX_CONTAINER]["NetworkSettings"]["Networks"]
    except (KeyError, TypeError) as error:
        raise DeployError("RUNTIME_NETWORK_ATTACHMENTS_MISSING") from error
    if not all(isinstance(value, dict) for value in (flowise_networks, postgres_networks, nginx_networks)):
        raise DeployError("RUNTIME_NETWORK_ATTACHMENTS_INVALID")
    internal_name = expected["flowise_internal"]["name"]
    proxy_name = expected["reverse_proxy"]["name"]
    if (
        set(flowise_networks) != {internal_name, proxy_name}
        or set(postgres_networks) != {internal_name}
        or proxy_name not in nginx_networks
    ):
        raise DeployError("RUNTIME_NETWORK_ATTACHMENT_SET_MISMATCH")
    endpoints = {
        "flowise_internal": flowise_networks.get(internal_name),
        "postgres_internal": postgres_networks.get(internal_name),
        "flowise_proxy": flowise_networks.get(proxy_name),
        "nginx_proxy": nginx_networks.get(proxy_name),
    }
    if any(not isinstance(endpoint, dict) for endpoint in endpoints.values()):
        raise DeployError("RUNTIME_NETWORK_ENDPOINT_INVALID")
    identifiers = {
        role: endpoint.get("NetworkID")
        for role, endpoint in endpoints.items()
        if isinstance(endpoint, dict)
    }
    if any(not isinstance(value, str) or not DOCKER_ID_RE.fullmatch(value) for value in identifiers.values()):
        raise DeployError("RUNTIME_NETWORK_ID_INVALID")
    observed = {
        "flowise_internal": {
            "name": internal_name,
            "network_id": str(identifiers["flowise_internal"]),
        },
        "reverse_proxy": {
            "name": proxy_name,
            "network_id": str(identifiers["flowise_proxy"]),
        },
    }
    if (
        identifiers["flowise_internal"] != identifiers["postgres_internal"]
        or identifiers["flowise_proxy"] != identifiers["nginx_proxy"]
        or observed != expected
    ):
        raise DeployError("RUNTIME_NETWORK_IDENTITY_MISMATCH")
    return observed


def container_snapshot(documents: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name, document in documents.items():
        state = document.get("State") or {}
        health = state.get("Health") or {}
        config = document.get("Config") or {}
        labels = config.get("Labels") or {}
        host = document.get("HostConfig") or {}
        mounts = []
        for mount in document.get("Mounts") or []:
            mounts.append(
                {
                    "type": mount.get("Type"),
                    "name": mount.get("Name"),
                    "source": mount.get("Source"),
                    "destination": mount.get("Destination"),
                    "rw": mount.get("RW"),
                    "propagation": mount.get("Propagation"),
                }
            )
        networks = (document.get("NetworkSettings") or {}).get("Networks") or {}
        network_attachments = []
        for network_name, network in networks.items():
            network = network if isinstance(network, dict) else {}
            network_attachments.append(
                {
                    "name": str(network_name),
                    "network_id": network.get("NetworkID"),
                    "gateway": network.get("Gateway"),
                    "ip_prefix_len": network.get("IPPrefixLen"),
                }
            )
        result[name] = {
            "id": document.get("Id"),
            "image_id": document.get("Image"),
            "image_ref": config.get("Image"),
            "state": state.get("Status"),
            "health": health.get("Status", "none"),
            "restart_count": document.get("RestartCount"),
            "compose_config_hash": labels.get("com.docker.compose.config-hash"),
            "runtime": {
                "user": config.get("User"),
                "healthcheck": config.get("Healthcheck") or {},
                "readonly_rootfs": host.get("ReadonlyRootfs"),
                "init": host.get("Init"),
                "privileged": host.get("Privileged"),
                "cap_add": host.get("CapAdd") or [],
                "cap_drop": host.get("CapDrop") or [],
                "pids_limit": host.get("PidsLimit"),
                "memory": host.get("Memory"),
                "memory_reservation": host.get("MemoryReservation"),
                "nano_cpus": host.get("NanoCpus"),
                "pid_mode": host.get("PidMode") or "",
                "ipc_mode": host.get("IpcMode") or "",
                "userns_mode": host.get("UsernsMode") or "",
                "uts_mode": host.get("UTSMode") or "",
                "cgroupns_mode": host.get("CgroupnsMode") or "",
                "network_mode": host.get("NetworkMode") or "",
                "security_opt": host.get("SecurityOpt") or [],
                "devices": host.get("Devices") or [],
                "device_requests": host.get("DeviceRequests") or [],
                "binds": host.get("Binds") or [],
                "port_bindings": host.get("PortBindings") or {},
                "publish_all_ports": host.get("PublishAllPorts"),
                "restart_policy": host.get("RestartPolicy") or {},
                "log_config": host.get("LogConfig") or {},
                "tmpfs": host.get("Tmpfs") or {},
                "mounts": sorted(mounts, key=lambda item: (str(item["destination"]), str(item["type"]))),
                "networks": sorted(network_attachments, key=lambda item: item["name"]),
            },
        }
    return result


def validate_container_health(documents: dict[str, dict[str, Any]]) -> None:
    for name in MANAGED_CONTAINERS:
        state = documents[name].get("State") or {}
        health = (state.get("Health") or {}).get("Status", "none")
        if state.get("Status") != "running" or health != "healthy":
            raise DeployError(f"CONTAINER_NOT_HEALTHY_{name}")


def _hardened_runtime_stable_projection(flowise: dict[str, Any]) -> dict[str, Any]:
    runtime = container_snapshot({FLOWISE_CONTAINER: flowise})[FLOWISE_CONTAINER]["runtime"]
    healthcheck = copy.deepcopy(runtime["healthcheck"])
    if healthcheck.get("StartInterval") == 0:
        healthcheck.pop("StartInterval")
    volume_mounts = [mount for mount in runtime["mounts"] if mount.get("type") == "volume"]
    return {
        "user": runtime["user"],
        "healthcheck": healthcheck,
        "readonly_rootfs": runtime["readonly_rootfs"],
        "init": runtime["init"],
        "privileged": runtime["privileged"],
        "cap_add": runtime["cap_add"],
        "cap_drop": runtime["cap_drop"],
        "pids_limit": runtime["pids_limit"],
        "memory": runtime["memory"],
        "memory_reservation": runtime["memory_reservation"],
        "nano_cpus": runtime["nano_cpus"],
        "pid_mode": runtime["pid_mode"],
        "ipc_mode": runtime["ipc_mode"],
        "userns_mode": runtime["userns_mode"],
        "uts_mode": runtime["uts_mode"],
        "cgroupns_mode": runtime["cgroupns_mode"],
        "network_mode": runtime["network_mode"],
        "security_opt": runtime["security_opt"],
        "devices": runtime["devices"],
        "device_requests": runtime["device_requests"],
        "binds": runtime["binds"],
        "port_bindings": runtime["port_bindings"],
        "publish_all_ports": runtime["publish_all_ports"],
        "restart_policy": runtime["restart_policy"],
        "log_config": runtime["log_config"],
        "tmpfs": {
            path: sorted(str(options).split(","))
            for path, options in sorted(runtime["tmpfs"].items())
        },
        "volume_mounts": volume_mounts,
        "network_names": [item["name"] for item in runtime["networks"]],
    }


def _expected_hardened_runtime_stable_projection(expected_compose: dict[str, Any]) -> dict[str, Any]:
    expectations = _candidate_runtime_expectations(expected_compose)
    volume_name = expectations["volume_name"]
    return {
        "user": "1000:1000",
        "healthcheck": copy.deepcopy(EXPECTED_RUNTIME_HEALTHCHECK),
        "readonly_rootfs": True,
        "init": True,
        "privileged": False,
        "cap_add": [],
        "cap_drop": ["ALL"],
        "pids_limit": 512,
        "memory": 4_294_967_296,
        "memory_reservation": 2_147_483_648,
        "nano_cpus": 2_000_000_000,
        "pid_mode": "",
        "ipc_mode": "private",
        "userns_mode": "",
        "uts_mode": "",
        "cgroupns_mode": "private",
        "network_mode": EXPECTED_TOP_LEVEL_NETWORKS["flowise_network"]["name"],
        "security_opt": ["no-new-privileges", f"seccomp={LIVE_SECCOMP}"],
        "devices": [],
        "device_requests": [],
        "binds": [],
        "port_bindings": {"3000/tcp": [{"HostIp": "172.20.0.1", "HostPort": "3000"}]},
        "publish_all_ports": False,
        "restart_policy": {"Name": "always", "MaximumRetryCount": 0},
        "log_config": copy.deepcopy(EXPECTED_RUNTIME_LOG_CONFIG),
        "tmpfs": {
            path: sorted(options.split(","))
            for path, options in sorted(EXPECTED_TMPFS_BY_PATH.items())
        },
        "volume_mounts": [
            {
                "type": "volume",
                "name": volume_name,
                "source": f"/var/lib/docker/volumes/{volume_name}/_data",
                "destination": "/usr/src/flowise/.flowise",
                "rw": True,
                "propagation": "",
            }
        ],
        "network_names": expectations["network_names"],
    }


def validate_runtime(
    documents: dict[str, dict[str, Any]],
    *,
    image_tag: str,
    image_digest: str,
    expected_config_hash: str,
    expected_environment: dict[str, str],
    require_candidate_hardening: bool = False,
    require_exact_environment: bool = False,
    expected_compose: dict[str, Any] | None = None,
    expected_runtime: dict[str, Any] | None = None,
    expected_runtime_stable: dict[str, Any] | None = None,
) -> dict[str, Any]:
    validate_container_health(documents)
    flowise = documents[FLOWISE_CONTAINER]
    config = flowise.get("Config") or {}
    labels = config.get("Labels") or {}
    if config.get("Image") != image_tag or flowise.get("Image") != image_digest:
        raise DeployError("FLOWISE_RUNTIME_IMAGE_MISMATCH")
    if labels.get("com.docker.compose.config-hash") != expected_config_hash:
        raise DeployError("FLOWISE_RUNTIME_CONFIG_HASH_MISMATCH")
    actual_environment = _container_env(flowise)
    if (
        actual_environment != expected_environment
        if require_exact_environment
        else any(actual_environment.get(key) != value for key, value in expected_environment.items())
    ):
        raise DeployError("FLOWISE_RUNTIME_ENVIRONMENT_MISMATCH")
    expected_database_environment = {
        key: value for key, value in expected_environment.items() if key.startswith("DATABASE_")
    }
    actual_database_environment = {
        key: value for key, value in actual_environment.items() if key.startswith("DATABASE_")
    }
    if (
        set(expected_database_environment) != EXPECTED_DATABASE_ENVIRONMENT_KEYS
        or actual_database_environment != expected_database_environment
    ):
        raise DeployError("FLOWISE_RUNTIME_DATABASE_ENVIRONMENT_MISMATCH")
    host = flowise.get("HostConfig") or {}
    if (
        host.get("Privileged") is True
        or (host.get("CapAdd") or [])
        or (host.get("PidMode") or "") == "host"
        or (host.get("IpcMode") or "") == "host"
        or (host.get("NetworkMode") or "") == "host"
        or (host.get("UsernsMode") or "") not in ("", "private")
        or (host.get("UTSMode") or "") != ""
        or (host.get("CgroupnsMode") or "") not in ("", "private")
        or (host.get("Devices") or [])
        or (host.get("DeviceRequests") or [])
        or (host.get("Binds") or [])
    ):
        raise DeployError("FLOWISE_RUNTIME_DANGEROUS_CONFIGURATION")
    if require_candidate_hardening:
        if expected_compose is None:
            raise DeployError("FLOWISE_RUNTIME_EXPECTED_COMPOSE_MISSING")
        expectations = _candidate_runtime_expectations(expected_compose)
        security = host.get("SecurityOpt") or []
        if security != ["no-new-privileges", f"seccomp={LIVE_SECCOMP}"]:
            raise DeployError("FLOWISE_RUNTIME_SECURITY_OPT_MISMATCH")
        if (
            config.get("User") != "1000:1000"
            or host.get("ReadonlyRootfs") is not True
            or host.get("Init") is not True
            or host.get("CapDrop") != ["ALL"]
            or host.get("PidsLimit") != 512
            or host.get("Memory") != 4_294_967_296
            or host.get("MemoryReservation") != 2_147_483_648
            or host.get("NanoCpus") != 2_000_000_000
            or (host.get("PidMode") or "") != ""
            or host.get("IpcMode") != "private"
            or host.get("PublishAllPorts") is not False
            or (host.get("UsernsMode") or "") != ""
            or (host.get("UTSMode") or "") != ""
            or (host.get("CgroupnsMode") or "") != "private"
            or (host.get("RestartPolicy") or {}) != {"Name": "always", "MaximumRetryCount": 0}
            or (host.get("LogConfig") or {}) != EXPECTED_RUNTIME_LOG_CONFIG
        ):
            raise DeployError("FLOWISE_RUNTIME_HARDENING_MISMATCH")
        healthcheck = config.get("Healthcheck") or {}
        if any(healthcheck.get(key) != value for key, value in EXPECTED_RUNTIME_HEALTHCHECK.items()) or any(
            key not in EXPECTED_RUNTIME_HEALTHCHECK and not (key == "StartInterval" and value == 0)
            for key, value in healthcheck.items()
        ):
            raise DeployError("FLOWISE_RUNTIME_HEALTHCHECK_MISMATCH")
        expected_ports = {"3000/tcp": [{"HostIp": "172.20.0.1", "HostPort": "3000"}]}
        if (host.get("PortBindings") or {}) != expected_ports:
            raise DeployError("FLOWISE_RUNTIME_PORT_ALLOWLIST_MISMATCH")
        tmpfs = host.get("Tmpfs") or {}
        if set(tmpfs) != set(EXPECTED_TMPFS_BY_PATH) or any(
            set(str(tmpfs[path]).split(",")) != set(options.split(","))
            for path, options in EXPECTED_TMPFS_BY_PATH.items()
        ):
            raise DeployError("FLOWISE_RUNTIME_TMPFS_ALLOWLIST_MISMATCH")
        expected_networks = expectations["network_names"]
        actual_network_documents = (flowise.get("NetworkSettings") or {}).get("Networks") or {}
        actual_networks = sorted(str(name) for name in actual_network_documents)
        if actual_networks != expected_networks or host.get("NetworkMode") not in expected_networks:
            raise DeployError("FLOWISE_RUNTIME_NETWORK_ALLOWLIST_MISMATCH")
        if any(
            not isinstance(actual_network_documents[name], dict)
            or not actual_network_documents[name].get("NetworkID")
            or not actual_network_documents[name].get("Gateway")
            or not isinstance(actual_network_documents[name].get("IPPrefixLen"), int)
            for name in expected_networks
        ):
            raise DeployError("FLOWISE_RUNTIME_NETWORK_IDENTITY_MISMATCH")
        mounts = flowise.get("Mounts") or []
        volume_mounts = [mount for mount in mounts if mount.get("Type") == "volume"]
        other_mounts = [mount for mount in mounts if mount.get("Type") != "volume"]
        if (
            len(volume_mounts) != 1
            or volume_mounts[0].get("Name") != expectations["volume_name"]
            or volume_mounts[0].get("Source")
            != f"/var/lib/docker/volumes/{expectations['volume_name']}/_data"
            or volume_mounts[0].get("Destination") != "/usr/src/flowise/.flowise"
            or volume_mounts[0].get("RW") is not True
            or volume_mounts[0].get("Driver") != "local"
            or volume_mounts[0].get("Mode") != "rw"
            or (volume_mounts[0].get("Propagation") or "") != ""
            or any(
                mount.get("Type") != "tmpfs" or mount.get("Destination") not in EXPECTED_TMPFS_BY_PATH
                for mount in other_mounts
            )
        ):
            raise DeployError("FLOWISE_RUNTIME_MOUNT_ALLOWLIST_MISMATCH")
        if expected_runtime is not None and expected_runtime_stable is not None:
            raise DeployError("FLOWISE_RUNTIME_BASELINE_AMBIGUOUS")
        if expected_runtime is None and expected_runtime_stable is None:
            raise DeployError("FLOWISE_RUNTIME_BASELINE_MISSING")
        if expected_runtime is not None:
            actual_runtime = container_snapshot({FLOWISE_CONTAINER: flowise})[FLOWISE_CONTAINER]["runtime"]
            runtime_matches = actual_runtime == expected_runtime
        else:
            runtime_matches = _hardened_runtime_stable_projection(flowise) == expected_runtime_stable
        if not runtime_matches:
            raise DeployError("FLOWISE_RUNTIME_BASELINE_DRIFT")
    return {
        "runtime_image_verified": True,
        "runtime_config_hash": expected_config_hash,
        "runtime_environment_verified": True,
        "runtime_environment_key_count": len(expected_environment),
        "runtime_hardening_verified": require_candidate_hardening,
    }


def runtime_projection_digest(documents: dict[str, dict[str, Any]]) -> str:
    try:
        projection = container_snapshot(documents)[FLOWISE_CONTAINER]["runtime"]
    except (KeyError, TypeError) as error:
        raise DeployError("FLOWISE_RUNTIME_PROJECTION_MISSING") from error
    return sha256_bytes(canonical_json(projection))


def validate_legacy_runtime(
    documents: dict[str, dict[str, Any]],
    *,
    image_tag: str,
    image_digest: str,
    expected_config_hash: str,
    expected_environment: dict[str, str],
    expected_runtime_projection_digest: str,
) -> dict[str, Any]:
    """Validate the exact permitted legacy runtime without a general bypass."""

    runtime = validate_runtime(
        documents,
        image_tag=image_tag,
        image_digest=image_digest,
        expected_config_hash=expected_config_hash,
        expected_environment=expected_environment,
        require_candidate_hardening=False,
        require_exact_environment=True,
    )
    projection_digest = runtime_projection_digest(documents)
    if projection_digest != expected_runtime_projection_digest:
        raise DeployError("LEGACY_RUNTIME_PROJECTION_MISMATCH")
    return {**runtime, "runtime_projection_digest": projection_digest, "runtime_policy": "legacy_frozen_v1"}


def validate_bootstrap_hardened_runtime(
    documents: dict[str, dict[str, Any]],
    *,
    image_tag: str,
    image_digest: str,
    expected_config_hash: str,
    expected_environment: dict[str, str],
    expected_compose: dict[str, Any],
    expected_network_identity: dict[str, Any],
) -> dict[str, Any]:
    """Apply the unchanged hardening contract to the newly recreated baseline."""

    expected_runtime_stable = _expected_hardened_runtime_stable_projection(expected_compose)
    runtime = validate_runtime(
        documents,
        image_tag=image_tag,
        image_digest=image_digest,
        expected_config_hash=expected_config_hash,
        expected_environment=expected_environment,
        require_candidate_hardening=True,
        require_exact_environment=True,
        expected_compose=expected_compose,
        expected_runtime_stable=expected_runtime_stable,
    )
    projection = _hardened_runtime_stable_projection(documents[FLOWISE_CONTAINER])
    network_identity = validate_runtime_network_identity(documents, expected_network_identity)
    return {
        **runtime,
        "runtime_projection_digest": sha256_bytes(canonical_json(projection)),
        "runtime_network_identity": network_identity,
    }


def persistent_key() -> bytes:
    data = read_regular(PERSISTENT_KEY, maximum=128, expected_uid=1000, expected_gid=1000, expected_mode=0o600)
    if len(data) != 32 or b"\x00" in data or b"\n" in data or b"\r" in data:
        raise DeployError("PERSISTENT_KEY_CONTRACT_MISMATCH")
    return data


def validate_key_continuity(documents: dict[str, dict[str, Any]], expected_environment: dict[str, str], key: bytes) -> None:
    active = _container_env(documents[FLOWISE_CONTAINER]).get("FLOWISE_SECRETKEY_OVERWRITE", "").encode()
    resolved = expected_environment.get("FLOWISE_SECRETKEY_OVERWRITE", "").encode()
    if active != key or resolved != key:
        raise DeployError("ENCRYPTION_KEY_CONTINUITY_MISMATCH")


def database_state(*, include_name_digest: bool = False) -> dict[str, Any]:
    sql = b"""
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '3s';
SELECT 'transaction_read_only' || E'\\t' || current_setting('transaction_read_only');
SELECT 'migration' || E'\\t' || timestamp::bigint::text || E'\\t' || name
FROM public.migrations ORDER BY timestamp::bigint, name COLLATE \"C\";
ROLLBACK;
"""
    output = run_command(
        [
            "docker",
            "exec",
            "-i",
            POSTGRES_CONTAINER,
            "sh",
            "-eu",
            "-c",
            'export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000"; '
            'exec psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
        ],
        input_data=sql,
        timeout=45,
    ).decode("utf-8").splitlines()
    read_only = False
    migrations: list[tuple[int, str]] = []
    for line in output:
        parts = line.split("\t")
        if parts == ["transaction_read_only", "on"]:
            read_only = True
        elif len(parts) == 3 and parts[0] == "migration" and parts[1].isdigit():
            migrations.append((int(parts[1]), parts[2]))
        else:
            raise DeployError("DATABASE_FINGERPRINT_OUTPUT_INVALID")
    if not read_only or not migrations or migrations != sorted(migrations, key=lambda item: (item[0], item[1].encode())):
        raise DeployError("DATABASE_READ_ONLY_FINGERPRINT_INVALID")
    payload = "".join(f"{timestamp}\t{name}\n" for timestamp, name in migrations).encode()
    names = "".join(f"{name}\n" for _, name in migrations).encode()
    result = {
        "transaction_read_only": True,
        "migration_count": len(migrations),
        "migration_sha256": sha256_bytes(payload),
    }
    if include_name_digest:
        result["migration_name_sha256"] = sha256_bytes(names)
    return result


MIGRATION_INVENTORY_SCRIPT = r"""
const { postgresMigrations } = require('./packages/server/dist/database/migrations/postgres');
if (!Array.isArray(postgresMigrations) || postgresMigrations.length === 0) process.exit(31);
const rows = postgresMigrations.map((Migration) => {
  const name = Migration && Migration.name;
  const match = typeof name === 'string' && name.match(/([0-9]{13})$/);
  if (!match) process.exit(32);
  return { timestamp: Number(match[1]), name };
});
rows.sort((left, right) => left.timestamp - right.timestamp || Buffer.from(left.name).compare(Buffer.from(right.name)));
if (new Set(rows.map((row) => `${row.timestamp}\t${row.name}`)).size !== rows.length) process.exit(33);
process.stdout.write(JSON.stringify(rows));
""".strip()


def candidate_migration_inventory(image_tag: str, seccomp_path: Path) -> dict[str, Any]:
    """Read migration metadata from an isolated candidate without DB credentials or networking."""
    name = f"flowise-migration-inventory-{secrets.token_hex(8)}"
    args = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--security-opt",
        f"seccomp={seccomp_path}",
        "--user",
        "1000:1000",
        "--pids-limit",
        "512",
        "--log-driver",
        "none",
        "--entrypoint",
        "node",
        image_tag,
        "-e",
        MIGRATION_INVENTORY_SCRIPT,
    ]
    try:
        output = run_command(args, timeout=120)
    finally:
        # --rm normally removes it.  A timeout or daemon interruption must not
        # leave a stopped/running candidate with a reusable name.
        try:
            subprocess.run(
                ["docker", "rm", "-f", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                env=SAFE_ENV,
                timeout=30,
            )
            residue = subprocess.run(
                ["docker", "container", "ls", "-aq", "--filter", f"name=^/{name}$"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
                env=SAFE_ENV,
                timeout=30,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise DeployError("MIGRATION_INVENTORY_CLEANUP_UNVERIFIED") from error
        if residue.returncode != 0:
            raise DeployError("MIGRATION_INVENTORY_CLEANUP_UNVERIFIED")
        if residue.stdout.strip():
            raise DeployError("MIGRATION_INVENTORY_CONTAINER_RESIDUE")
    try:
        rows = json.loads(output.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise DeployError("CANDIDATE_MIGRATION_INVENTORY_INVALID") from error
    if not isinstance(rows, list) or not rows:
        raise DeployError("CANDIDATE_MIGRATION_INVENTORY_INVALID")
    migrations: list[tuple[int, str]] = []
    for row in rows:
        exact_keys(row, ("timestamp", "name"), "CANDIDATE_MIGRATION")
        timestamp, migration_name = row.get("timestamp"), row.get("name")
        if (
            not isinstance(timestamp, int)
            or isinstance(timestamp, bool)
            or not 1_000_000_000_000 <= timestamp <= 9_999_999_999_999
            or not isinstance(migration_name, str)
            or not re.search(rf"{timestamp}\Z", migration_name)
        ):
            raise DeployError("CANDIDATE_MIGRATION_INVENTORY_INVALID")
        migrations.append((timestamp, migration_name))
    expected_order = sorted(migrations, key=lambda item: (item[0], item[1].encode()))
    if migrations != expected_order or len(set(migrations)) != len(migrations):
        raise DeployError("CANDIDATE_MIGRATION_INVENTORY_ORDER_INVALID")
    payload = "".join(f"{timestamp}\t{name}\n" for timestamp, name in migrations).encode()
    return {"migration_count": len(migrations), "migration_sha256": sha256_bytes(payload)}


def migration_gate(image_tag: str, seccomp_path: Path, database: dict[str, Any]) -> dict[str, Any]:
    inventory = candidate_migration_inventory(image_tag, seccomp_path)
    if database.get("transaction_read_only") is not True:
        raise DeployError("MIGRATION_GATE_DATABASE_NOT_READ_ONLY")
    if (
        inventory["migration_count"] != database.get("migration_count")
        or inventory["migration_sha256"] != database.get("migration_sha256")
    ):
        raise DeployError("CANDIDATE_PRODUCTION_MIGRATION_MISMATCH")
    return {
        "candidate_migration_count": inventory["migration_count"],
        "candidate_migration_sha256": inventory["migration_sha256"],
        "production_migration_count": database["migration_count"],
        "production_migration_sha256": database["migration_sha256"],
        "production_transaction_read_only": True,
        "pending_migrations": 0,
        "candidate_network": "none",
        "candidate_database_credentials_supplied": False,
    }


def runtime_pings() -> None:
    if run_command(["curl", "-fsS", "--max-time", "10", PRIVATE_PING], timeout=20).strip() != b"pong":
        raise DeployError("PRIVATE_PING_FAILED")
    if run_command(["docker", "exec", NGINX_CONTAINER, "wget", "-qO-", PRIVATE_PING], timeout=20).strip() != b"pong":
        raise DeployError("PROXY_PING_FAILED")
    if run_command(["curl", "-fsS", "--max-time", "15", f"{PUBLIC_ORIGIN}/api/v1/ping"], timeout=30).strip() != b"pong":
        raise DeployError("PUBLIC_PING_FAILED")


def _create_run_dir(run_id: str) -> Path:
    if not RUN_ID_RE.fullmatch(run_id):
        raise DeployError("RUN_ID_INVALID")
    _secure_directory(RUNS_DIR)
    run_dir = RUNS_DIR / run_id
    try:
        run_dir.mkdir(mode=0o700)
    except FileExistsError as error:
        raise DeployError("RUN_DIRECTORY_EXISTS") from error
    _secure_directory(run_dir)
    return run_dir


def _write_staged_tree(root: Path, env: bytes, compose: bytes, seccomp: bytes | None) -> dict[str, Any]:
    _secure_directory(root)
    # Keep the complete role path chain present even for an intentionally
    # absent seccomp file, so every later staged/archive read can authenticate
    # the same root-owned, non-symlink directory ancestry.
    _secure_directory(root / "docker")
    _secure_directory(root / "docker/seccomp")
    atomic_write(root / ".env.production", env, 0o600)
    atomic_write(root / "docker-compose.prod.yml", compose, 0o600)
    if seccomp is not None:
        atomic_write(root / "docker/seccomp/chromium.json", seccomp, 0o600)
    return {
        "env": sha256_bytes(env),
        "compose": sha256_bytes(compose),
        "seccomp": {"present": seccomp is not None, "digest": sha256_bytes(seccomp) if seccomp is not None else None},
    }


def _terminate_and_reap(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    try:
        running = process.poll() is None
    except Exception:
        running = True
    if running:
        try:
            process.terminate()
        except Exception:
            pass
    try:
        process.wait(timeout=5)
        return
    except Exception:
        pass
    try:
        process.kill()
    except Exception:
        pass
    try:
        process.wait(timeout=5)
    except Exception as error:
        raise DeployError("ROLLBACK_ARCHIVE_PROCESS_REAP_FAILED") from error


def _reap_pipeline(*processes: subprocess.Popen[bytes] | None) -> None:
    failed = False
    for process in processes:
        try:
            _terminate_and_reap(process)
        except DeployError:
            failed = True
    if failed:
        raise DeployError("ROLLBACK_ARCHIVE_PROCESS_REAP_FAILED")


def save_rollback_archive(image_tag: str, output_path: Path) -> tuple[int, str]:
    temporary = output_path.parent / f".{output_path.name}.{secrets.token_hex(12)}.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    os.fchmod(descriptor, 0o600)
    completed = False
    docker: subprocess.Popen[bytes] | None = None
    gzip_process: subprocess.Popen[bytes] | None = None
    try:
        docker = subprocess.Popen(
            ["docker", "save", image_tag], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=SAFE_ENV
        )
        if docker.stdout is None:
            raise DeployError("ROLLBACK_ARCHIVE_PIPE_FAILED")
        gzip_process = subprocess.Popen(
            ["gzip", "-n"], stdin=docker.stdout, stdout=descriptor, stderr=subprocess.DEVNULL, env=SAFE_ENV
        )
        docker.stdout.close()
        deadline = time.monotonic() + 900
        gzip_status = gzip_process.wait(timeout=max(0.1, deadline - time.monotonic()))
        docker_status = docker.wait(timeout=max(0.1, deadline - time.monotonic()))
        if docker_status != 0 or gzip_status != 0:
            raise DeployError("ROLLBACK_ARCHIVE_SAVE_FAILED")
        os.fsync(descriptor)
        completed = True
    except subprocess.TimeoutExpired as error:
        _reap_pipeline(gzip_process, docker)
        raise DeployError("ROLLBACK_ARCHIVE_SAVE_TIMEOUT") from error
    except Exception:
        _reap_pipeline(gzip_process, docker)
        raise
    finally:
        if docker is not None and docker.stdout is not None:
            try:
                docker.stdout.close()
            except Exception:
                pass
        os.close(descriptor)
        if not completed:
            temporary.unlink(missing_ok=True)
    if temporary.stat().st_size <= 0:
        temporary.unlink(missing_ok=True)
        raise DeployError("ROLLBACK_ARCHIVE_EMPTY")
    os.replace(temporary, output_path)
    fsync_dir(output_path.parent)
    return output_path.stat().st_size, sha256_file(output_path)


def load_candidate(archive_path: Path) -> None:
    run_command(["docker", "load", "--input", str(archive_path)], timeout=900)


def compose_recreate(env_path: Path = LIVE_ENV, compose_path: Path = LIVE_COMPOSE) -> None:
    run_command(
        compose_args(env_path, compose_path, BASE_DIR)
        + [
            "up",
            "-d",
            "--no-deps",
            "--no-build",
            "--pull",
            "never",
            "--force-recreate",
            "--wait",
            "--wait-timeout",
            "180",
            "flowise",
        ],
        timeout=300,
    )


def _receipt_path(run_dir: Path, name: str) -> Path:
    return run_dir / f"{name}-receipt.json"


def _write_receipt(path: Path, document: dict[str, Any]) -> str:
    if path.exists() or path.is_symlink():
        raise DeployError(f"RECEIPT_ALREADY_EXISTS_{path.stem}")
    atomic_json(path, document)
    return sha256_file(path)


def _read_receipt(run_id: str, name: str, expected_digest: str | None = None) -> tuple[Path, dict[str, Any]]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise DeployError("RUN_ID_INVALID")
    run_dir = RUNS_DIR / run_id
    _validate_secure_run_directory(run_dir)
    path = _receipt_path(run_dir, name)
    data = read_regular(path, maximum=2 * 1024 * 1024, expected_uid=0, expected_gid=0, expected_mode=0o600)
    if expected_digest is not None and sha256_bytes(data) != expected_digest:
        raise DeployError(f"{name.upper()}_RECEIPT_DIGEST_MISMATCH")
    document = parse_canonical_json(data, f"{name.upper()}_RECEIPT")
    if document.get("run_id") != run_id:
        raise DeployError(f"{name.upper()}_RECEIPT_RUN_MISMATCH")
    if name.startswith("bootstrap-"):
        _validate_receipt_policy(document, name)
    return run_dir, document


def _verify_staged_file(path: Path, digest: str) -> bytes:
    data = read_regular(path, expected_uid=0, expected_gid=0, expected_mode=0o600)
    if sha256_bytes(data) != digest:
        raise DeployError(f"STAGED_FILE_DIGEST_MISMATCH_{path.name}")
    return data


def _load_staged(receipt: dict[str, Any], role: str, run_dir: Path) -> tuple[Path, bytes, bytes, bytes | None]:
    metadata = receipt[role]
    seccomp_metadata = metadata["files"].get("seccomp")
    exact_keys(seccomp_metadata, ("present", "digest"), f"{role.upper()}_SECCOMP_STATE")
    root = _validate_secure_run_role(
        run_dir,
        role,
    )
    env = _verify_staged_file(root / ".env.production", metadata["files"]["env"])
    compose = _verify_staged_file(root / "docker-compose.prod.yml", metadata["files"]["compose"])
    seccomp_path = root / "docker/seccomp/chromium.json"
    if seccomp_metadata["present"] is True:
        if not isinstance(seccomp_metadata["digest"], str) or not DIGEST_RE.fullmatch(seccomp_metadata["digest"]):
            raise DeployError(f"{role.upper()}_SECCOMP_DIGEST_INVALID")
        seccomp = _verify_staged_file(seccomp_path, seccomp_metadata["digest"])
    elif seccomp_metadata == {"present": False, "digest": None}:
        if seccomp_path.exists() or seccomp_path.is_symlink():
            raise DeployError(f"{role.upper()}_SECCOMP_ABSENCE_DRIFT")
        seccomp = None
    else:
        raise DeployError(f"{role.upper()}_SECCOMP_STATE_INVALID")
    return root, env, compose, seccomp


def _live_hashes() -> dict[str, Any]:
    _validate_live_seccomp_parents(allow_missing=True)
    try:
        info = LIVE_SECCOMP.lstat()
    except FileNotFoundError:
        seccomp: dict[str, Any] = {"present": False, "digest": None}
    else:
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
            raise DeployError("LIVE_SECCOMP_UNSAFE")
        seccomp = {"present": True, "digest": sha256_file(LIVE_SECCOMP)}
    return {"env": sha256_file(LIVE_ENV), "compose": sha256_file(LIVE_COMPOSE), "seccomp": seccomp}


def _validate_live_seccomp_parents(*, allow_missing: bool) -> None:
    for cursor in (BASE_DIR, BASE_DIR / "docker", BASE_DIR / "docker/seccomp"):
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            if allow_missing:
                return
            raise DeployError("LIVE_SECCOMP_PARENT_MISSING")
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise DeployError("LIVE_SECCOMP_PARENT_UNSAFE")


def _ensure_live_seccomp_parent(uid: int, gid: int) -> None:
    try:
        base_info = BASE_DIR.lstat()
    except FileNotFoundError as error:
        raise DeployError("LIVE_BASE_DIRECTORY_MISSING") from error
    if not stat.S_ISDIR(base_info.st_mode) or stat.S_ISLNK(base_info.st_mode):
        raise DeployError("LIVE_BASE_DIRECTORY_UNSAFE")
    cursor = BASE_DIR
    for component in ("docker", "seccomp"):
        cursor = cursor / component
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            cursor.mkdir(mode=0o755)
            os.chown(cursor, uid, gid)
            fsync_dir(cursor.parent)
            info = cursor.lstat()
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise DeployError("LIVE_SECCOMP_PARENT_UNSAFE")


def _remove_live_seccomp() -> None:
    _validate_live_seccomp_parents(allow_missing=True)
    try:
        info = LIVE_SECCOMP.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise DeployError("LIVE_SECCOMP_DELETE_UNSAFE")
    LIVE_SECCOMP.unlink()
    fsync_dir(LIVE_SECCOMP.parent)
    if LIVE_SECCOMP.exists() or LIVE_SECCOMP.is_symlink():
        raise DeployError("LIVE_SECCOMP_DELETE_FAILED")


def install_config_set(env: bytes, compose: bytes, seccomp: bytes | None, live_metadata: dict[str, list[int]]) -> None:
    # This order is a safety invariant: the Compose file must never reference a
    # profile that has not been installed, and the image env is promoted last.
    seccomp_uid, seccomp_gid, seccomp_mode = live_metadata["seccomp"]
    if seccomp is None:
        _remove_live_seccomp()
        if _live_hashes()["seccomp"] != {"present": False, "digest": None}:
            raise DeployError("LIVE_SECCOMP_ABSENCE_RESTORE_MISMATCH")
    else:
        _ensure_live_seccomp_parent(seccomp_uid, seccomp_gid)
        atomic_write(LIVE_SECCOMP, seccomp, seccomp_mode, seccomp_uid, seccomp_gid)
        if sha256_file(LIVE_SECCOMP) != sha256_bytes(seccomp):
            raise DeployError("LIVE_SECCOMP_INSTALL_MISMATCH")
    for key, path, data in (("compose", LIVE_COMPOSE, compose), ("env", LIVE_ENV, env)):
        uid, gid, mode = live_metadata[key]
        atomic_write(path, data, mode, uid, gid)
        if sha256_file(path) != sha256_bytes(data):
            raise DeployError(f"LIVE_{key.upper()}_INSTALL_MISMATCH")


def _resolved_live(expected_tag: str, key: bytes) -> tuple[dict[str, Any], str, dict[str, str]]:
    config = compose_config(LIVE_ENV, LIVE_COMPOSE, BASE_DIR)
    flowise = config.get("services", {}).get("flowise", {})
    if flowise.get("image") != expected_tag or "build" in flowise:
        raise DeployError("LIVE_RESOLVED_COMPOSE_IMAGE_MISMATCH")
    environment = service_environment(config)
    if environment.get("FLOWISE_SECRETKEY_OVERWRITE", "").encode() != key:
        raise DeployError("LIVE_RESOLVED_COMPOSE_KEY_MISMATCH")
    return config, compose_service_hash(LIVE_ENV, LIVE_COMPOSE, BASE_DIR), environment


def _validate_sidecars(before: dict[str, dict[str, Any]], after: dict[str, dict[str, Any]]) -> None:
    for name in (POSTGRES_CONTAINER, NGINX_CONTAINER):
        if container_snapshot(before)[name] != container_snapshot(after)[name]:
            raise DeployError(f"SIDECAR_DRIFT_{name}")


def _journal(run_dir: Path, document: dict[str, Any]) -> None:
    atomic_json(run_dir / "journal.json", document)


def _read_run_journal(run_dir: Path) -> dict[str, Any]:
    _validate_secure_run_directory(run_dir)
    data = read_regular(
        run_dir / "journal.json",
        maximum=2 * 1024 * 1024,
        expected_uid=0,
        expected_gid=0,
        expected_mode=0o600,
    )
    journal = parse_canonical_json(data, "JOURNAL")
    if journal.get("run_id") != run_dir.name:
        raise DeployError("JOURNAL_RUN_ID_MISMATCH")
    return journal


def _mark_rollback_attempt(run_dir: Path, journal: dict[str, Any], phase: str) -> None:
    """Persist the one-way boundary before any rollback can mutate production.

    Once this marker exists, automated recovery must never invoke the restore
    path again.  An operator must inspect the terminal receipt and live runtime
    before explicitly deciding whether any further write is safe.
    """

    journal.update(
        {
            "state": ROLLBACK_ATTEMPTED_STATE,
            "phase": phase,
            "rollback_attempted": True,
            "updated_at": utc_now(),
        }
    )
    _journal(run_dir, journal)


def _prepare_preflight(bundle: Bundle) -> dict[str, Any]:
    documents = inspect_containers()
    validate_container_health(documents)
    snapshot = container_snapshot(documents)
    active_tag = snapshot[FLOWISE_CONTAINER]["image_ref"]
    match = re.fullmatch(r"flowise-chinese:git-([0-9a-f]{40})", active_tag if isinstance(active_tag, str) else "")
    if not match or active_tag == bundle.image_tag:
        raise DeployError("ACTIVE_ROLLBACK_IMAGE_TAG_INVALID")
    active_image = inspect_image(active_tag, expected_revision=match.group(1))
    if snapshot[FLOWISE_CONTAINER]["image_id"] != active_image["image_config_digest"]:
        raise DeployError("ACTIVE_IMAGE_ID_MISMATCH")
    live_env, env_metadata = live_file(LIVE_ENV, 0o600)
    live_compose, compose_metadata = live_file(LIVE_COMPOSE, 0o644)
    _validate_live_seccomp_parents(allow_missing=True)
    try:
        live_seccomp, seccomp_metadata = live_file(LIVE_SECCOMP, 0o644)
    except FileNotFoundError:
        live_seccomp = None
        seccomp_metadata = (compose_metadata[0], compose_metadata[1], 0o644)
    key = persistent_key()
    rollback_config, rollback_hash, rollback_environment = _resolved_live(active_tag, key)
    validate_database_runtime_identity(rollback_config, documents)
    validate_key_continuity(documents, rollback_environment, key)
    validate_runtime(
        documents,
        image_tag=active_tag,
        image_digest=active_image["image_config_digest"],
        expected_config_hash=rollback_hash,
        expected_environment=rollback_environment,
        require_candidate_hardening=True,
        expected_compose=rollback_config,
        expected_runtime=snapshot[FLOWISE_CONTAINER]["runtime"],
    )
    database = database_state()
    runtime_pings()
    return {
        "documents": documents,
        "snapshot": snapshot,
        "active_tag": active_tag,
        "active_revision": match.group(1),
        "active_image_digest": active_image["image_config_digest"],
        "active_repository_url": active_image["repository_url"],
        "live_env": live_env,
        "live_compose": live_compose,
        "live_seccomp": live_seccomp,
        "live_metadata": {
            "env": list(env_metadata),
            "compose": list(compose_metadata),
            "seccomp": list(seccomp_metadata),
        },
        "rollback_config": rollback_config,
        "rollback_config_hash": rollback_hash,
        "rollback_environment": rollback_environment,
        "key": key,
        "database": database,
    }


def _collect_transition_observation(
    bundle: Bundle,
    *,
    permit_document: dict[str, Any] | None = None,
    check_current_journals: bool = True,
    current_run_id: str | None = None,
) -> dict[str, Any]:
    """Observe and validate the complete legacy transition state.

    Raw environment, key, Compose and Docker inspection data remain internal to
    this return value.  Callers may persist only the permit projection built by
    ``_build_transition_permit_document`` or the digest-only snapshot result.
    """

    binding = permit_document
    documents = inspect_containers()
    validate_container_health(documents)
    snapshot = container_snapshot(documents)
    active_tag = snapshot[FLOWISE_CONTAINER]["image_ref"]
    if binding is None:
        expected_tag = f"flowise-chinese:git-{LEGACY_BOOTSTRAP_REVISION}"
        if active_tag != expected_tag:
            raise DeployError("TRANSITION_ACTIVE_LEGACY_IMAGE_TAG_MISMATCH")
        active_image = inspect_image(active_tag, expected_revision=LEGACY_BOOTSTRAP_REVISION)
        if active_image.get("repository_url") not in LEGACY_BOOTSTRAP_REPOSITORY_URLS:
            raise DeployError("TRANSITION_ACTIVE_IMAGE_SOURCE_MISMATCH")
        active = {
            "image_tag": active_tag,
            "revision": LEGACY_BOOTSTRAP_REVISION,
            "release_id": f"git-{LEGACY_BOOTSTRAP_REVISION}",
            "repository_url": active_image.get("repository_url"),
            "created_at": active_image.get("created_at"),
            "image_config_digest": active_image.get("image_config_digest"),
        }
    else:
        active = binding["active_legacy"]
        if active_tag != active["image_tag"]:
            raise DeployError("BOOTSTRAP_ACTIVE_IMAGE_TAG_MISMATCH")
        active_image = inspect_image(
            active_tag,
            active["image_config_digest"],
            active["revision"],
            active["repository_url"],
        )
    if (
        snapshot[FLOWISE_CONTAINER]["image_id"] != active["image_config_digest"]
        or active_image.get("release_id") != active["release_id"]
        or active_image.get("created_at") != active["created_at"]
        or active_image.get("revision") != active["revision"]
        or active_image.get("repository_url") != active["repository_url"]
    ):
        code = "BOOTSTRAP_ACTIVE_IMAGE_IDENTITY_MISMATCH" if binding is not None else "TRANSITION_ACTIVE_IMAGE_IDENTITY_MISMATCH"
        raise DeployError(code)
    try:
        observed_container_ids = {name: snapshot[name]["id"] for name in MANAGED_CONTAINERS}
    except (KeyError, TypeError) as error:
        raise DeployError("TRANSITION_CONTAINER_IDENTITY_INVALID") from error
    if any(
        not isinstance(identifier, str) or not DOCKER_ID_RE.fullmatch(identifier)
        for identifier in observed_container_ids.values()
    ):
        raise DeployError("TRANSITION_CONTAINER_IDENTITY_INVALID")
    if binding is not None and observed_container_ids != binding["containers"]:
        raise DeployError("BOOTSTRAP_CONTAINER_ID_MISMATCH")
    network_identity = (
        validate_runtime_network_identity(documents, binding["network_identity"])
        if binding is not None
        else observe_runtime_network_identity(documents)
    )

    live_env, env_metadata = live_file(LIVE_ENV, 0o600)
    live_compose, compose_metadata = live_file(LIVE_COMPOSE, 0o644)
    live_hashes = _live_hashes()
    if live_hashes["env"] != sha256_bytes(live_env) or live_hashes["compose"] != sha256_bytes(live_compose):
        raise DeployError("TRANSITION_LIVE_FILE_CHANGED_DURING_OBSERVATION")
    expected_live_hashes = (
        {
            "env": binding["live"]["env_sha256"],
            "compose": binding["live"]["compose_sha256"],
            "seccomp": binding["live"]["seccomp"],
        }
        if binding is not None
        else live_hashes
    )
    if live_hashes != expected_live_hashes:
        raise DeployError("BOOTSTRAP_LIVE_FILE_BINDING_MISMATCH")
    if live_hashes["seccomp"] != {"present": False, "digest": None}:
        code = "BOOTSTRAP_LEGACY_SECCOMP_PRESENT" if binding is not None else "TRANSITION_LEGACY_SECCOMP_PRESENT"
        raise DeployError(code)
    if render_env(live_env, active_tag) != live_env:
        code = (
            "BOOTSTRAP_LIVE_ENV_IMAGE_ASSIGNMENT_DRIFT"
            if binding is not None
            else "TRANSITION_LIVE_ENV_IMAGE_ASSIGNMENT_DRIFT"
        )
        raise DeployError(code)

    key = persistent_key()
    legacy_config, computed_hash, legacy_compose_environment = _resolved_live(active_tag, key)
    legacy_environment = expected_container_environment(
        active_image["image_environment"],
        legacy_compose_environment,
    )
    environment_binding = runtime_environment_binding(legacy_environment, key)
    if binding is not None:
        _validate_runtime_environment_binding(active, legacy_environment, key, "BOOTSTRAP_ACTIVE_LEGACY")
    runtime_label_hash = snapshot[FLOWISE_CONTAINER]["compose_config_hash"]
    if binding is not None:
        if (
            runtime_label_hash != active["runtime_label_config_hash"]
            or computed_hash != active["live_computed_config_hash"]
            or runtime_label_hash == computed_hash
        ):
            raise DeployError("BOOTSTRAP_CONFIG_HASH_EXCEPTION_BINDING_MISMATCH")
        expected_runtime_projection_digest = active["runtime_projection_digest"]
    else:
        if (
            not isinstance(runtime_label_hash, str)
            or not CONFIG_HASH_RE.fullmatch(runtime_label_hash)
            or not isinstance(computed_hash, str)
            or not CONFIG_HASH_RE.fullmatch(computed_hash)
            or runtime_label_hash == computed_hash
        ):
            raise DeployError("TRANSITION_CONFIG_HASH_EXCEPTION_INVALID")
        expected_runtime_projection_digest = runtime_projection_digest(documents)
    validate_database_runtime_identity(legacy_config, documents)
    validate_key_continuity(documents, legacy_environment, key)
    legacy_runtime = validate_legacy_runtime(
        documents,
        image_tag=active_tag,
        image_digest=active["image_config_digest"],
        expected_config_hash=runtime_label_hash,
        expected_environment=legacy_environment,
        expected_runtime_projection_digest=expected_runtime_projection_digest,
    )
    database = database_state(include_name_digest=True)
    database_binding = {
        "migration_count": database.get("migration_count"),
        "migration_name_sha256": database.get("migration_name_sha256"),
    }
    if binding is not None and database_binding != binding["database"]:
        raise DeployError("BOOTSTRAP_DATABASE_BINDING_MISMATCH")
    legacy_inventory = legacy_journal_inventory()
    if binding is not None and legacy_inventory != binding["legacy_journal_inventory"]:
        raise DeployError("BOOTSTRAP_LEGACY_JOURNAL_INVENTORY_MISMATCH")
    current_inventory = (
        current_journal_inventory(exclude_run_id=current_run_id) if check_current_journals else None
    )
    runtime_pings()
    return {
        "documents": documents,
        "snapshot": snapshot,
        "active_tag": active_tag,
        "active_revision": active["revision"],
        "active_image_digest": active["image_config_digest"],
        "active_image": active_image,
        "live_env": live_env,
        "live_compose": live_compose,
        "live_seccomp": None,
        "live_hashes": live_hashes,
        "live_metadata": {
            "env": list(env_metadata),
            "compose": list(compose_metadata),
            "seccomp": [compose_metadata[0], compose_metadata[1], 0o644],
        },
        "legacy_config": legacy_config,
        "legacy_config_hash": computed_hash,
        "legacy_runtime_label_hash": runtime_label_hash,
        "legacy_environment": legacy_environment,
        "legacy_environment_binding": environment_binding,
        "legacy_runtime": legacy_runtime,
        "key": key,
        "database": database,
        "network_identity": network_identity,
        "legacy_journal_inventory": legacy_inventory,
        "current_journal_inventory": current_inventory,
    }


def _bootstrap_preflight(
    bundle: Bundle,
    permit: TransitionPermit,
    *,
    check_current_journals: bool,
    current_run_id: str | None = None,
) -> dict[str, Any]:
    return _collect_transition_observation(
        bundle,
        permit_document=permit.document,
        check_current_journals=check_current_journals,
        current_run_id=current_run_id,
    )


def _validate_bootstrap_cas(initial: dict[str, Any], current: dict[str, Any]) -> None:
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
    if any(initial[name] != current[name] for name in compared) or initial["key"] != current["key"]:
        raise DeployError("BOOTSTRAP_BASELINE_CAS_MISMATCH")
    current_inventory_fields = (
        "root",
        "control_json_count",
        "control_json_sha256",
        "unresolved_rollback_count",
    )
    if any(
        initial["current_journal_inventory"][name] != current["current_journal_inventory"][name]
        for name in current_inventory_fields
    ):
        raise DeployError("BOOTSTRAP_CURRENT_JOURNAL_CAS_MISMATCH")


def _validate_transition_observation_cas(initial: dict[str, Any], current: dict[str, Any]) -> None:
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
        "legacy_environment_binding",
        "legacy_runtime",
        "database",
        "network_identity",
        "legacy_journal_inventory",
        "current_journal_inventory",
    )
    try:
        drifted = any(initial[name] != current[name] for name in compared) or not hmac.compare_digest(
            initial["key"],
            current["key"],
        )
    except (KeyError, TypeError) as error:
        raise DeployError("TRANSITION_OBSERVATION_CAS_MISMATCH") from error
    if drifted:
        raise DeployError("TRANSITION_OBSERVATION_CAS_MISMATCH")


def _build_transition_permit_document(
    bundle: Bundle,
    run_id: str,
    observation: dict[str, Any],
) -> dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise DeployError("RUN_ID_INVALID")
    active_image = observation["active_image"]
    active_revision = observation["active_revision"]
    active_tag = observation["active_tag"]
    active_digest = observation["active_image_digest"]
    if active_image.get("repository_url") not in LEGACY_BOOTSTRAP_REPOSITORY_URLS:
        raise DeployError("TRANSITION_ACTIVE_IMAGE_SOURCE_MISMATCH")
    if (
        active_revision != LEGACY_BOOTSTRAP_REVISION
        or active_tag != f"flowise-chinese:git-{LEGACY_BOOTSTRAP_REVISION}"
        or bundle.revision == active_revision
        or bundle.image_tag == active_tag
        or bundle.image_config_digest == active_digest
    ):
        raise DeployError("TRANSITION_PERMIT_TARGET_NOT_DISTINCT_FROM_ACTIVE_LEGACY")
    environment_binding = observation["legacy_environment_binding"]
    legacy_runtime = observation["legacy_runtime"]
    snapshot = observation["snapshot"]
    database = observation["database"]
    live_hashes = observation["live_hashes"]
    return {
        "schema_version": 1,
        "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
        "run_id": run_id,
        "target_bundle": {
            "bundle_digest": bundle.bundle_digest,
            "revision": bundle.revision,
            "image_tag": bundle.image_tag,
            "image_config_digest": bundle.image_config_digest,
        },
        "active_legacy": {
            "image_tag": active_tag,
            "revision": active_revision,
            "release_id": active_image["release_id"],
            "repository_url": active_image["repository_url"],
            "created_at": active_image["created_at"],
            "image_config_digest": active_digest,
            "runtime_label_config_hash": observation["legacy_runtime_label_hash"],
            "live_computed_config_hash": observation["legacy_config_hash"],
            "runtime_projection_digest": legacy_runtime["runtime_projection_digest"],
            "runtime_environment_keys": copy.deepcopy(environment_binding["runtime_environment_keys"]),
            "runtime_environment_hmac_sha256": environment_binding["runtime_environment_hmac_sha256"],
        },
        "containers": {name: snapshot[name]["id"] for name in MANAGED_CONTAINERS},
        "live": {
            "env_sha256": live_hashes["env"],
            "compose_sha256": live_hashes["compose"],
            "seccomp": copy.deepcopy(live_hashes["seccomp"]),
        },
        "database": {
            "migration_count": database["migration_count"],
            "migration_name_sha256": database["migration_name_sha256"],
        },
        "network_identity": copy.deepcopy(observation["network_identity"]),
        "legacy_journal_inventory": copy.deepcopy(observation["legacy_journal_inventory"]),
    }


def _transition_snapshot_material(
    bundle: Bundle,
    run_id: str,
    observation: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any], str]:
    permit_document = _build_transition_permit_document(bundle, run_id, observation)
    permit_digest = sha256_bytes(canonical_json(permit_document))
    current_inventory = observation.get("current_journal_inventory")
    if not isinstance(current_inventory, dict):
        raise DeployError("TRANSITION_CURRENT_JOURNAL_INVENTORY_MISSING")
    snapshot_document = {
        "schema_version": 1,
        "run_id": run_id,
        "target_bundle_sha256": bundle.bundle_digest,
        "permit_candidate_sha256": permit_digest,
        "current_journal_inventory": copy.deepcopy(current_inventory),
    }
    return permit_document, snapshot_document, sha256_bytes(canonical_json(snapshot_document))


def _capture_stable_transition(
    bundle: Bundle,
    run_id: str,
) -> tuple[dict[str, Any], dict[str, Any], str, dict[str, Any]]:
    initial = _collect_transition_observation(bundle, check_current_journals=True)
    initial_permit = _build_transition_permit_document(bundle, run_id, initial)
    initial_permit_bytes = canonical_json(initial_permit)
    current = _collect_transition_observation(
        bundle,
        permit_document=initial_permit,
        check_current_journals=True,
    )
    _validate_transition_observation_cas(initial, current)
    permit_document, snapshot_document, snapshot_digest = _transition_snapshot_material(bundle, run_id, current)
    if canonical_json(permit_document) != initial_permit_bytes:
        raise DeployError("TRANSITION_PERMIT_CANDIDATE_CAS_MISMATCH")
    return permit_document, snapshot_document, snapshot_digest, current


def _transition_snapshot_result(
    bundle: Bundle,
    run_id: str,
    permit_document: dict[str, Any],
    snapshot_document: dict[str, Any],
    snapshot_digest: str,
    observation: dict[str, Any],
) -> dict[str, Any]:
    active = permit_document["active_legacy"]
    environment_binding = {
        "runtime_environment_keys": active["runtime_environment_keys"],
        "runtime_environment_hmac_sha256": active["runtime_environment_hmac_sha256"],
    }
    legacy_inventory = permit_document["legacy_journal_inventory"]
    current_inventory = observation["current_journal_inventory"]
    return {
        "status": "transition_snapshot_verified",
        "run_id": run_id,
        "target_bundle_sha256": bundle.bundle_digest,
        "permit_candidate_sha256": snapshot_document["permit_candidate_sha256"],
        "snapshot_sha256": snapshot_digest,
        "container_identity_sha256": sha256_bytes(canonical_json(permit_document["containers"])),
        "network_identity_sha256": sha256_bytes(canonical_json(permit_document["network_identity"])),
        "live_state_sha256": sha256_bytes(canonical_json(permit_document["live"])),
        "runtime_environment_binding_sha256": sha256_bytes(canonical_json(environment_binding)),
        "database_state_sha256": sha256_bytes(canonical_json(permit_document["database"])),
        "legacy_journal_inventory_sha256": legacy_inventory["canonical_inventory_sha256"],
        "current_journal_inventory_sha256": current_inventory["control_json_sha256"],
        "migration_count": permit_document["database"]["migration_count"],
        "legacy_journal_root_count": legacy_inventory["root_count"],
        "legacy_journal_run_count": legacy_inventory["run_count"],
        "legacy_journal_control_count": legacy_inventory["control_count"],
        "current_journal_control_count": current_inventory["control_json_count"],
        "production_runtime_write": False,
        "control_artifact_write": False,
        "database_write": False,
        "provider_call": False,
        "secret_value_output": False,
    }


def snapshot_transition(bundle_dir: Path, run_id: str) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    try:
        if not RUN_ID_RE.fullmatch(run_id):
            raise DeployError("RUN_ID_INVALID")
        bundle = verify_bundle(bundle_dir)
        permit_document, snapshot_document, snapshot_digest, observation = _capture_stable_transition(bundle, run_id)
        return _transition_snapshot_result(
            bundle,
            run_id,
            permit_document,
            snapshot_document,
            snapshot_digest,
            observation,
        )
    finally:
        os.close(lock)


def issue_transition_permit(
    bundle_dir: Path,
    run_id: str,
    expected_snapshot_sha256: str,
) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    try:
        if not RUN_ID_RE.fullmatch(run_id):
            raise DeployError("RUN_ID_INVALID")
        if not isinstance(expected_snapshot_sha256, str) or not DIGEST_RE.fullmatch(expected_snapshot_sha256):
            raise DeployError("TRANSITION_SNAPSHOT_DIGEST_INVALID")
        bundle = verify_bundle(bundle_dir)
        permit_document, _snapshot_document, snapshot_digest, _observation = _capture_stable_transition(bundle, run_id)
        if not hmac.compare_digest(snapshot_digest, expected_snapshot_sha256):
            raise DeployError("TRANSITION_SNAPSHOT_DIGEST_MISMATCH")
        permit_bytes = canonical_json(permit_document)
        permit_digest = sha256_bytes(permit_bytes)
        permit_path = _install_transition_permit(run_id, permit_bytes, bundle=bundle)
        try:
            verified = verify_transition_permit(
                permit_path,
                permit_digest,
                bundle=bundle,
                run_id=run_id,
            )
            if (
                verified.document != permit_document
                or verified.digest != permit_digest
                or verified.path != permit_path.absolute()
            ):
                raise DeployError("TRANSITION_PERMIT_ROUNDTRIP_MISMATCH")
        except Exception as publication_error:
            guard = permit_path.parent / f".{run_id}.{secrets.token_hex(12)}.failed"
            try:
                _quarantine_transition_permit(permit_path, guard)
            except Exception as quarantine_error:
                if isinstance(publication_error, DeployError):
                    raise DeployError(
                        f"{publication_error}:TRANSITION_PERMIT_QUARANTINE_FAILED"
                    ) from quarantine_error
                raise DeployError(
                    "TRANSITION_PERMIT_ROUNDTRIP_AND_QUARANTINE_FAILED"
                ) from quarantine_error
            raise
        return {
            "status": "transition_permit_issued",
            "run_id": run_id,
            "permit_path": str(permit_path),
            "permit_sha256": permit_digest,
            "snapshot_sha256": snapshot_digest,
            "target_bundle_sha256": bundle.bundle_digest,
            "production_runtime_write": False,
            "control_artifact_write": True,
            "database_write": False,
            "provider_call": False,
            "secret_value_output": False,
        }
    finally:
        os.close(lock)


def prepare(bundle_dir: Path, run_id: str) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    run_dir: Path | None = None
    journal: dict[str, Any] | None = None
    try:
        _recover_interrupted_runs()
        bundle = verify_bundle(bundle_dir)
        baseline = _prepare_preflight(bundle)
        run_dir = _create_run_dir(run_id)
        journal = {
            "schema_version": 1,
            "operation": "prepare",
            "state": "in_progress",
            "phase": "baseline_verified",
            "run_id": run_id,
            "release_id": bundle.release_id,
            "updated_at": utc_now(),
        }
        _journal(run_dir, journal)
        candidate_env = render_env(baseline["live_env"], bundle.image_tag)
        rollback_files = _write_staged_tree(
            run_dir / "rollback", baseline["live_env"], baseline["live_compose"], baseline["live_seccomp"]
        )
        candidate_files = _write_staged_tree(
            run_dir / "candidate",
            candidate_env,
            read_bundle_payload(
                bundle.files["production_compose"],
                bundle.file_entries["production_compose"]["bytes"],
                bundle.file_entries["production_compose"]["digest"],
            ),
            read_bundle_payload(
                bundle.files["chromium_seccomp"],
                bundle.file_entries["chromium_seccomp"]["bytes"],
                bundle.file_entries["chromium_seccomp"]["digest"],
            ),
        )
        candidate_root = run_dir / "candidate"
        rollback_root = run_dir / "rollback"
        candidate_archive = candidate_root / "image.tar.gz"
        candidate_archive_bytes, candidate_archive_digest = freeze_verified_file(
            bundle.files["image_archive"],
            candidate_archive,
            expected_bytes=bundle.file_entries["image_archive"]["bytes"],
            expected_digest=bundle.file_entries["image_archive"]["digest"],
        )
        verify_archive_contract(
            candidate_archive,
            image_tag=bundle.image_tag,
            image_config_digest=bundle.image_config_digest,
            revision=bundle.revision,
            release_id=bundle.release_id,
            repository_url=bundle.manifest["source"]["repository_url"],
        )
        candidate_config = compose_config(
            candidate_root / ".env.production", candidate_root / "docker-compose.prod.yml", candidate_root
        )
        rollback_config = compose_config(
            rollback_root / ".env.production", rollback_root / "docker-compose.prod.yml", rollback_root
        )
        validate_compose(candidate_config, rollback_config, bundle.image_tag, baseline["active_tag"], baseline["key"])
        validate_database_runtime_identity(candidate_config, baseline["documents"])
        rollback_archive = rollback_root / "image.tar.gz"
        rollback_archive_bytes, rollback_archive_digest = save_rollback_archive(baseline["active_tag"], rollback_archive)
        rollback_image = inspect_image(baseline["active_tag"])
        rollback_repository_url = rollback_image.get("repository_url")
        if not isinstance(rollback_repository_url, str) or not rollback_repository_url:
            raise DeployError("ROLLBACK_IMAGE_SOURCE_LABEL_MISSING")
        verify_archive_contract(
            rollback_archive,
            image_tag=baseline["active_tag"],
            image_config_digest=baseline["active_image_digest"],
            revision=baseline["active_revision"],
            release_id=f"git-{baseline['active_revision']}",
            repository_url=rollback_repository_url,
        )
        journal.update({"phase": "rollback_frozen", "updated_at": utc_now()})
        _journal(run_dir, journal)
        load_candidate(candidate_archive)
        candidate_image = inspect_image(
            bundle.image_tag,
            bundle.image_config_digest,
            bundle.revision,
            bundle.manifest["source"]["repository_url"],
        )
        verified_migration_gate = migration_gate(
            bundle.image_tag,
            candidate_root / "docker/seccomp/chromium.json",
            baseline["database"],
        )
        after_prepare = inspect_containers()
        if container_snapshot(after_prepare) != baseline["snapshot"] or _live_hashes() != {
            "env": sha256_bytes(baseline["live_env"]),
            "compose": sha256_bytes(baseline["live_compose"]),
            "seccomp": {
                "present": baseline["live_seccomp"] is not None,
                "digest": sha256_bytes(baseline["live_seccomp"]) if baseline["live_seccomp"] is not None else None,
            },
        }:
            raise DeployError("PRODUCTION_DRIFT_DURING_PREPARE")
        if database_state() != baseline["database"]:
            raise DeployError("DATABASE_DRIFT_DURING_PREPARE")
        runtime_pings()
        receipt = {
            "schema_version": 1,
            "operation": "prepare",
            "state": "prepared",
            "run_id": run_id,
            "release": {
                "release_id": bundle.release_id,
                "revision": bundle.revision,
                "image_tag": bundle.image_tag,
                "image_config_digest": candidate_image["image_config_digest"],
            },
            "bundle": {"digest": bundle.bundle_digest},
            "candidate": {
                "files": candidate_files,
                "archive": {"bytes": candidate_archive_bytes, "digest": candidate_archive_digest},
            },
            "rollback": {
                "release_id": f"git-{baseline['active_revision']}",
                "revision": baseline["active_revision"],
                "image_tag": baseline["active_tag"],
                "image_config_digest": baseline["active_image_digest"],
                "repository_url": baseline["active_repository_url"],
                "files": rollback_files,
                "archive": {"bytes": rollback_archive_bytes, "digest": rollback_archive_digest},
                "compose_config_hash": baseline["rollback_config_hash"],
            },
            "baseline": {"containers": baseline["snapshot"], "database": baseline["database"]},
            "migration_gate": verified_migration_gate,
            "live_metadata": baseline["live_metadata"],
            "key_continuity_verified": True,
            "container_recreated": False,
            "provider_call": False,
            "created_at": utc_now(),
        }
        receipt_digest = _write_receipt(_receipt_path(run_dir, "prepare"), receipt)
        journal.update({"state": "prepared", "phase": "prepared_cutover_ready", "updated_at": utc_now()})
        _journal(run_dir, journal)
        result = {
            "status": "prepared_cutover_ready",
            "run_id": run_id,
            "prepare_receipt_sha256": receipt_digest,
            "candidate_image": bundle.image_tag,
            "rollback_image": baseline["active_tag"],
            "container_recreated": False,
        }
        return result
    except Exception as error:
        if journal is not None and run_dir is not None:
            journal.update(
                {
                    "state": "failed",
                    "phase": "prepare_failed_no_forward_recreate",
                    "error": str(error) if isinstance(error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                    "updated_at": utc_now(),
                }
            )
            try:
                _journal(run_dir, journal)
            except Exception:
                pass
        raise
    finally:
        os.close(lock)


def _cutover_preflight(run_id: str, receipt_digest: str) -> tuple[Path, dict[str, Any], dict[str, Any], bytes]:
    run_dir, receipt = _read_receipt(run_id, "prepare", receipt_digest)
    if receipt.get("state") != "prepared" or receipt.get("operation") != "prepare":
        raise DeployError("PREPARE_RECEIPT_STATE_INVALID")
    candidate_root, _, _, _ = _load_staged(receipt, "candidate", run_dir)
    rollback_root, _, _, _ = _load_staged(receipt, "rollback", run_dir)
    candidate_archive = candidate_root / "image.tar.gz"
    verify_regular_identity(
        candidate_archive,
        expected_bytes=receipt["candidate"]["archive"]["bytes"],
        expected_digest=receipt["candidate"]["archive"]["digest"],
    )
    rollback_archive = rollback_root / "image.tar.gz"
    verify_regular_identity(
        rollback_archive,
        expected_bytes=receipt["rollback"]["archive"]["bytes"],
        expected_digest=receipt["rollback"]["archive"]["digest"],
    )
    documents = inspect_containers()
    if container_snapshot(documents) != receipt["baseline"]["containers"]:
        raise DeployError("CUTOVER_CONTAINER_BASELINE_DRIFT")
    current_database = database_state()
    if current_database != receipt["baseline"]["database"]:
        raise DeployError("CUTOVER_DATABASE_BASELINE_DRIFT")
    if _live_hashes() != receipt["rollback"]["files"]:
        raise DeployError("CUTOVER_LIVE_CONFIG_BASELINE_DRIFT")
    inspect_image(
        receipt["release"]["image_tag"], receipt["release"]["image_config_digest"], receipt["release"]["revision"]
    )
    key = persistent_key()
    rollback_config = compose_config(
        rollback_root / ".env.production", rollback_root / "docker-compose.prod.yml", rollback_root
    )
    candidate_config = compose_config(
        candidate_root / ".env.production", candidate_root / "docker-compose.prod.yml", candidate_root
    )
    validate_compose(
        candidate_config,
        rollback_config,
        receipt["release"]["image_tag"],
        receipt["rollback"]["image_tag"],
        key,
    )
    validate_database_runtime_identity(candidate_config, documents)
    reverified_migration_gate = migration_gate(
        receipt["release"]["image_tag"],
        candidate_root / "docker/seccomp/chromium.json",
        current_database,
    )
    if reverified_migration_gate != receipt.get("migration_gate"):
        raise DeployError("CUTOVER_MIGRATION_GATE_RECEIPT_MISMATCH")
    if database_state() != current_database:
        raise DeployError("CUTOVER_DATABASE_DRIFT_DURING_MIGRATION_GATE")
    validate_key_continuity(documents, service_environment(rollback_config), key)
    runtime_pings()
    return run_dir, receipt, documents, key


def _ensure_rollback_image(run_dir: Path, receipt: dict[str, Any]) -> None:
    rollback = receipt["rollback"]
    archive = rollback["archive"]
    rollback_root = _validate_secure_run_role(run_dir, "rollback")
    archive_path = rollback_root / "image.tar.gz"
    verify_regular_identity(
        archive_path,
        expected_bytes=archive["bytes"],
        expected_digest=archive["digest"],
    )
    verify_archive_contract(
        archive_path,
        image_tag=rollback["image_tag"],
        image_config_digest=rollback["image_config_digest"],
        revision=rollback["revision"],
        release_id=rollback["release_id"],
        repository_url=rollback["repository_url"],
    )
    try:
        inspect_image(
            rollback["image_tag"],
            rollback["image_config_digest"],
            rollback["revision"],
            rollback["repository_url"],
        )
    except DeployError:
        # Missing or conflicting local tags are recovered exclusively from the
        # frozen run-scoped archive.  No registry or mutable remote is consulted.
        load_candidate(archive_path)
        inspect_image(
            rollback["image_tag"],
            rollback["image_config_digest"],
            rollback["revision"],
            rollback["repository_url"],
        )


def _restore_rollback(
    run_dir: Path,
    receipt: dict[str, Any],
    before: dict[str, dict[str, Any]],
    key: bytes,
) -> dict[str, Any]:
    _ensure_rollback_image(run_dir, receipt)
    rollback_root, env, compose, seccomp = _load_staged(receipt, "rollback", run_dir)
    install_config_set(env, compose, seccomp, receipt["live_metadata"])
    if _live_hashes() != receipt["rollback"]["files"]:
        raise DeployError("ROLLBACK_LIVE_FILE_HASH_MISMATCH")
    resolved_rollback, expected_hash, environment = _resolved_live(receipt["rollback"]["image_tag"], key)
    if expected_hash != receipt["rollback"]["compose_config_hash"]:
        raise DeployError("ROLLBACK_RESOLVED_COMPOSE_HASH_MISMATCH")
    compose_recreate()
    after = inspect_containers()
    runtime = validate_runtime(
        after,
        image_tag=receipt["rollback"]["image_tag"],
        image_digest=receipt["rollback"]["image_config_digest"],
        expected_config_hash=expected_hash,
        expected_environment=environment,
        require_candidate_hardening=True,
        expected_compose=resolved_rollback,
        expected_runtime=receipt["baseline"]["containers"][FLOWISE_CONTAINER]["runtime"],
    )
    validate_database_runtime_identity(resolved_rollback, after)
    _validate_sidecars(before, after)
    validate_key_continuity(after, environment, key)
    if database_state() != receipt["baseline"]["database"]:
        raise DeployError("DATABASE_DRIFT_AFTER_ROLLBACK")
    runtime_pings()
    return {"containers": container_snapshot(after), **runtime}


def _compose_without_flowise_image(document: dict[str, Any]) -> dict[str, Any]:
    projection = copy.deepcopy(document)
    try:
        projection["services"]["flowise"]["image"] = "__FLOWISE_RELEASE_IMAGE__"
    except (KeyError, TypeError) as error:
        raise DeployError("BOOTSTRAP_COMPOSE_FLOWISE_SERVICE_MISSING") from error
    return projection


def _verify_frozen_legacy_archive(run_dir: Path, receipt: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
    _validate_receipt_policy(receipt, "bootstrap-prepare")
    legacy = receipt["legacy"]
    archive = legacy["archive"]
    legacy_root = _validate_secure_run_role(run_dir, "legacy")
    archive_path = legacy_root / "image.tar.gz"
    verify_regular_identity(
        archive_path,
        expected_bytes=archive["bytes"],
        expected_digest=archive["digest"],
    )
    contract = verify_legacy_archive_contract(
        archive_path,
        image_tag=legacy["image_tag"],
        image_config_digest=legacy["image_config_digest"],
        revision=legacy["revision"],
        release_id=legacy["release_id"],
        repository_url=legacy["repository_url"],
        created_at=legacy["created_at"],
    )
    return archive_path, contract


def _ensure_legacy_image(run_dir: Path, receipt: dict[str, Any]) -> dict[str, Any]:
    legacy = receipt["legacy"]
    archive_path, archive_contract = _verify_frozen_legacy_archive(run_dir, receipt)

    def inspect_exact() -> None:
        observed = inspect_image(
            legacy["image_tag"],
            legacy["image_config_digest"],
            legacy["revision"],
            legacy["repository_url"],
        )
        if observed.get("release_id") != legacy["release_id"] or observed.get("created_at") != legacy["created_at"]:
            raise DeployError("LEGACY_IMAGE_PROVENANCE_MISMATCH")

    try:
        inspect_exact()
    except DeployError:
        load_candidate(archive_path)
        inspect_exact()
    return archive_contract


def _validate_legacy_restore_sidecars(
    documents: dict[str, dict[str, Any]],
    receipt: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    for name in (POSTGRES_CONTAINER, NGINX_CONTAINER):
        document = documents.get(name)
        if not isinstance(document, dict):
            raise DeployError(f"LEGACY_ROLLBACK_SIDECAR_MISSING_{name}")
        state = document.get("State") or {}
        if state.get("Status") != "running" or (state.get("Health") or {}).get("Status") != "healthy":
            raise DeployError(f"LEGACY_ROLLBACK_SIDECAR_NOT_HEALTHY_{name}")
    snapshot = container_snapshot(documents)
    for name in (POSTGRES_CONTAINER, NGINX_CONTAINER):
        if snapshot.get(name) != receipt["baseline"]["containers"][name]:
            raise DeployError(f"LEGACY_ROLLBACK_SIDECAR_BASELINE_DRIFT_{name}")
    return snapshot


def _legacy_restore_expected_state(
    run_dir: Path,
    receipt: dict[str, Any],
    key: bytes,
) -> dict[str, Any]:
    _validate_network_identity_binding(
        receipt["baseline"].get("network_identity"),
        "LEGACY_ROLLBACK_NETWORK_IDENTITY",
    )
    _, archive_contract = _verify_frozen_legacy_archive(run_dir, receipt)
    legacy_root, legacy_env, legacy_compose, legacy_seccomp = _load_staged(receipt, "legacy", run_dir)
    hardened_root, hardened_env, hardened_compose, hardened_seccomp = _load_staged(
        receipt,
        "hardened_active",
        run_dir,
    )
    if legacy_seccomp is not None or hardened_seccomp is None:
        raise DeployError("LEGACY_ROLLBACK_STAGED_SECCOMP_STATE_INVALID")
    legacy_config = compose_config(
        legacy_root / ".env.production",
        legacy_root / "docker-compose.prod.yml",
        legacy_root,
    )
    hardened_config = compose_config(
        hardened_root / ".env.production",
        hardened_root / "docker-compose.prod.yml",
        hardened_root,
    )
    try:
        legacy_flowise = legacy_config["services"]["flowise"]
    except (KeyError, TypeError) as error:
        raise DeployError("LEGACY_ROLLBACK_STAGED_CONFIG_INVALID") from error
    if legacy_flowise.get("image") != receipt["legacy"]["image_tag"] or "build" in legacy_flowise:
        raise DeployError("LEGACY_ROLLBACK_STAGED_IMAGE_MISMATCH")
    validate_hardened_compose(hardened_config, receipt["hardened_active"]["image_tag"], key)
    if (
        receipt["legacy"]["image_tag"] != receipt["hardened_active"]["image_tag"]
        or receipt["legacy"]["image_config_digest"]
        != receipt["hardened_active"]["image_config_digest"]
    ):
        raise DeployError("LEGACY_ROLLBACK_RECEIPT_IMAGE_BINDING_MISMATCH")
    image_environment = archive_contract.get("image_environment")
    if not isinstance(image_environment, dict) or any(
        not isinstance(name, str) or not isinstance(value, str)
        for name, value in image_environment.items()
    ):
        raise DeployError("LEGACY_IMAGE_ENVIRONMENT_INVALID")
    legacy_environment = expected_container_environment(
        image_environment,
        service_environment(legacy_config),
    )
    hardened_environment = expected_container_environment(
        image_environment,
        service_environment(hardened_config),
    )
    _validate_runtime_environment_binding(receipt["legacy"], legacy_environment, key, "LEGACY")
    _validate_runtime_environment_binding(
        receipt["hardened_active"],
        hardened_environment,
        key,
        "HARDENED_ACTIVE",
    )
    return {
        "legacy_root": legacy_root,
        "legacy_env": legacy_env,
        "legacy_compose": legacy_compose,
        "legacy_config": legacy_config,
        "legacy_environment": legacy_environment,
        "hardened_root": hardened_root,
        "hardened_env": hardened_env,
        "hardened_compose": hardened_compose,
        "hardened_config": hardened_config,
        "hardened_environment": hardened_environment,
    }


def _legacy_recreate_window_matches(
    journal: dict[str, Any],
    value: Any,
    origin: str,
) -> bool:
    if not isinstance(value, dict):
        return False
    pre_recreate_id = value.get("pre_recreate_flowise_container_id")
    if pre_recreate_id != "absent" and (
        not isinstance(pre_recreate_id, str) or not DOCKER_ID_RE.fullmatch(pre_recreate_id)
    ):
        return False
    try:
        expected = _legacy_recreate_window_marker(journal, origin, pre_recreate_id)
    except DeployError:
        return False
    return value == expected


def _legacy_absent_flowise_authorization(
    run_dir: Path,
    receipt: dict[str, Any],
    journal: dict[str, Any],
) -> str | None:
    """Return the exact persisted recreate window that permits absence."""

    run_id = receipt.get("run_id")
    prepare_digest = journal.get("bootstrap_prepare_receipt_sha256")
    if (
        not isinstance(run_id, str)
        or run_dir.name != run_id
        or journal.get("run_id") != run_id
        or not isinstance(prepare_digest, str)
        or not DIGEST_RE.fullmatch(prepare_digest)
    ):
        return None
    operation = journal.get("operation")
    state = journal.get("state")
    phase = journal.get("phase")
    step = journal.get("rollback_step")
    if operation == "bootstrap":
        if (
            journal.get("permit_digest") != (receipt.get("permit") or {}).get("digest")
            or journal.get("target_bundle_digest")
            != (receipt.get("target_bundle") or {}).get("bundle_digest")
        ):
            return None
        if (
            state == "in_progress"
            and phase == "hardened_recreate_intent"
            and journal.get("live_write_started") is True
            and journal.get("hardened_recreate_started") is True
        ):
            return "hardened_recreate_intent"
        durable = journal.get("flowise_absent_recovery")
        durable_origin = durable.get("origin") if isinstance(durable, dict) else None
        if (
            state == "rolling_back"
            and durable_origin in {"hardened_recreate_intent", "legacy_recreate_starting"}
            and _legacy_recreate_window_matches(journal, durable, str(durable_origin))
            and phase
            in {
                "automatic_legacy_rollback_restoring",
                "interrupted_legacy_rollback_restoring",
                "legacy_rollback_files_restoring",
                "legacy_recreate_starting",
            }
            and step
            in {
                "LLL",
                "HLL",
                "HHL",
                "HHH",
                "LHH",
                "LLH",
                "legacy_recreate_starting",
            }
        ):
            return str(durable_origin)
        return None
    if operation == "bootstrap-rollback":
        complete_digest = journal.get("bootstrap_complete_receipt_sha256")
        if not isinstance(complete_digest, str) or not DIGEST_RE.fullmatch(complete_digest):
            return None
        durable = journal.get("flowise_absent_recovery")
        if (
            state == "rolling_back"
            and isinstance(durable, dict)
            and durable.get("origin") == "legacy_recreate_starting"
            and _legacy_recreate_window_matches(
                journal,
                durable,
                "legacy_recreate_starting",
            )
            and phase
            in {
                "manual_legacy_rollback_restoring",
                "legacy_rollback_files_restoring",
                "legacy_recreate_starting",
            }
            and step
            in {
                "LLL",
                "HLL",
                "HHL",
                "HHH",
                "LHH",
                "LLH",
                "legacy_recreate_starting",
            }
        ):
            return "legacy_recreate_starting"
    return None


def _validate_present_legacy_recreate_marker(journal: dict[str, Any]) -> None:
    """Reject any persisted recreate marker unless its full binding is exact."""

    if journal.get("state") != "rolling_back" or "flowise_absent_recovery" not in journal:
        return
    marker = journal.get("flowise_absent_recovery")
    origin = marker.get("origin") if isinstance(marker, dict) else None
    operation = journal.get("operation")
    allowed_origins = (
        {"hardened_recreate_intent", "legacy_recreate_starting"}
        if operation == "bootstrap"
        else {"legacy_recreate_starting"}
        if operation == "bootstrap-rollback"
        else set()
    )
    if (
        not isinstance(origin, str)
        or origin not in allowed_origins
        or not _legacy_recreate_window_matches(journal, marker, origin)
    ):
        raise DeployError("LEGACY_RECREATE_WINDOW_MARKER_INVALID")


def _legacy_recreate_window_marker(
    journal: dict[str, Any],
    origin: str,
    pre_recreate_flowise_container_id: str,
) -> dict[str, str]:
    if origin not in {"hardened_recreate_intent", "legacy_recreate_starting"}:
        raise DeployError("LEGACY_RECREATE_WINDOW_ORIGIN_INVALID")
    prepare_digest = journal.get("bootstrap_prepare_receipt_sha256")
    if not isinstance(prepare_digest, str) or not DIGEST_RE.fullmatch(prepare_digest):
        raise DeployError("LEGACY_RECREATE_WINDOW_PREPARE_BINDING_INVALID")
    if pre_recreate_flowise_container_id != "absent" and not DOCKER_ID_RE.fullmatch(
        pre_recreate_flowise_container_id
    ):
        raise DeployError("LEGACY_RECREATE_WINDOW_CONTAINER_ID_INVALID")
    marker = {
        "origin": origin,
        "bootstrap_prepare_receipt_sha256": prepare_digest,
        "pre_recreate_flowise_container_id": pre_recreate_flowise_container_id,
    }
    operation = journal.get("operation")
    if operation == "bootstrap-rollback":
        complete_digest = journal.get("bootstrap_complete_receipt_sha256")
        if not isinstance(complete_digest, str) or not DIGEST_RE.fullmatch(complete_digest):
            raise DeployError("LEGACY_RECREATE_WINDOW_COMPLETE_BINDING_INVALID")
        marker["bootstrap_complete_receipt_sha256"] = complete_digest
    elif operation != "bootstrap":
        raise DeployError("LEGACY_RECREATE_WINDOW_OPERATION_INVALID")
    return marker


def _flowise_container_id(documents: dict[str, dict[str, Any]]) -> str | None:
    flowise = documents.get(FLOWISE_CONTAINER)
    if flowise is None:
        return None
    if not isinstance(flowise, dict):
        raise DeployError("LEGACY_ROLLBACK_FLOWISE_DOCUMENT_INVALID")
    identifier = flowise.get("Id")
    if not isinstance(identifier, str) or not DOCKER_ID_RE.fullmatch(identifier):
        raise DeployError("LEGACY_ROLLBACK_FLOWISE_CONTAINER_ID_INVALID")
    return identifier


def _legacy_recreate_already_observed(
    journal: dict[str, Any],
    documents: dict[str, dict[str, Any]],
) -> bool:
    """Prove a checkpointed force-recreate produced a different container."""

    marker = journal.get("flowise_absent_recovery")
    if not _legacy_recreate_window_active(journal):
        return False
    if not isinstance(marker, dict):
        return False
    current_id = _flowise_container_id(documents)
    if current_id is None:
        return False
    previous_id = marker["pre_recreate_flowise_container_id"]
    return previous_id == "absent" or current_id != previous_id


def _legacy_recreate_checkpoint_active(journal: dict[str, Any]) -> bool:
    return bool(
        _legacy_recreate_window_active(journal)
        and journal.get("phase") == "legacy_recreate_starting"
        and journal.get("rollback_step") == "legacy_recreate_starting"
    )


def _legacy_recreate_window_active(journal: dict[str, Any]) -> bool:
    marker = journal.get("flowise_absent_recovery")
    return bool(
        journal.get("state") == "rolling_back"
        and isinstance(marker, dict)
        and marker.get("origin") == "legacy_recreate_starting"
        and _legacy_recreate_window_matches(journal, marker, "legacy_recreate_starting")
        and journal.get("phase")
        in {
            "automatic_legacy_rollback_restoring",
            "interrupted_legacy_rollback_restoring",
            "manual_legacy_rollback_restoring",
            "legacy_rollback_files_restoring",
            "legacy_recreate_starting",
        }
        and journal.get("rollback_step")
        in {*_LEGACY_FILE_SUCCESSOR, "legacy_recreate_starting"}
    )


_LEGACY_FILE_SUCCESSOR = {
    "HHH": "LHH",
    "LHH": "LLH",
    "LLH": "LLL",
    "HHL": "HLL",
    "HLL": "LLL",
    "LLL": "LLL",
}


def _validate_legacy_rollback_resume_progress(
    journal: dict[str, Any],
    observed_file_state: str,
) -> None:
    if journal.get("state") != "rolling_back":
        return
    phase = journal.get("phase")
    step = journal.get("rollback_step")
    if phase == "legacy_recreate_starting":
        if (
            step != "legacy_recreate_starting"
            or observed_file_state != "LLL"
            or not _legacy_recreate_checkpoint_active(journal)
        ):
            raise DeployError("LEGACY_ROLLBACK_RESUME_PROGRESS_MISMATCH")
        return
    if phase not in {
        "automatic_legacy_rollback_restoring",
        "interrupted_legacy_rollback_restoring",
        "manual_legacy_rollback_restoring",
        "legacy_rollback_files_restoring",
    } or step not in _LEGACY_FILE_SUCCESSOR:
        raise DeployError("LEGACY_ROLLBACK_RESUME_PROGRESS_INVALID")
    if observed_file_state not in {step, _LEGACY_FILE_SUCCESSOR[str(step)]}:
        raise DeployError("LEGACY_ROLLBACK_RESUME_PROGRESS_MISMATCH")


def _classify_legacy_rollback_live_state(
    run_dir: Path,
    receipt: dict[str, Any],
    documents: dict[str, dict[str, Any]],
    key: bytes,
    *,
    allow_flowise_absent: bool = False,
) -> dict[str, Any]:
    _validate_receipt_policy(receipt, "bootstrap-prepare")
    if set(documents) not in (
        {POSTGRES_CONTAINER, NGINX_CONTAINER},
        set(MANAGED_CONTAINERS),
    ):
        raise DeployError("LEGACY_ROLLBACK_CONTAINER_SET_UNAUTHORIZED")
    snapshot = _validate_legacy_restore_sidecars(documents, receipt)
    flowise = documents.get(FLOWISE_CONTAINER)
    if not isinstance(flowise, dict) and not allow_flowise_absent:
        raise DeployError("LEGACY_ROLLBACK_FLOWISE_MISSING")
    flowise_container_id = _flowise_container_id(documents)
    expected = _legacy_restore_expected_state(run_dir, receipt, key)
    if isinstance(flowise, dict):
        network_identity = validate_runtime_network_identity(
            documents,
            receipt["baseline"]["network_identity"],
        )
        config = flowise.get("Config") or {}
        if (
            config.get("Image") != receipt["legacy"]["image_tag"]
            or flowise.get("Image") != receipt["legacy"]["image_config_digest"]
        ):
            raise DeployError("LEGACY_ROLLBACK_FLOWISE_IMAGE_MISMATCH")
        config_hash = (config.get("Labels") or {}).get("com.docker.compose.config-hash")
        legacy_hashes = {
            receipt["legacy"]["runtime_label_config_hash"],
            receipt["legacy"]["live_computed_config_hash"],
        }
        hardened_hash = receipt["hardened_active"]["compose_config_hash"]
        if hardened_hash in legacy_hashes:
            raise DeployError("LEGACY_ROLLBACK_CONFIG_HASH_BINDING_AMBIGUOUS")
        actual_environment = _container_env(flowise)
        if config_hash in legacy_hashes:
            runtime_profile = "legacy"
            if (
                actual_environment != expected["legacy_environment"]
                or runtime_projection_digest(documents) != receipt["legacy"]["runtime_projection_digest"]
            ):
                raise DeployError("LEGACY_ROLLBACK_RUNTIME_BINDING_MISMATCH")
            runtime_config = expected["legacy_config"]
        elif config_hash == hardened_hash:
            runtime_profile = "hardened"
            if (
                actual_environment != expected["hardened_environment"]
                or _hardened_runtime_stable_projection(flowise)
                != _expected_hardened_runtime_stable_projection(expected["hardened_config"])
            ):
                raise DeployError("LEGACY_ROLLBACK_RUNTIME_BINDING_MISMATCH")
            runtime_config = expected["hardened_config"]
        else:
            raise DeployError("LEGACY_ROLLBACK_RUNTIME_CONFIG_HASH_MISMATCH")
        validate_database_runtime_identity(runtime_config, documents)
        validate_key_continuity(documents, actual_environment, key)
    else:
        runtime_profile = "absent"
        config_hash = None
        network_identity = None
    if database_state(include_name_digest=True) != receipt["baseline"]["database"]:
        raise DeployError("LEGACY_ROLLBACK_DATABASE_BASELINE_DRIFT")

    live = _live_hashes()
    legacy_files = receipt["legacy"]["files"]
    hardened_files = receipt["hardened_active"]["files"]
    tokens: list[str] = []
    for name in ("seccomp", "compose", "env"):
        if live[name] == legacy_files[name]:
            tokens.append("L")
        elif live[name] == hardened_files[name]:
            tokens.append("H")
        else:
            raise DeployError("LEGACY_ROLLBACK_LIVE_FILE_STATE_UNAUTHORIZED")
    file_state = "".join(tokens)
    allowed_states = {"LLL", "HLL", "HHL", "HHH", "LHH", "LLH"}
    if file_state not in allowed_states:
        raise DeployError("LEGACY_ROLLBACK_LIVE_FILE_STATE_UNAUTHORIZED")
    return {
        "file_state": file_state,
        "runtime_profile": runtime_profile,
        "runtime_config_hash": config_hash,
        "flowise_container_id": flowise_container_id,
        "snapshot": snapshot,
        "network_identity": network_identity,
        "expected": expected,
    }


def _legacy_rollback_complete(
    classification: dict[str, Any],
    receipt: dict[str, Any],
    documents: dict[str, dict[str, Any]],
    key: bytes,
    *,
    raise_on_validation_failure: bool = False,
) -> dict[str, Any] | None:
    if classification["file_state"] != "LLL" or classification["runtime_profile"] != "legacy":
        return None
    expected = classification["expected"]
    try:
        validate_container_health(documents)
        runtime = validate_legacy_runtime(
            documents,
            image_tag=receipt["legacy"]["image_tag"],
            image_digest=receipt["legacy"]["image_config_digest"],
            expected_config_hash=classification["runtime_config_hash"],
            expected_environment=expected["legacy_environment"],
            expected_runtime_projection_digest=receipt["legacy"]["runtime_projection_digest"],
        )
        validate_database_runtime_identity(expected["legacy_config"], documents)
        validate_runtime_network_identity(
            documents,
            receipt["baseline"]["network_identity"],
        )
        validate_key_continuity(documents, expected["legacy_environment"], key)
        runtime_pings()
    except DeployError:
        if raise_on_validation_failure:
            raise
        return None
    return {"containers": classification["snapshot"], **runtime}


def _checkpoint_legacy_rollback_step(
    run_dir: Path,
    journal: dict[str, Any] | None,
    file_state: str,
    *,
    pre_recreate_flowise_container_id: str | None = None,
) -> None:
    if journal is None:
        return
    recreate_starting = file_state == "legacy_recreate_starting"
    if recreate_starting:
        existing = journal.get("flowise_absent_recovery")
        if not (
            isinstance(existing, dict)
            and existing.get("origin") == "legacy_recreate_starting"
            and _legacy_recreate_window_matches(
                journal,
                existing,
                "legacy_recreate_starting",
            )
        ):
            marker_id = pre_recreate_flowise_container_id or "absent"
            journal["flowise_absent_recovery"] = _legacy_recreate_window_marker(
                journal,
                "legacy_recreate_starting",
                marker_id,
            )
    journal.update(
        {
            "state": "rolling_back",
            "phase": (
                "legacy_recreate_starting"
                if recreate_starting
                else "legacy_rollback_files_restoring"
            ),
            "rollback_step": file_state,
            "updated_at": utc_now(),
        }
    )
    _journal(run_dir, journal)


def _install_legacy_files_from_state(
    run_dir: Path,
    receipt: dict[str, Any],
    expected: dict[str, Any],
    file_state: str,
    journal: dict[str, Any] | None,
) -> None:
    metadata = receipt["live_metadata"]
    while file_state != "LLL":
        if file_state in {"HHH", "HLL"}:
            _remove_live_seccomp()
            if _live_hashes()["seccomp"] != receipt["legacy"]["files"]["seccomp"]:
                raise DeployError("LEGACY_ROLLBACK_SECCOMP_RESTORE_MISMATCH")
            file_state = "LHH" if file_state == "HHH" else "LLL"
        elif file_state in {"LHH", "HHL"}:
            uid, gid, mode = metadata["compose"]
            atomic_write(LIVE_COMPOSE, expected["legacy_compose"], mode, uid, gid)
            if sha256_file(LIVE_COMPOSE) != receipt["legacy"]["files"]["compose"]:
                raise DeployError("LEGACY_ROLLBACK_COMPOSE_RESTORE_MISMATCH")
            file_state = "LLH" if file_state == "LHH" else "HLL"
        elif file_state == "LLH":
            uid, gid, mode = metadata["env"]
            atomic_write(LIVE_ENV, expected["legacy_env"], mode, uid, gid)
            if sha256_file(LIVE_ENV) != receipt["legacy"]["files"]["env"]:
                raise DeployError("LEGACY_ROLLBACK_ENV_RESTORE_MISMATCH")
            file_state = "LLL"
        else:
            raise DeployError("LEGACY_ROLLBACK_LIVE_FILE_STATE_UNAUTHORIZED")
        _checkpoint_legacy_rollback_step(run_dir, journal, file_state)


def _restore_legacy_frozen(
    run_dir: Path,
    receipt: dict[str, Any],
    before: dict[str, dict[str, Any]],
    key: bytes,
    journal: dict[str, Any] | None = None,
    *,
    allow_flowise_absent: bool = False,
) -> dict[str, Any]:
    """Restore the exact legacy state; never route through hardened rollback."""

    classification = _classify_legacy_rollback_live_state(
        run_dir,
        receipt,
        before,
        key,
        allow_flowise_absent=allow_flowise_absent,
    )
    before_snapshot = classification["snapshot"]
    _ensure_legacy_image(run_dir, receipt)
    _install_legacy_files_from_state(
        run_dir,
        receipt,
        classification["expected"],
        classification["file_state"],
        journal,
    )
    if _live_hashes() != receipt["legacy"]["files"]:
        raise DeployError("LEGACY_ROLLBACK_LIVE_FILE_HASH_MISMATCH")
    resolved_legacy, computed_hash, compose_environment = _resolved_live(receipt["legacy"]["image_tag"], key)
    expected = classification["expected"]
    if (
        computed_hash != receipt["legacy"]["live_computed_config_hash"]
        or resolved_legacy != expected["legacy_config"]
        or compose_environment != service_environment(expected["legacy_config"])
    ):
        raise DeployError("LEGACY_ROLLBACK_COMPUTED_HASH_MISMATCH")
    _checkpoint_legacy_rollback_step(
        run_dir,
        journal,
        "legacy_recreate_starting",
        pre_recreate_flowise_container_id=classification.get("flowise_container_id"),
    )
    compose_recreate()
    after = inspect_containers()
    runtime = validate_legacy_runtime(
        after,
        image_tag=receipt["legacy"]["image_tag"],
        image_digest=receipt["legacy"]["image_config_digest"],
        expected_config_hash=computed_hash,
        expected_environment=expected["legacy_environment"],
        expected_runtime_projection_digest=receipt["legacy"]["runtime_projection_digest"],
    )
    validate_database_runtime_identity(resolved_legacy, after)
    validate_runtime_network_identity(
        after,
        receipt["baseline"]["network_identity"],
    )
    _validate_sidecars(before, after)
    after_snapshot = container_snapshot(after)
    for name in (POSTGRES_CONTAINER, NGINX_CONTAINER):
        if after_snapshot[name] != receipt["baseline"]["containers"][name]:
            raise DeployError(f"LEGACY_ROLLBACK_SIDECAR_POSTCHECK_DRIFT_{name}")
    validate_key_continuity(after, expected["legacy_environment"], key)
    if database_state(include_name_digest=True) != receipt["baseline"]["database"]:
        raise DeployError("DATABASE_DRIFT_AFTER_LEGACY_ROLLBACK")
    if _live_hashes() != receipt["legacy"]["files"]:
        raise DeployError("LEGACY_ROLLBACK_LIVE_POSTCHECK_FAILED")
    runtime_pings()
    return {"containers": after_snapshot, **runtime}


def _execute_legacy_rollback_transaction(
    run_dir: Path,
    receipt: dict[str, Any],
    journal: dict[str, Any],
    key: bytes,
    *,
    intent_phase: str,
    failure_phase: str,
    failure_code: str,
    failure_context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resume an idempotent legacy restore and never repeat a proven-complete recreate."""

    _validate_present_legacy_recreate_marker(journal)
    absent_origin = _legacy_absent_flowise_authorization(run_dir, receipt, journal)
    before = inspect_legacy_recovery_containers()
    recreate_already_observed = _legacy_recreate_already_observed(journal, before)

    def fail_manual(rollback_error: Exception) -> None:
        journal.update(
            {
                "state": "rollback_failed_manual_intervention_required",
                "phase": failure_phase,
                "rollback_attempted": True,
                "rollback_error": str(rollback_error)
                if isinstance(rollback_error, DeployError)
                else "UNEXPECTED_INTERNAL_FAILURE",
                "updated_at": utc_now(),
                **(failure_context or {}),
            }
        )
        _journal(run_dir, journal)

    try:
        classification = _classify_legacy_rollback_live_state(
            run_dir,
            receipt,
            before,
            key,
            allow_flowise_absent=absent_origin is not None,
        )
        _validate_legacy_rollback_resume_progress(journal, classification["file_state"])
        completed = None
        if recreate_already_observed:
            completed = _legacy_rollback_complete(
                classification,
                receipt,
                before,
                key,
                raise_on_validation_failure=recreate_already_observed,
            )
        if recreate_already_observed and completed is None:
            raise DeployError("LEGACY_RECREATE_ALREADY_OBSERVED_INCOMPLETE")
    except Exception as validation_error:
        if recreate_already_observed:
            fail_manual(validation_error)
            raise DeployError(failure_code) from validation_error
        raise
    if completed is not None:
        return completed
    if classification["runtime_profile"] == "absent" and absent_origin is not None:
        existing = journal.get("flowise_absent_recovery")
        if not _legacy_recreate_window_matches(journal, existing, absent_origin):
            journal["flowise_absent_recovery"] = _legacy_recreate_window_marker(
                journal,
                absent_origin,
                "absent",
            )
    journal.update(
        {
            "state": "rolling_back",
            "phase": intent_phase,
            "rollback_step": classification["file_state"],
            "rollback_attempted": False,
            "updated_at": utc_now(),
        }
    )
    _journal(run_dir, journal)
    try:
        return _restore_legacy_frozen(
            run_dir,
            receipt,
            before,
            key,
            journal,
            allow_flowise_absent=absent_origin is not None,
        )
    except Exception as rollback_error:
        fail_manual(rollback_error)
        raise DeployError(failure_code) from rollback_error


def bootstrap(
    bundle_dir: Path,
    run_id: str,
    transition_permit_path: Path,
    transition_permit_sha256: str,
) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    run_dir: Path | None = None
    journal: dict[str, Any] | None = None
    baseline: dict[str, Any] | None = None
    prepare_receipt: dict[str, Any] | None = None
    live_written = False
    try:
        bundle = verify_bundle(bundle_dir)
        permit = verify_transition_permit(
            transition_permit_path,
            transition_permit_sha256,
            bundle=bundle,
            run_id=run_id,
        )
        existing_run = RUNS_DIR / run_id
        if existing_run.exists() or existing_run.is_symlink():
            # A retry may recover only its own permit- and bundle-bound bootstrap.
            # Unrelated interrupted runs are blockers, never implicit write authority.
            _recover_interrupted_runs(
                only_run_id=run_id,
                expected_bootstrap_permit_digest=permit.digest,
                expected_target_bundle_digest=bundle.bundle_digest,
            )
            raise DeployError("RUN_DIRECTORY_EXISTS")
        baseline = _bootstrap_preflight(bundle, permit, check_current_journals=True)
        run_dir = _create_run_dir(run_id)
        journal = {
            "schema_version": 1,
            "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap",
            "state": "in_progress",
            "phase": "permitted_legacy_baseline_verified",
            "run_id": run_id,
            "permit_digest": permit.digest,
            "target_bundle_digest": bundle.bundle_digest,
            "target_bundle_release_id": bundle.release_id,
            "active_legacy_release_id": f"git-{baseline['active_revision']}",
            "live_write_started": False,
            "hardened_recreate_started": False,
            "rollback_attempted": False,
            "updated_at": utc_now(),
        }
        _journal(run_dir, journal)

        hardened_active_env = render_env(baseline["live_env"], baseline["active_tag"])
        target_bundle_env = render_env(baseline["live_env"], bundle.image_tag)
        hardened_compose = read_bundle_payload(
            bundle.files["production_compose"],
            bundle.file_entries["production_compose"]["bytes"],
            bundle.file_entries["production_compose"]["digest"],
        )
        hardened_seccomp = read_bundle_payload(
            bundle.files["chromium_seccomp"],
            bundle.file_entries["chromium_seccomp"]["bytes"],
            bundle.file_entries["chromium_seccomp"]["digest"],
        )
        legacy_files = _write_staged_tree(
            run_dir / "legacy",
            baseline["live_env"],
            baseline["live_compose"],
            None,
        )
        hardened_active_files = _write_staged_tree(
            run_dir / "hardened_active",
            hardened_active_env,
            hardened_compose,
            hardened_seccomp,
        )
        target_bundle_files = _write_staged_tree(
            run_dir / "target_bundle",
            target_bundle_env,
            hardened_compose,
            hardened_seccomp,
        )
        if legacy_files != baseline["live_hashes"]:
            raise DeployError("BOOTSTRAP_LEGACY_FREEZE_HASH_MISMATCH")

        legacy_archive = run_dir / "legacy/image.tar.gz"
        legacy_archive_bytes, legacy_archive_digest = save_rollback_archive(
            baseline["active_tag"],
            legacy_archive,
        )
        _validate_secure_run_role(run_dir, "legacy")
        verify_legacy_archive_contract(
            legacy_archive,
            image_tag=baseline["active_tag"],
            image_config_digest=baseline["active_image_digest"],
            revision=baseline["active_revision"],
            release_id=baseline["active_image"]["release_id"],
            repository_url=baseline["active_image"]["repository_url"],
            created_at=baseline["active_image"]["created_at"],
        )
        journal.update({"phase": "legacy_and_hardening_configs_frozen", "updated_at": utc_now()})
        _journal(run_dir, journal)

        hardened_active_root = run_dir / "hardened_active"
        target_bundle_root = run_dir / "target_bundle"
        hardened_active_config = compose_config(
            hardened_active_root / ".env.production",
            hardened_active_root / "docker-compose.prod.yml",
            hardened_active_root,
        )
        target_bundle_config = compose_config(
            target_bundle_root / ".env.production",
            target_bundle_root / "docker-compose.prod.yml",
            target_bundle_root,
        )
        if _compose_without_flowise_image(hardened_active_config) != _compose_without_flowise_image(
            target_bundle_config
        ):
            raise DeployError("BOOTSTRAP_TARGET_BUNDLE_NON_IMAGE_DRIFT")
        validate_hardened_compose(hardened_active_config, baseline["active_tag"], baseline["key"])
        validate_hardened_compose(target_bundle_config, bundle.image_tag, baseline["key"])
        validate_database_runtime_identity(hardened_active_config, baseline["documents"])
        hardened_active_config_hash = compose_service_hash(
            hardened_active_root / ".env.production",
            hardened_active_root / "docker-compose.prod.yml",
            hardened_active_root,
        )
        target_bundle_config_hash = compose_service_hash(
            target_bundle_root / ".env.production",
            target_bundle_root / "docker-compose.prod.yml",
            target_bundle_root,
        )
        hardened_active_environment = expected_container_environment(
            baseline["active_image"]["image_environment"],
            service_environment(hardened_active_config),
        )
        hardened_active_environment_binding = runtime_environment_binding(
            hardened_active_environment,
            baseline["key"],
        )

        revalidated = _bootstrap_preflight(
            bundle,
            permit,
            check_current_journals=True,
            current_run_id=run_id,
        )
        _validate_bootstrap_cas(baseline, revalidated)
        prepare_receipt = {
            "schema_version": 1,
            "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap",
            "state": "prepared_legacy_frozen",
            "run_id": run_id,
            "permit": {"digest": permit.digest},
            "target_bundle": {
                "bundle_digest": bundle.bundle_digest,
                "release_id": bundle.release_id,
                "revision": bundle.revision,
                "image_tag": bundle.image_tag,
                "image_config_digest": bundle.image_config_digest,
                "files": target_bundle_files,
                "compose_config_hash": target_bundle_config_hash,
            },
            "hardened_active": {
                "release_id": f"git-{baseline['active_revision']}",
                "revision": baseline["active_revision"],
                "image_tag": baseline["active_tag"],
                "image_config_digest": baseline["active_image_digest"],
                "repository_url": baseline["active_image"]["repository_url"],
                "created_at": baseline["active_image"]["created_at"],
                "files": hardened_active_files,
                "compose_config_hash": hardened_active_config_hash,
                **hardened_active_environment_binding,
            },
            "legacy": {
                "release_id": f"git-{baseline['active_revision']}",
                "revision": baseline["active_revision"],
                "image_tag": baseline["active_tag"],
                "image_config_digest": baseline["active_image_digest"],
                "repository_url": baseline["active_image"]["repository_url"],
                "created_at": baseline["active_image"]["created_at"],
                "files": legacy_files,
                "archive": {"bytes": legacy_archive_bytes, "digest": legacy_archive_digest},
                "runtime_label_config_hash": baseline["legacy_runtime_label_hash"],
                "live_computed_config_hash": baseline["legacy_config_hash"],
                "runtime_projection_digest": permit.document["active_legacy"]["runtime_projection_digest"],
                **baseline["legacy_environment_binding"],
            },
            "baseline": {
                "containers": baseline["snapshot"],
                "database": baseline["database"],
                "network_identity": baseline["network_identity"],
                "legacy_journal_inventory": baseline["legacy_journal_inventory"],
                "current_journal_inventory": baseline["current_journal_inventory"],
            },
            "live_metadata": baseline["live_metadata"],
            "target_bundle_non_image_match": True,
            "candidate_archive_loaded": False,
            "key_continuity_verified": True,
            "container_recreated": False,
            "provider_call": False,
            "created_at": utc_now(),
        }
        prepare_digest = _write_receipt(_receipt_path(run_dir, "bootstrap-prepare"), prepare_receipt)
        journal.update(
            {
                "phase": "bootstrap_prepare_receipt_written",
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)

        journal.update(
            {
                "live_write_started": True,
                "phase": "hardened_config_installing",
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)
        live_written = True
        install_config_set(
            hardened_active_env,
            hardened_compose,
            hardened_seccomp,
            baseline["live_metadata"],
        )
        if _live_hashes() != hardened_active_files:
            raise DeployError("BOOTSTRAP_HARDENED_ACTIVE_LIVE_FILE_HASH_MISMATCH")
        resolved_hardened, expected_hash, compose_environment = _resolved_live(
            baseline["active_tag"],
            baseline["key"],
        )
        if (
            expected_hash != hardened_active_config_hash
            or resolved_hardened != hardened_active_config
            or compose_environment != service_environment(hardened_active_config)
        ):
            raise DeployError("BOOTSTRAP_HARDENED_ACTIVE_CONFIG_HASH_MISMATCH")
        journal.update(
            {
                "hardened_recreate_started": True,
                "phase": "hardened_recreate_intent",
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)
        compose_recreate()
        after = inspect_containers()
        runtime = validate_bootstrap_hardened_runtime(
            after,
            image_tag=baseline["active_tag"],
            image_digest=baseline["active_image_digest"],
            expected_config_hash=expected_hash,
            expected_environment=hardened_active_environment,
            expected_compose=hardened_active_config,
            expected_network_identity=baseline["network_identity"],
        )
        _validate_runtime_environment_binding(
            prepare_receipt["hardened_active"],
            hardened_active_environment,
            baseline["key"],
            "BOOTSTRAP_HARDENED_ACTIVE",
        )
        validate_database_runtime_identity(hardened_active_config, after)
        after_snapshot = container_snapshot(after)
        if after_snapshot[FLOWISE_CONTAINER]["id"] == baseline["snapshot"][FLOWISE_CONTAINER]["id"]:
            raise DeployError("BOOTSTRAP_FLOWISE_NOT_RECREATED")
        _validate_sidecars(baseline["documents"], after)
        validate_key_continuity(after, hardened_active_environment, baseline["key"])
        if database_state(include_name_digest=True) != baseline["database"]:
            raise DeployError("DATABASE_DRIFT_AFTER_BOOTSTRAP")
        if _live_hashes() != hardened_active_files:
            raise DeployError("BOOTSTRAP_HARDENED_ACTIVE_LIVE_POSTCHECK_FAILED")
        runtime_pings()
        complete_receipt = {
            "schema_version": 1,
            "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap",
            "state": "complete_hardened_baseline",
            "run_id": run_id,
            "bootstrap_prepare_receipt_sha256": prepare_digest,
            "permit_digest": permit.digest,
            "target_bundle": prepare_receipt["target_bundle"],
            "hardened_active": prepare_receipt["hardened_active"],
            "runtime": {"containers": after_snapshot, **runtime},
            "database": baseline["database"],
            "key_continuity_verified": True,
            "database_unchanged": True,
            "sidecars_unchanged": True,
            "provider_call": False,
            "created_at": utc_now(),
        }
        complete_digest = _write_receipt(_receipt_path(run_dir, "bootstrap-complete"), complete_receipt)
        journal.update(
            {
                "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
                "state": "complete_hardened_baseline",
                "phase": "complete",
                "permit_digest": permit.digest,
                "target_bundle_digest": prepare_receipt["target_bundle"]["bundle_digest"],
                "target_bundle_release_id": prepare_receipt["target_bundle"]["release_id"],
                "active_legacy_release_id": prepare_receipt["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": prepare_digest,
                "bootstrap_complete_receipt_sha256": complete_digest,
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)
        return {
            "status": "complete_hardened_baseline",
            "run_id": run_id,
            "bootstrap_prepare_receipt_sha256": prepare_digest,
            "bootstrap_complete_receipt_sha256": complete_digest,
            "active_image": baseline["active_tag"],
            "target_candidate_image": bundle.image_tag,
        }
    except Exception as forward_error:
        if live_written and run_dir is not None and prepare_receipt is not None and baseline is not None:
            if journal is None:
                journal = {
                    "schema_version": 1,
                    "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
                    "operation": "bootstrap",
                    "run_id": run_id,
                }
            try:
                rollback_runtime = _execute_legacy_rollback_transaction(
                    run_dir,
                    prepare_receipt,
                    journal,
                    baseline["key"],
                    intent_phase="automatic_legacy_rollback_restoring",
                    failure_phase="automatic_legacy_rollback_failed",
                    failure_code="BOOTSTRAP_FORWARD_AND_LEGACY_ROLLBACK_FAILED",
                    failure_context={
                        "forward_error": str(forward_error)
                        if isinstance(forward_error, DeployError)
                        else "UNEXPECTED_INTERNAL_FAILURE"
                    },
                )
                journal.update(
                    {
                        "state": "bootstrap_rolled_back_legacy",
                        "phase": "automatic_legacy_rollback_complete",
                        "forward_error": str(forward_error)
                        if isinstance(forward_error, DeployError)
                        else "UNEXPECTED_INTERNAL_FAILURE",
                        "rollback_runtime": rollback_runtime,
                        "updated_at": utc_now(),
                    }
                )
                _journal(run_dir, journal)
            except DeployError:
                raise
        elif journal is not None and run_dir is not None:
            journal.update(
                {
                    "state": "bootstrap_failed_before_live_write",
                    "phase": "bootstrap_prewrite_failure",
                    "forward_error": str(forward_error)
                    if isinstance(forward_error, DeployError)
                    else "UNEXPECTED_INTERNAL_FAILURE",
                    "updated_at": utc_now(),
                }
            )
            try:
                _journal(run_dir, journal)
            except Exception:
                pass
        raise forward_error
    finally:
        os.close(lock)


def cutover(run_id: str, prepare_receipt_sha256: str) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    run_dir: Path | None = None
    journal: dict[str, Any] | None = None
    live_written = False
    before: dict[str, dict[str, Any]] | None = None
    receipt: dict[str, Any] | None = None
    key: bytes | None = None
    try:
        _recover_interrupted_runs()
        run_dir, receipt, before, key = _cutover_preflight(run_id, prepare_receipt_sha256)
        if _receipt_path(run_dir, "cutover").exists():
            raise DeployError("CUTOVER_RECEIPT_ALREADY_EXISTS")
        journal = {
            "schema_version": 1,
            "operation": "cutover",
            "state": "in_progress",
            "phase": "preflight_verified",
            "run_id": run_id,
            "release_id": receipt["release"]["release_id"],
            "live_write_started": False,
            "candidate_recreate_started": False,
            "rollback_attempted": False,
            "updated_at": utc_now(),
        }
        _journal(run_dir, journal)
        _, candidate_env, candidate_compose, candidate_seccomp = _load_staged(receipt, "candidate", run_dir)
        live_written = True
        journal["live_write_started"] = True
        journal["phase"] = "candidate_config_installing"
        journal["updated_at"] = utc_now()
        _journal(run_dir, journal)
        install_config_set(candidate_env, candidate_compose, candidate_seccomp, receipt["live_metadata"])
        if _live_hashes() != receipt["candidate"]["files"]:
            raise DeployError("CANDIDATE_LIVE_FILE_HASH_MISMATCH")
        resolved_candidate, expected_hash, environment = _resolved_live(receipt["release"]["image_tag"], key)
        journal["candidate_recreate_started"] = True
        journal["phase"] = "candidate_recreate_intent"
        journal["updated_at"] = utc_now()
        _journal(run_dir, journal)
        compose_recreate()
        after = inspect_containers()
        runtime = validate_runtime(
            after,
            image_tag=receipt["release"]["image_tag"],
            image_digest=receipt["release"]["image_config_digest"],
            expected_config_hash=expected_hash,
            expected_environment=environment,
            require_candidate_hardening=True,
            expected_compose=resolved_candidate,
            expected_runtime=receipt["baseline"]["containers"][FLOWISE_CONTAINER]["runtime"],
        )
        validate_database_runtime_identity(resolved_candidate, after)
        if container_snapshot(after)[FLOWISE_CONTAINER]["id"] == receipt["baseline"]["containers"][FLOWISE_CONTAINER]["id"]:
            raise DeployError("FLOWISE_NOT_RECREATED")
        _validate_sidecars(before, after)
        validate_key_continuity(after, environment, key)
        if database_state() != receipt["baseline"]["database"]:
            raise DeployError("DATABASE_DRIFT_AFTER_CUTOVER")
        if _live_hashes() != receipt["candidate"]["files"]:
            raise DeployError("CANDIDATE_LIVE_CONFIG_POSTCHECK_FAILED")
        runtime_pings()
        cutover_receipt = {
            "schema_version": 1,
            "operation": "cutover",
            "state": "complete_candidate_active",
            "run_id": run_id,
            "release": receipt["release"],
            "runtime": {"containers": container_snapshot(after), **runtime},
            "live_files": receipt["candidate"]["files"],
            "key_continuity_verified": True,
            "database_unchanged": True,
            "sidecars_unchanged": True,
            "provider_call": False,
            "created_at": utc_now(),
        }
        digest = _write_receipt(_receipt_path(run_dir, "cutover"), cutover_receipt)
        journal.update({"state": "complete_candidate_active", "phase": "complete", "updated_at": utc_now()})
        _journal(run_dir, journal)
        return {
            "status": "complete_candidate_active",
            "run_id": run_id,
            "cutover_receipt_sha256": digest,
            "candidate_image": receipt["release"]["image_tag"],
        }
    except Exception as forward_error:
        if live_written and run_dir is not None and receipt is not None and before is not None and key is not None:
            if journal is None:
                journal = {"schema_version": 1, "operation": "cutover", "run_id": run_id}
            _mark_rollback_attempt(run_dir, journal, "automatic_rollback_intent")
            try:
                rollback_runtime = _restore_rollback(run_dir, receipt, before, key)
                journal.update(
                    {
                        "state": "rolled_back",
                        "phase": "automatic_rollback_complete",
                        "forward_error": str(forward_error) if isinstance(forward_error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                        "rollback_runtime": rollback_runtime,
                        "updated_at": utc_now(),
                    }
                )
                _journal(run_dir, journal)
            except Exception as rollback_error:
                journal.update(
                    {
                        "state": "rollback_failed_manual_intervention_required",
                        "phase": "automatic_rollback_failed",
                        "forward_error": str(forward_error) if isinstance(forward_error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                        "rollback_error": str(rollback_error) if isinstance(rollback_error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                        "updated_at": utc_now(),
                    }
                )
                try:
                    _journal(run_dir, journal)
                except Exception:
                    pass
                raise DeployError("FORWARD_AND_ROLLBACK_FAILED") from rollback_error
        elif journal is not None and run_dir is not None:
            journal.update(
                {
                    "state": "failed_before_live_write",
                    "phase": "pre_recreate_failure_no_live_write",
                    "forward_error": str(forward_error) if isinstance(forward_error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                    "updated_at": utc_now(),
                }
            )
            try:
                _journal(run_dir, journal)
            except Exception:
                pass
        raise forward_error
    finally:
        os.close(lock)


def rollback(run_id: str, prepare_receipt_sha256: str, cutover_receipt_sha256: str) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    try:
        _recover_interrupted_runs()
        run_dir, receipt = _read_receipt(run_id, "prepare", prepare_receipt_sha256)
        _, cutover_receipt = _read_receipt(run_id, "cutover", cutover_receipt_sha256)
        if cutover_receipt.get("state") != "complete_candidate_active":
            raise DeployError("CUTOVER_RECEIPT_STATE_INVALID")
        if _receipt_path(run_dir, "rollback").exists():
            raise DeployError("ROLLBACK_RECEIPT_ALREADY_EXISTS")
        before = inspect_containers()
        validate_container_health(before)
        if container_snapshot(before)[FLOWISE_CONTAINER]["image_ref"] != receipt["release"]["image_tag"]:
            raise DeployError("MANUAL_ROLLBACK_CANDIDATE_NOT_ACTIVE")
        key = persistent_key()
        journal = {
            "schema_version": 1,
            "operation": "rollback",
            "state": ROLLBACK_ATTEMPTED_STATE,
            "phase": "manual_rollback_intent",
            "run_id": run_id,
            "release_id": receipt["release"]["release_id"],
            "rollback_attempted": True,
            "updated_at": utc_now(),
        }
        _journal(run_dir, journal)
        try:
            runtime = _restore_rollback(run_dir, receipt, before, key)
        except Exception as rollback_error:
            journal.update(
                {
                    "state": "rollback_failed_manual_intervention_required",
                    "phase": "manual_rollback_failed",
                    "rollback_error": str(rollback_error)
                    if isinstance(rollback_error, DeployError)
                    else "UNEXPECTED_INTERNAL_FAILURE",
                    "updated_at": utc_now(),
                }
            )
            _journal(run_dir, journal)
            raise
        rollback_receipt = {
            "schema_version": 1,
            "operation": "rollback",
            "state": "manual_rollback_complete",
            "run_id": run_id,
            "rollback": receipt["rollback"],
            "runtime": runtime,
            "database_unchanged": True,
            "sidecars_unchanged": True,
            "key_continuity_verified": True,
            "provider_call": False,
            "created_at": utc_now(),
        }
        digest = _write_receipt(_receipt_path(run_dir, "rollback"), rollback_receipt)
        journal.update({"state": "manual_rollback_complete", "phase": "complete", "updated_at": utc_now()})
        _journal(run_dir, journal)
        return {"status": "manual_rollback_complete", "run_id": run_id, "rollback_receipt_sha256": digest}
    finally:
        os.close(lock)


def _validate_bootstrap_rollback_journal_binding(
    journal: dict[str, Any],
    prepare_receipt: dict[str, Any],
    bootstrap_prepare_receipt_sha256: str,
    bootstrap_complete_receipt_sha256: str,
    *,
    resume: bool,
) -> None:
    _validate_policy(
        journal.get("policy"),
        LEGACY_BOOTSTRAP_POLICY,
        "BOOTSTRAP_ROLLBACK_JOURNAL",
    )
    target = prepare_receipt.get("target_bundle") or {}
    expected = {
        "schema_version": 1,
        "run_id": prepare_receipt.get("run_id"),
        "permit_digest": (prepare_receipt.get("permit") or {}).get("digest"),
        "target_bundle_digest": target.get("bundle_digest"),
        "target_bundle_release_id": target.get("release_id"),
        "active_legacy_release_id": (prepare_receipt.get("legacy") or {}).get("release_id"),
        "bootstrap_prepare_receipt_sha256": bootstrap_prepare_receipt_sha256,
        "bootstrap_complete_receipt_sha256": bootstrap_complete_receipt_sha256,
    }
    if any(journal.get(name) != value for name, value in expected.items()):
        raise DeployError("BOOTSTRAP_ROLLBACK_JOURNAL_BINDING_MISMATCH")
    if resume:
        if (
            journal.get("operation") != "bootstrap-rollback"
            or journal.get("state") != "rolling_back"
            or journal.get("phase")
            not in {
                "manual_legacy_rollback_restoring",
                "legacy_rollback_files_restoring",
                "legacy_recreate_starting",
            }
        ):
            raise DeployError("BOOTSTRAP_ROLLBACK_RESUME_STATE_INVALID")
    elif (
        journal.get("operation") != "bootstrap"
        or journal.get("state") != "complete_hardened_baseline"
        or journal.get("phase") != "complete"
    ):
        raise DeployError("BOOTSTRAP_ROLLBACK_BASELINE_JOURNAL_INVALID")


def _snapshot_matches_except_flowise_liveness(
    observed: Any,
    expected: Any,
) -> bool:
    if not isinstance(observed, dict) or not isinstance(expected, dict):
        return False
    if set(observed) != set(MANAGED_CONTAINERS) or set(expected) != set(MANAGED_CONTAINERS):
        return False
    observed_copy = copy.deepcopy(observed)
    expected_copy = copy.deepcopy(expected)
    for snapshot in (observed_copy, expected_copy):
        flowise = snapshot.get(FLOWISE_CONTAINER)
        if not isinstance(flowise, dict):
            return False
        flowise.pop("state", None)
        flowise.pop("health", None)
    return observed_copy == expected_copy


def bootstrap_rollback(
    run_id: str,
    bootstrap_prepare_receipt_sha256: str,
    bootstrap_complete_receipt_sha256: str,
) -> dict[str, Any]:
    require_root()
    lock = acquire_lock()
    try:
        run_dir, prepare_receipt = _read_receipt(
            run_id,
            "bootstrap-prepare",
            bootstrap_prepare_receipt_sha256,
        )
        complete_run_dir, complete_receipt = _read_receipt(
            run_id,
            "bootstrap-complete",
            bootstrap_complete_receipt_sha256,
        )
        _validate_receipt_policy(prepare_receipt, "bootstrap-prepare")
        _validate_receipt_policy(complete_receipt, "bootstrap-complete")
        if (
            complete_run_dir != run_dir
            or prepare_receipt.get("operation") != "bootstrap"
            or prepare_receipt.get("state") != "prepared_legacy_frozen"
            or complete_receipt.get("operation") != "bootstrap"
            or complete_receipt.get("state") != "complete_hardened_baseline"
            or complete_receipt.get("bootstrap_prepare_receipt_sha256")
            != bootstrap_prepare_receipt_sha256
            or complete_receipt.get("permit_digest") != (prepare_receipt.get("permit") or {}).get("digest")
            or complete_receipt.get("target_bundle") != prepare_receipt.get("target_bundle")
            or complete_receipt.get("hardened_active") != prepare_receipt.get("hardened_active")
        ):
            raise DeployError("BOOTSTRAP_RECEIPT_BINDING_MISMATCH")
        journal = _read_run_journal(run_dir)
        resume = journal.get("operation") == "bootstrap-rollback" and journal.get("state") == "rolling_back"
        if resume:
            _validate_bootstrap_rollback_journal_binding(
                journal,
                prepare_receipt,
                bootstrap_prepare_receipt_sha256,
                bootstrap_complete_receipt_sha256,
                resume=True,
            )
        elif journal.get("operation") == "bootstrap-rollback":
            if journal.get("state") == "rollback_failed_manual_intervention_required":
                raise DeployError("BOOTSTRAP_ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED")
            if journal.get("state") == "manual_legacy_rollback_complete":
                raise DeployError("BOOTSTRAP_ROLLBACK_RECEIPT_ALREADY_EXISTS")
            raise DeployError("BOOTSTRAP_ROLLBACK_JOURNAL_STATE_INVALID")
        else:
            _validate_bootstrap_rollback_journal_binding(
                journal,
                prepare_receipt,
                bootstrap_prepare_receipt_sha256,
                bootstrap_complete_receipt_sha256,
                resume=False,
            )

        # Exclude only this authenticated run; unrelated unresolved transactions
        # remain blockers and are never recovered as a side effect.
        current_journal_inventory(exclude_run_id=run_id)
        key = persistent_key()
        rollback_path = _receipt_path(run_dir, "bootstrap-rollback")
        if rollback_path.exists() or rollback_path.is_symlink():
            _, existing_receipt = _read_receipt(run_id, "bootstrap-rollback")
            exact_keys(
                existing_receipt,
                (
                    "schema_version",
                    "policy",
                    "operation",
                    "state",
                    "run_id",
                    "bootstrap_prepare_receipt_sha256",
                    "bootstrap_complete_receipt_sha256",
                    "target_bundle",
                    "hardened_active",
                    "legacy",
                    "runtime",
                    "database_unchanged",
                    "sidecars_unchanged",
                    "key_continuity_verified",
                    "provider_call",
                    "created_at",
                ),
                "BOOTSTRAP_ROLLBACK_RECEIPT",
            )
            if (
                not resume
                or existing_receipt.get("schema_version") != 1
                or existing_receipt.get("operation") != "bootstrap-rollback"
                or existing_receipt.get("state") != "manual_legacy_rollback_complete"
                or existing_receipt.get("bootstrap_prepare_receipt_sha256")
                != bootstrap_prepare_receipt_sha256
                or existing_receipt.get("bootstrap_complete_receipt_sha256")
                != bootstrap_complete_receipt_sha256
                or existing_receipt.get("target_bundle") != prepare_receipt.get("target_bundle")
                or existing_receipt.get("hardened_active") != prepare_receipt.get("hardened_active")
                or existing_receipt.get("legacy") != prepare_receipt.get("legacy")
                or existing_receipt.get("database_unchanged") is not True
                or existing_receipt.get("sidecars_unchanged") is not True
                or existing_receipt.get("key_continuity_verified") is not True
                or existing_receipt.get("provider_call") is not False
                or not _valid_timestamp(existing_receipt.get("created_at"))
            ):
                raise DeployError("BOOTSTRAP_ROLLBACK_RECEIPT_ALREADY_EXISTS")
            current = inspect_containers()
            classification = _classify_legacy_rollback_live_state(
                run_dir,
                prepare_receipt,
                current,
                key,
            )
            runtime = _legacy_rollback_complete(classification, prepare_receipt, current, key)
            if runtime is None or existing_receipt.get("runtime") != runtime:
                raise DeployError("BOOTSTRAP_ROLLBACK_RECEIPT_LIVE_STATE_MISMATCH")
            digest = sha256_bytes(canonical_json(existing_receipt))
            journal.update(
                {
                    "state": "manual_legacy_rollback_complete",
                    "phase": "complete",
                    "bootstrap_rollback_receipt_sha256": digest,
                    "rollback_runtime": runtime,
                    "updated_at": utc_now(),
                }
            )
            _journal(run_dir, journal)
            return {
                "status": "manual_legacy_rollback_complete",
                "run_id": run_id,
                "bootstrap_rollback_receipt_sha256": digest,
            }

        if not resume:
            before = inspect_containers()
            classification = _classify_legacy_rollback_live_state(
                run_dir,
                prepare_receipt,
                before,
                key,
            )
            runtime_receipt = complete_receipt.get("runtime") or {}
            if (
                classification["file_state"] != "HHH"
                or classification["runtime_profile"] != "hardened"
                or not _snapshot_matches_except_flowise_liveness(
                    classification["snapshot"],
                    runtime_receipt.get("containers"),
                )
            ):
                raise DeployError("BOOTSTRAP_ROLLBACK_HARDENED_BASELINE_DRIFT")
            journal = {
                "schema_version": 1,
                "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
                "operation": "bootstrap-rollback",
                "state": "in_progress",
                "phase": "manual_legacy_rollback_validated",
                "run_id": run_id,
                "target_bundle_release_id": prepare_receipt["target_bundle"]["release_id"],
                "permit_digest": prepare_receipt["permit"]["digest"],
                "target_bundle_digest": prepare_receipt["target_bundle"]["bundle_digest"],
                "active_legacy_release_id": prepare_receipt["legacy"]["release_id"],
                "bootstrap_prepare_receipt_sha256": bootstrap_prepare_receipt_sha256,
                "bootstrap_complete_receipt_sha256": bootstrap_complete_receipt_sha256,
                "rollback_attempted": False,
                "updated_at": utc_now(),
            }

        runtime = _execute_legacy_rollback_transaction(
            run_dir,
            prepare_receipt,
            journal,
            key,
            intent_phase="manual_legacy_rollback_restoring",
            failure_phase="manual_legacy_rollback_failed",
            failure_code="BOOTSTRAP_ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED",
        )
        rollback_receipt = {
            "schema_version": 1,
            "policy": _policy_copy(LEGACY_BOOTSTRAP_POLICY),
            "operation": "bootstrap-rollback",
            "state": "manual_legacy_rollback_complete",
            "run_id": run_id,
            "bootstrap_prepare_receipt_sha256": bootstrap_prepare_receipt_sha256,
            "bootstrap_complete_receipt_sha256": bootstrap_complete_receipt_sha256,
            "target_bundle": prepare_receipt["target_bundle"],
            "hardened_active": prepare_receipt["hardened_active"],
            "legacy": prepare_receipt["legacy"],
            "runtime": runtime,
            "database_unchanged": True,
            "sidecars_unchanged": True,
            "key_continuity_verified": True,
            "provider_call": False,
            "created_at": utc_now(),
        }
        digest = _write_receipt(_receipt_path(run_dir, "bootstrap-rollback"), rollback_receipt)
        journal.update(
            {
                "state": "manual_legacy_rollback_complete",
                "phase": "complete",
                "bootstrap_rollback_receipt_sha256": digest,
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)
        return {
            "status": "manual_legacy_rollback_complete",
            "run_id": run_id,
            "bootstrap_rollback_receipt_sha256": digest,
        }
    finally:
        os.close(lock)


def _recover_interrupted_runs(
    *,
    only_run_id: str | None = None,
    expected_bootstrap_permit_digest: str | None = None,
    expected_target_bundle_digest: str | None = None,
) -> None:
    scoped = only_run_id is not None
    if scoped:
        if (
            not isinstance(only_run_id, str)
            or not RUN_ID_RE.fullmatch(only_run_id)
            or not isinstance(expected_bootstrap_permit_digest, str)
            or not DIGEST_RE.fullmatch(expected_bootstrap_permit_digest)
            or not isinstance(expected_target_bundle_digest, str)
            or not DIGEST_RE.fullmatch(expected_target_bundle_digest)
        ):
            raise DeployError("SCOPED_BOOTSTRAP_RECOVERY_BINDING_INVALID")
    elif expected_bootstrap_permit_digest is not None or expected_target_bundle_digest is not None:
        raise DeployError("SCOPED_BOOTSTRAP_RECOVERY_BINDING_INVALID")
    try:
        root_info = RUNS_DIR.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise DeployError("RECOVERY_ROOT_UNAVAILABLE") from error
    if stat.S_ISLNK(root_info.st_mode) or not stat.S_ISDIR(root_info.st_mode):
        raise DeployError("RECOVERY_ROOT_UNSAFE")
    _validate_inventory_directory(RUNS_DIR, "RECOVERY_ROOT")
    if only_run_id is not None:
        run_directories = [RUNS_DIR / only_run_id]
    else:
        try:
            run_directories = sorted(RUNS_DIR.iterdir())
        except OSError as error:
            raise DeployError("RECOVERY_ROOT_ENUMERATION_FAILED") from error
    for run_dir in run_directories:
        try:
            run_info = run_dir.lstat()
        except FileNotFoundError:
            continue
        except OSError as error:
            raise DeployError("RECOVERY_RUN_DIRECTORY_UNAVAILABLE") from error
        if stat.S_ISLNK(run_info.st_mode):
            raise DeployError("RECOVERY_RUN_DIRECTORY_UNSAFE")
        if not stat.S_ISDIR(run_info.st_mode):
            continue
        _validate_inventory_directory(run_dir, "RECOVERY_RUN")
        journal_path = run_dir / "journal.json"
        if not journal_path.is_file() or journal_path.is_symlink():
            continue
        journal = parse_canonical_json(
            read_regular(journal_path, maximum=2 * 1024 * 1024, expected_uid=0, expected_gid=0, expected_mode=0o600),
            "JOURNAL",
        )
        state = journal.get("state")
        operation = journal.get("operation")
        run_id = journal.get("run_id")
        if (
            not isinstance(run_id, str)
            or not RUN_ID_RE.fullmatch(run_id)
            or run_id != run_dir.name
            or (only_run_id is not None and run_id != only_run_id)
        ):
            raise DeployError("INTERRUPTED_RUN_ID_INVALID")
        if scoped:
            if (
                operation != "bootstrap"
                or journal.get("permit_digest") != expected_bootstrap_permit_digest
                or journal.get("target_bundle_digest") != expected_target_bundle_digest
            ):
                raise DeployError("SCOPED_BOOTSTRAP_RECOVERY_BINDING_MISMATCH")
        if state in (
            "rollback_failed_manual_intervention_required",
            ROLLBACK_ATTEMPTED_STATE,
        ) or (state == "in_progress" and operation == "rollback"):
            raise DeployError("UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE")
        if state == "rolling_back" and operation == "bootstrap-rollback":
            raise DeployError("INTERRUPTED_MANUAL_LEGACY_ROLLBACK_REQUIRES_SAME_COMMAND")
        if state == "rolling_back" and operation != "bootstrap":
            raise DeployError("UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE")
        if state not in {"in_progress", "rolling_back"}:
            continue
        if operation == "bootstrap":
            _validate_policy(journal.get("policy"), LEGACY_BOOTSTRAP_POLICY, "BOOTSTRAP_JOURNAL")
            permit_digest = journal.get("permit_digest")
            target_bundle_digest = journal.get("target_bundle_digest")
            if (
                not isinstance(permit_digest, str)
                or not DIGEST_RE.fullmatch(permit_digest)
                or not isinstance(target_bundle_digest, str)
                or not DIGEST_RE.fullmatch(target_bundle_digest)
            ):
                raise DeployError("INTERRUPTED_BOOTSTRAP_JOURNAL_BINDING_INVALID")
            live_write_started = journal.get("live_write_started")
            if live_write_started is False:
                journal.update(
                    {
                        "state": "interrupted_bootstrap_before_live_write",
                        "phase": "legacy_frozen_no_live_write",
                        "updated_at": utc_now(),
                    }
                )
                _journal(run_dir, journal)
                raise DeployError("INTERRUPTED_BOOTSTRAP_BEFORE_LIVE_WRITE_RETRY_REQUIRED")
            if live_write_started is not True:
                raise DeployError("INTERRUPTED_BOOTSTRAP_WRITE_STATE_INVALID")
            prepare_digest = journal.get("bootstrap_prepare_receipt_sha256")
            if not isinstance(prepare_digest, str) or not DIGEST_RE.fullmatch(prepare_digest):
                raise DeployError("INTERRUPTED_BOOTSTRAP_PREPARE_RECEIPT_BINDING_INVALID")
            receipt_run_dir, receipt = _read_receipt(run_id, "bootstrap-prepare", prepare_digest)
            if (
                receipt_run_dir != run_dir
                or receipt.get("operation") != "bootstrap"
                or receipt.get("state") != "prepared_legacy_frozen"
                or (receipt.get("permit") or {}).get("digest") != permit_digest
                or (receipt.get("target_bundle") or {}).get("bundle_digest") != target_bundle_digest
            ):
                raise DeployError("INTERRUPTED_BOOTSTRAP_PREPARE_RECEIPT_BINDING_INVALID")
            key = persistent_key()
            runtime = _execute_legacy_rollback_transaction(
                run_dir,
                receipt,
                journal,
                key,
                intent_phase="interrupted_legacy_rollback_restoring",
                failure_phase="interrupted_legacy_rollback_failed",
                failure_code="INTERRUPTED_LEGACY_ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED",
            )
            journal.update(
                {
                    "state": "interrupted_bootstrap_recovered_to_legacy",
                    "phase": "legacy_rollback_complete_no_forward_resume",
                    "rollback_runtime": runtime,
                    "updated_at": utc_now(),
                }
            )
            _journal(run_dir, journal)
            raise DeployError("INTERRUPTED_BOOTSTRAP_RECOVERED_RETRY_REQUIRED")
        if operation == "prepare":
            journal.update({"state": "interrupted_prepare_aborted", "phase": "rollback_state_preserved", "updated_at": utc_now()})
            _journal(run_dir, journal)
            raise DeployError("INTERRUPTED_PREPARE_ABORTED_RETRY_REQUIRED")
        if operation != "cutover":
            raise DeployError("INTERRUPTED_OPERATION_INVALID")
        _, receipt = _read_receipt(run_id, "prepare")
        before = inspect_containers()
        key = persistent_key()
        _mark_rollback_attempt(run_dir, journal, "interrupted_rollback_intent")
        try:
            runtime = _restore_rollback(run_dir, receipt, before, key)
        except Exception as rollback_error:
            journal.update(
                {
                    "state": "rollback_failed_manual_intervention_required",
                    "phase": "interrupted_rollback_failed",
                    "rollback_error": str(rollback_error)
                    if isinstance(rollback_error, DeployError)
                    else "UNEXPECTED_INTERNAL_FAILURE",
                    "updated_at": utc_now(),
                }
            )
            _journal(run_dir, journal)
            raise DeployError("INTERRUPTED_ROLLBACK_FAILED_MANUAL_INTERVENTION_REQUIRED") from rollback_error
        journal.update(
            {
                "state": "interrupted_run_recovered_to_rollback",
                "phase": "rollback_complete_no_forward_resume",
                "rollback_runtime": runtime,
                "updated_at": utc_now(),
            }
        )
        _journal(run_dir, journal)
        raise DeployError("INTERRUPTED_RUN_RECOVERED_RETRY_REQUIRED")


def _digest_argument(value: str) -> str:
    normalized = value if value.startswith("sha256:") else f"sha256:{value}"
    if not DIGEST_RE.fullmatch(normalized):
        raise argparse.ArgumentTypeError("digest must be sha256 followed by 64 lowercase hexadecimal characters")
    return normalized


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify-bundle")
    verify.add_argument("--bundle-dir", required=True, type=Path)
    snapshot_parser = commands.add_parser("snapshot-transition")
    snapshot_parser.add_argument("--bundle-dir", required=True, type=Path)
    snapshot_parser.add_argument("--run-id", required=True)
    issue_parser = commands.add_parser("issue-transition-permit")
    issue_parser.add_argument("--bundle-dir", required=True, type=Path)
    issue_parser.add_argument("--run-id", required=True)
    issue_parser.add_argument("--expected-snapshot-sha256", required=True, type=_digest_argument)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--bundle-dir", required=True, type=Path)
    prepare_parser.add_argument("--run-id", required=True)
    bootstrap_parser = commands.add_parser("bootstrap")
    bootstrap_parser.add_argument("--bundle-dir", required=True, type=Path)
    bootstrap_parser.add_argument("--run-id", required=True)
    bootstrap_parser.add_argument("--transition-permit", required=True, type=Path)
    bootstrap_parser.add_argument("--transition-permit-sha256", required=True, type=_digest_argument)
    cutover_parser = commands.add_parser("cutover")
    cutover_parser.add_argument("--run-id", required=True)
    cutover_parser.add_argument("--prepare-receipt-sha256", required=True, type=_digest_argument)
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--run-id", required=True)
    rollback_parser.add_argument("--prepare-receipt-sha256", required=True, type=_digest_argument)
    rollback_parser.add_argument("--cutover-receipt-sha256", required=True, type=_digest_argument)
    bootstrap_rollback_parser = commands.add_parser("bootstrap-rollback")
    bootstrap_rollback_parser.add_argument("--run-id", required=True)
    bootstrap_rollback_parser.add_argument(
        "--bootstrap-prepare-receipt-sha256",
        required=True,
        type=_digest_argument,
    )
    bootstrap_rollback_parser.add_argument(
        "--bootstrap-complete-receipt-sha256",
        required=True,
        type=_digest_argument,
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    os.umask(0o077)
    arguments = parse_args(argv)
    if arguments.command == "verify-bundle":
        bundle = verify_bundle(arguments.bundle_dir)
        result = {
            "status": "bundle_verified",
            "release_id": bundle.release_id,
            "image_tag": bundle.image_tag,
            "bundle_sha256": bundle.bundle_digest,
            "production_write": False,
        }
    elif arguments.command == "snapshot-transition":
        result = snapshot_transition(arguments.bundle_dir, arguments.run_id)
    elif arguments.command == "issue-transition-permit":
        result = issue_transition_permit(
            arguments.bundle_dir,
            arguments.run_id,
            arguments.expected_snapshot_sha256,
        )
    elif arguments.command == "prepare":
        result = prepare(arguments.bundle_dir, arguments.run_id)
    elif arguments.command == "bootstrap":
        result = bootstrap(
            arguments.bundle_dir,
            arguments.run_id,
            arguments.transition_permit,
            arguments.transition_permit_sha256,
        )
    elif arguments.command == "cutover":
        result = cutover(arguments.run_id, arguments.prepare_receipt_sha256)
    elif arguments.command == "rollback":
        result = rollback(arguments.run_id, arguments.prepare_receipt_sha256, arguments.cutover_receipt_sha256)
    elif arguments.command == "bootstrap-rollback":
        result = bootstrap_rollback(
            arguments.run_id,
            arguments.bootstrap_prepare_receipt_sha256,
            arguments.bootstrap_complete_receipt_sha256,
        )
    else:
        raise DeployError("COMMAND_INVALID")
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            json.dumps(
                {
                    "status": "failed",
                    "error": str(error) if isinstance(error, DeployError) else "UNEXPECTED_INTERNAL_FAILURE",
                    "secret_value_output": False,
                    "provider_call": False,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )
        raise SystemExit(1)
