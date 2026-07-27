#!/usr/bin/env python3
"""Isolated Docker boundary test for Flowise legacy bootstrap/rollback.

The production-only root, permit, receipt, database, and public-ping gates stay
in unit tests. This harness exercises the production wrapper's real Compose
render/hash/recreate/inspect and config install/remove helpers with fake local
services on an internal network.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any
from unittest import mock


KEY = b"integration-fixture-key-32-bytes"


def digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    return digest(path.read_bytes())


def require(condition: bool, label: str) -> None:
    if not condition:
        raise RuntimeError(label)


def load_wrapper(repo: Path) -> Any:
    path = repo / "scripts/flowise-production-release.py"
    spec = importlib.util.spec_from_file_location("flowise_release_integration", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load release wrapper")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def isolated_compose_environment(work: Path, base_env: dict[str, str]) -> dict[str, str]:
    docker_config = work / "docker-config"
    plugin_dir = docker_config / "cli-plugins"
    plugin_dir.mkdir(mode=0o700, parents=True)
    plugin = shutil.which("docker-compose")
    if plugin is not None:
        (plugin_dir / "docker-compose").symlink_to(Path(plugin).resolve())
    safe_env = dict(base_env)
    safe_env["DOCKER_CONFIG"] = str(docker_config)
    compose_probe = subprocess.run(
        ["docker", "compose", "version"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=safe_env,
        check=False,
    )
    if compose_probe.returncode != 0:
        raise RuntimeError("local Docker Compose plugin missing")
    return safe_env


def atomic_write(path: Path, data: bytes, mode: int, _uid: int = 0, _gid: int = 0) -> None:
    """Unprivileged equivalent used only inside the mktemp fixture tree."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".fixture-", dir=str(path.parent))
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        view = memoryview(data)
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise RuntimeError("fixture atomic write was short")
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(str(temporary), str(path))
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--work", required=True, type=Path)
    parser.add_argument("--prefix", required=True)
    parser.add_argument("--source-image", required=True)
    parser.add_argument("--legacy-image", required=True)
    parser.add_argument("--candidate-image", required=True)
    return parser.parse_args()


