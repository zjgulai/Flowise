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
ENV_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")

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
            or before.st_nlink != 1
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


def _container_env(document: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in (document.get("Config") or {}).get("Env") or []:
        key, separator, value = str(item).partition("=")
        if not separator or not ENV_KEY_RE.fullmatch(key):
            raise DeployError("CONTAINER_ENVIRONMENT_INVALID")
        if key in result:
            raise DeployError("CONTAINER_ENVIRONMENT_DUPLICATE_KEY")
        result[key] = value
    return result


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


def validate_runtime(
    documents: dict[str, dict[str, Any]],
    *,
    image_tag: str,
    image_digest: str,
    expected_config_hash: str,
    expected_environment: dict[str, str],
    require_candidate_hardening: bool = False,
    expected_compose: dict[str, Any] | None = None,
    expected_runtime: dict[str, Any] | None = None,
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
    if any(actual_environment.get(key) != value for key, value in expected_environment.items()):
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
        if expected_runtime is None:
            raise DeployError("FLOWISE_RUNTIME_BASELINE_MISSING")
        actual_runtime = container_snapshot({FLOWISE_CONTAINER: flowise})[FLOWISE_CONTAINER]["runtime"]
        if actual_runtime != expected_runtime:
            raise DeployError("FLOWISE_RUNTIME_BASELINE_DRIFT")
    return {
        "runtime_image_verified": True,
        "runtime_config_hash": expected_config_hash,
        "runtime_environment_verified": True,
        "runtime_environment_key_count": len(expected_environment),
        "runtime_hardening_verified": require_candidate_hardening,
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


def database_state() -> dict[str, Any]:
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
    return {"transaction_read_only": True, "migration_count": len(migrations), "migration_sha256": sha256_bytes(payload)}


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
    path = _receipt_path(run_dir, name)
    data = read_regular(path, maximum=2 * 1024 * 1024, expected_uid=0, expected_gid=0, expected_mode=0o600)
    if expected_digest is not None and sha256_bytes(data) != expected_digest:
        raise DeployError(f"{name.upper()}_RECEIPT_DIGEST_MISMATCH")
    document = parse_canonical_json(data, f"{name.upper()}_RECEIPT")
    if document.get("run_id") != run_id:
        raise DeployError(f"{name.upper()}_RECEIPT_RUN_MISMATCH")
    return run_dir, document


def _verify_staged_file(path: Path, digest: str) -> bytes:
    data = read_regular(path, expected_uid=0, expected_gid=0, expected_mode=0o600)
    if sha256_bytes(data) != digest:
        raise DeployError(f"STAGED_FILE_DIGEST_MISMATCH_{path.name}")
    return data


def _load_staged(receipt: dict[str, Any], role: str, run_dir: Path) -> tuple[Path, bytes, bytes, bytes | None]:
    metadata = receipt[role]
    root = run_dir / role
    env = _verify_staged_file(root / ".env.production", metadata["files"]["env"])
    compose = _verify_staged_file(root / "docker-compose.prod.yml", metadata["files"]["compose"])
    seccomp_metadata = metadata["files"].get("seccomp")
    exact_keys(seccomp_metadata, ("present", "digest"), f"{role.upper()}_SECCOMP_STATE")
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
    archive_path = run_dir / "rollback/image.tar.gz"
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


def _recover_interrupted_runs() -> None:
    if not RUNS_DIR.exists():
        return
    for run_dir in sorted(RUNS_DIR.iterdir()):
        journal_path = run_dir / "journal.json"
        if not journal_path.is_file() or journal_path.is_symlink():
            continue
        journal = parse_canonical_json(
            read_regular(journal_path, maximum=2 * 1024 * 1024, expected_uid=0, expected_gid=0, expected_mode=0o600),
            "JOURNAL",
        )
        state = journal.get("state")
        operation = journal.get("operation")
        if state in (
            "rollback_failed_manual_intervention_required",
            ROLLBACK_ATTEMPTED_STATE,
            "rolling_back",
        ) or (state == "in_progress" and operation == "rollback"):
            raise DeployError("UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE")
        if state != "in_progress":
            continue
        run_id = journal.get("run_id")
        if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
            raise DeployError("INTERRUPTED_RUN_ID_INVALID")
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
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--bundle-dir", required=True, type=Path)
    prepare_parser.add_argument("--run-id", required=True)
    cutover_parser = commands.add_parser("cutover")
    cutover_parser.add_argument("--run-id", required=True)
    cutover_parser.add_argument("--prepare-receipt-sha256", required=True, type=_digest_argument)
    rollback_parser = commands.add_parser("rollback")
    rollback_parser.add_argument("--run-id", required=True)
    rollback_parser.add_argument("--prepare-receipt-sha256", required=True, type=_digest_argument)
    rollback_parser.add_argument("--cutover-receipt-sha256", required=True, type=_digest_argument)
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
    elif arguments.command == "prepare":
        result = prepare(arguments.bundle_dir, arguments.run_id)
    elif arguments.command == "cutover":
        result = cutover(arguments.run_id, arguments.prepare_receipt_sha256)
    else:
        result = rollback(arguments.run_id, arguments.prepare_receipt_sha256, arguments.cutover_receipt_sha256)
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