class BoundaryHarness:
    def __init__(self, options: argparse.Namespace) -> None:
        self.options = options
        self.repo = options.repo.resolve()
        self.work = options.work.resolve()
        self.live = self.work / "live"
        self.bundle = self.work / "bundle"
        self.env = self.live / ".env.production"
        self.compose = self.live / "docker-compose.prod.yml"
        self.seccomp = self.live / "docker/seccomp/chromium.json"
        self.archive = self.bundle / "image.tar.gz"
        self.flowise = options.prefix + "-flowise"
        self.postgres = options.prefix + "-postgres"
        self.nginx = options.prefix + "-nginx"
        self.flowise_volume = options.prefix + "-flowise-data"
        self.postgres_volume = options.prefix + "-postgres-data"
        self.network = options.prefix + "-network"
        self.project = options.prefix + "-project"
        self.wrapper = load_wrapper(self.repo)
        self.stack = contextlib.ExitStack()
        self.commands: list[list[str]] = []
        self.restore_count = 0
        self._write_fixtures()
        self._patch_wrapper()

    def _sidecars(self) -> str:
        return textwrap.dedent(
            f"""
              postgres:
                image: ${{FIXTURE_IMAGE:?required}}
                pull_policy: never
                container_name: {self.postgres}
                command: ["/bin/sh", "-c", "touch /tmp/ready && exec tail -f /dev/null"]
                labels:
                  flowise.bootstrap.fixture: "{self.options.prefix}"
                  flowise.bootstrap.role: postgres
                healthcheck: &health
                  test: ["CMD-SHELL", "test -f /tmp/ready"]
                  interval: 1s
                  timeout: 1s
                  retries: 30
                  start_period: 1s
                networks: [fixture]
                volumes: [postgres_data:/pgstate]
              nginx:
                image: ${{FIXTURE_IMAGE:?required}}
                pull_policy: never
                container_name: {self.nginx}
                command: ["/bin/sh", "-c", "touch /tmp/ready && exec tail -f /dev/null"]
                labels:
                  flowise.bootstrap.fixture: "{self.options.prefix}"
                  flowise.bootstrap.role: nginx
                healthcheck: *health
                networks: [fixture]
            volumes:
              flowise_data:
                name: {self.flowise_volume}
              postgres_data:
                name: {self.postgres_volume}
            networks:
              fixture:
                name: {self.network}
                driver: bridge
                internal: true
            """
        )

    def _compose_bytes(self, hardened: bool) -> bytes:
        hardening = (
            '    user: "1000:1000"\n'
            "    read_only: true\n"
            "    init: true\n"
            "    cap_drop: [ALL]\n"
            "    pids_limit: 512\n"
            "    security_opt:\n"
            "      - no-new-privileges:true\n"
            "      - seccomp=./docker/seccomp/chromium.json\n"
            "    tmpfs:\n"
            "      - /tmp:rw,nosuid,nodev,size=16m,uid=1000,gid=1000,mode=1777\n"
            "    restart: always\n"
            "    deploy:\n"
            "      resources:\n"
            '        limits: {cpus: "0.50", memory: 128M, pids: 512}\n'
            '        reservations: {cpus: "0.10", memory: 32M}\n'
            if hardened else ""
        )
        document = (
            "services:\n"
            "  flowise:\n"
            "    image: ${FLOWISE_IMAGE:?required}\n"
            "    pull_policy: never\n"
            f"    container_name: {self.flowise}\n"
            '    command: ["/bin/sh", "-c", "touch /tmp/ready && exec tail -f /dev/null"]\n'
            "    environment:\n"
            "      FLOWISE_SECRETKEY_OVERWRITE: ${FLOWISE_SECRETKEY_OVERWRITE:?required}\n"
            "    labels:\n"
            f'      flowise.bootstrap.fixture: "{self.options.prefix}"\n'
            "      flowise.bootstrap.role: flowise\n"
            + hardening
            + "    healthcheck:\n"
            '      test: ["CMD-SHELL", "test -f /tmp/ready"]\n'
            "      interval: 1s\n"
            "      timeout: 1s\n"
            "      retries: 30\n"
            "      start_period: 1s\n"
            "    networks: [fixture]\n"
            "    volumes: [flowise_data:/state]\n"
            + self._sidecars()
        )
        return document.encode()

    def _write_fixtures(self) -> None:
        self.live.mkdir(mode=0o700, parents=True)
        (self.bundle / "docker/seccomp").mkdir(mode=0o700, parents=True, exist_ok=True)
        env = (
            f"FLOWISE_IMAGE={self.options.legacy_image}\n"
            f"FIXTURE_IMAGE={self.options.source_image}\n"
            f"FLOWISE_SECRETKEY_OVERWRITE={KEY.decode()}\n"
        ).encode()
        self.env.write_bytes(env)
        self.compose.write_bytes(self._compose_bytes(False))
        (self.bundle / "docker-compose.prod.yml").write_bytes(self._compose_bytes(True))
        (self.bundle / "docker/seccomp/chromium.json").write_bytes(
            (self.repo / "docker/seccomp/chromium.json").read_bytes()
        )
        os.chmod(self.env, 0o600)
        os.chmod(self.compose, 0o644)
        if not self.archive.is_file():
            raise RuntimeError("candidate archive missing")
        self.legacy_state = self._file_state()
        self.archive_state = (self.archive.stat().st_size, file_digest(self.archive))

    def _patch_wrapper(self) -> None:
        w = self.wrapper
        original_args = w.compose_args
        original_recreate = w.compose_recreate
        original_run = w.run_command
        safe_env = isolated_compose_environment(self.work, w.SAFE_ENV)

        def isolated_args(env: Path, compose: Path, project_dir: Path) -> list[str]:
            command = original_args(env, compose, project_dir)
            command[command.index("--project-name") + 1] = self.project
            return command

        def observed(command: list[str], **kwargs: Any) -> bytes:
            if command[:2] == ["docker", "load"]:
                raise AssertionError("candidate archive must not be loaded")
            if "compose" in command and "up" in command:
                self.commands.append(list(command))
            return original_run(command, **kwargs)

        def recreate(env: Path | None = None, compose: Path | None = None) -> None:
            original_recreate(env or self.env, compose or self.compose)

        for name, value in {
            "BASE_DIR": self.live,
            "LIVE_ENV": self.env,
            "LIVE_COMPOSE": self.compose,
            "LIVE_SECCOMP": self.seccomp,
            "FLOWISE_CONTAINER": self.flowise,
            "POSTGRES_CONTAINER": self.postgres,
            "NGINX_CONTAINER": self.nginx,
            "MANAGED_CONTAINERS": (self.flowise, self.postgres, self.nginx),
            "SAFE_ENV": safe_env,
            "compose_args": isolated_args,
            "compose_recreate": recreate,
            "run_command": observed,
            "atomic_write": atomic_write,
            "_ensure_live_seccomp_parent": lambda _uid, _gid: self.seccomp.parent.mkdir(
                mode=0o700, parents=True, exist_ok=True
            ),
        }.items():
            self.stack.enter_context(mock.patch.object(w, name, value))

    def _file_state(self) -> tuple[bytes, int, bytes, int, bool]:
        return (
            self.env.read_bytes(), stat.S_IMODE(self.env.stat().st_mode),
            self.compose.read_bytes(), stat.S_IMODE(self.compose.stat().st_mode),
            self.seccomp.exists() or self.seccomp.is_symlink(),
        )

    def _candidate_absent(self) -> bool:
        result = subprocess.run(
            ["docker", "image", "inspect", self.options.candidate_image],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
        )
        return result.returncode != 0

    def _ids(self, documents: dict[str, dict[str, Any]]) -> tuple[str, str, str]:
        return (
            str(documents[self.flowise]["Id"]),
            str(documents[self.postgres]["Id"]),
            str(documents[self.nginx]["Id"]),
        )

    def _assert_hardened(self, documents: dict[str, dict[str, Any]], image_id: str) -> None:
        flowise = documents[self.flowise]
        config, host = flowise["Config"], flowise["HostConfig"]
        security = [str(value) for value in host.get("SecurityOpt") or []]
        require(config["Image"] == self.options.legacy_image and flowise["Image"] == image_id, "active image drift")
        require(config["User"] == "1000:1000" and host["ReadonlyRootfs"] is True, "user/rootfs hardening missing")
        require(host["Init"] is True and host["CapDrop"] == ["ALL"] and host["PidsLimit"] == 512, "init/cap/pids hardening missing")
        require(host["Memory"] == 134_217_728 and host["NanoCpus"] == 500_000_000, "resource limits missing")
        require(any(value.startswith("no-new-privileges") for value in security), "no-new-privileges missing")
        require(len([value for value in security if value.startswith("seccomp=")]) == 1, "seccomp profile missing")
        require("/tmp" in (host.get("Tmpfs") or {}), "tmpfs missing")

    def _assert_legacy(self, documents: dict[str, dict[str, Any]], image_id: str) -> None:
        flowise = documents[self.flowise]
        config, host = flowise["Config"], flowise["HostConfig"]
        require(config["Image"] == self.options.legacy_image and flowise["Image"] == image_id, "legacy image drift")
        require(config.get("User") in (None, "") and host["ReadonlyRootfs"] is False, "legacy rootfs not restored")
        require(not (host.get("CapDrop") or []) and not (host.get("SecurityOpt") or []), "legacy security options not restored")

    def _install(self, env: bytes, compose: bytes, seccomp: bytes | None) -> None:
        env_info, compose_info = self.env.stat(), self.compose.stat()
        metadata = {
            "env": [env_info.st_uid, env_info.st_gid, 0o600],
            "compose": [compose_info.st_uid, compose_info.st_gid, 0o644],
            "seccomp": [compose_info.st_uid, compose_info.st_gid, 0o644],
        }
        self.wrapper.install_config_set(env, compose, seccomp, metadata)

    def _restore(self, before: dict[str, dict[str, Any]], image_id: str) -> dict[str, dict[str, Any]]:
        self.restore_count += 1
        self._install(self.legacy_state[0], self.legacy_state[2], None)
        self.wrapper.compose_recreate()
        after = self.wrapper.inspect_containers()
        self.wrapper._validate_sidecars(before, after)
        self._assert_legacy(after, image_id)
        return after

    def run(self) -> None:
        w = self.wrapper
        w.run_command(w.compose_args(self.env, self.compose, self.live) + [
            "up", "-d", "--pull", "never", "--wait", "--wait-timeout", "60"
        ], timeout=120)
        initial = w.inspect_containers()
        w.validate_container_health(initial)
        initial_ids = self._ids(initial)
        image_id = initial[self.flowise]["Image"]
        legacy_hash = w.compose_service_hash(self.env, self.compose, self.live)
        require(w.container_snapshot(initial)[self.flowise]["compose_config_hash"] == legacy_hash, "legacy Compose hash mismatch")

        hard_compose = (self.bundle / "docker-compose.prod.yml").read_bytes()
        hard_seccomp = (self.bundle / "docker/seccomp/chromium.json").read_bytes()
        active_env = w.render_env(self.legacy_state[0], self.options.legacy_image)
        target_env = w.render_env(self.legacy_state[0], self.options.candidate_image)
        active_env_path, target_env_path = self.work / "active.env", self.work / "target.env"
        active_env_path.write_bytes(active_env)
        target_env_path.write_bytes(target_env)
        hard_path = self.bundle / "docker-compose.prod.yml"
        active_config = w.compose_config(active_env_path, hard_path, self.live)
        target_config = w.compose_config(target_env_path, hard_path, self.live)
        require(w._compose_without_flowise_image(active_config) == w._compose_without_flowise_image(target_config), "target non-image drift")
        require(self._candidate_absent(), "candidate image loaded before bootstrap")

        self._install(active_env, hard_compose, hard_seccomp)
        require(w._live_hashes() == {
            "env": w.sha256_bytes(active_env),
            "compose": w.sha256_bytes(hard_compose),
            "seccomp": {"present": True, "digest": w.sha256_bytes(hard_seccomp)},
        }, "hardened live-file hashes mismatch")
        hard_hash = w.compose_service_hash(self.env, self.compose, self.live)
        w.compose_recreate()
        hardened = w.inspect_containers()
        self._assert_hardened(hardened, image_id)
        require(w.container_snapshot(hardened)[self.flowise]["compose_config_hash"] == hard_hash, "hardened Compose hash mismatch")
        w._validate_sidecars(initial, hardened)
        hard_ids = self._ids(hardened)
        require(initial_ids[0] != hard_ids[0] and initial_ids[1:] == hard_ids[1:], "non-Flowise recreate detected")
        print("ok 1 - bootstrap keeps the active image while recreating only Flowise")

        require(self._candidate_absent() and not any(
            document["Config"]["Image"] == self.options.candidate_image for document in hardened.values()
        ), "candidate image was loaded or started")
        require(self.archive_state == (self.archive.stat().st_size, file_digest(self.archive)), "candidate archive changed")
        print("ok 2 - candidate archive is neither loaded nor started")
        print("ok 3 - hardened user, rootfs, caps, pids, resources, tmpfs, and security opts materialize")

        manual_before = self.restore_count
        manual = self._restore(hardened, image_id)
        require(self.restore_count == manual_before + 1 and self._file_state() == self.legacy_state, "manual legacy restore mismatch")
        print("ok 4 - explicit boundary rollback restores legacy compose, env, and seccomp absence")

        failure_ids = self._ids(manual)
        automatic_before = self.restore_count
        try:
            self._install(active_env, hard_compose, hard_seccomp)
            w.compose_recreate()
            written = w.inspect_containers()
            self._assert_hardened(written, image_id)
            raise RuntimeError("injected-after-first-write")
        except RuntimeError as error:
            if str(error) != "injected-after-first-write":
                raise
            recovered = self._restore(manual, image_id)
        require(self.restore_count == automatic_before + 1, "automatic restore count mismatch")
        require(self._file_state() == self.legacy_state and self._ids(recovered)[1:] == failure_ids[1:], "automatic legacy restore mismatch")
        print("ok 5 - post-write failure restores the exact legacy files exactly once")
        print("ok 6 - PostgreSQL and nginx identities remain unchanged across every recreate")

        recreates = [command for command in self.commands if "--force-recreate" in command]
        require(len(recreates) == 4, "unexpected recreate count")
        require(all("--no-deps" in command and "--no-build" in command and command[-1] == "flowise" for command in recreates), "recreate command scope drift")
        print("ok 7 - every wrapper recreate is --no-deps --no-build and Flowise-only")

    def close(self) -> None:
        self.stack.close()


class ComposePluginDiscoveryTests(unittest.TestCase):
    def test_path_shim_is_linked_into_the_isolated_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            shutil, "which", return_value="/bin/true"
        ), mock.patch.object(
            subprocess,
            "run",
            return_value=subprocess.CompletedProcess(["docker", "compose", "version"], 0),
        ) as probe:
            work = Path(directory)
            safe_env = isolated_compose_environment(work, {"PATH": "/usr/bin"})
            self.assertEqual(safe_env["DOCKER_CONFIG"], str(work / "docker-config"))
            self.assertEqual(
                (work / "docker-config/cli-plugins/docker-compose").resolve(),
                Path("/bin/true").resolve(),
            )
            self.assertEqual(probe.call_args.kwargs["env"], safe_env)

    def test_system_plugin_needs_no_path_shim(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            shutil, "which", return_value=None
        ), mock.patch.object(
            subprocess,
            "run",
            return_value=subprocess.CompletedProcess(["docker", "compose", "version"], 0),
        ):
            work = Path(directory)
            safe_env = isolated_compose_environment(work, {"PATH": "/usr/bin"})
            self.assertEqual(safe_env["DOCKER_CONFIG"], str(work / "docker-config"))
            self.assertFalse((work / "docker-config/cli-plugins/docker-compose").exists())

    def test_missing_shim_and_system_plugin_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory, mock.patch.object(
            shutil, "which", return_value=None
        ), mock.patch.object(
            subprocess,
            "run",
            return_value=subprocess.CompletedProcess(["docker", "compose", "version"], 1),
        ), self.assertRaisesRegex(RuntimeError, "local Docker Compose plugin missing"):
            isolated_compose_environment(Path(directory), {"PATH": "/usr/bin"})


def main() -> int:
    options = args()
    if not options.prefix.startswith("flowise-bootstrap-it-"):
        raise RuntimeError("unsafe fixture prefix")
    harness = BoundaryHarness(options)
    try:
        harness.run()
        return 0
    finally:
        harness.close()


if __name__ == "__main__":
    raise SystemExit(main())
