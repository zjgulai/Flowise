import copy
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("flowise-production-release.py")
SPEC = importlib.util.spec_from_file_location("flowise_production_release", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("production release wrapper module could not be loaded")
RELEASE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = RELEASE
SPEC.loader.exec_module(RELEASE)


REVISION = "a" * 40
ROLLBACK_REVISION = "b" * 40
CANDIDATE_TAG = f"flowise-chinese:git-{REVISION}"
ROLLBACK_TAG = f"flowise-chinese:git-{ROLLBACK_REVISION}"
CANDIDATE_DIGEST = "sha256:" + "1" * 64
ROLLBACK_DIGEST = "sha256:" + "2" * 64
RUN_ID = "20260727T120000Z-deadbeef"


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value):
    return "sha256:" + hashlib.sha256(value).hexdigest()


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
            "database": {"transaction_read_only": True, "migration_count": 59, "migration_sha256": digest(b"m")},
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


def documents(image=CANDIDATE_TAG, image_id=CANDIDATE_DIGEST, flowise_id="new"):
    result = {}
    for name, identifier in (
        (RELEASE.FLOWISE_CONTAINER, flowise_id),
        (RELEASE.POSTGRES_CONTAINER, "pg"),
        (RELEASE.NGINX_CONTAINER, "nginx"),
    ):
        environment = ["FLOWISE_SECRETKEY_OVERWRITE=" + "k" * 32]
        network_settings = {}
        if name == RELEASE.POSTGRES_CONTAINER:
            environment = [
                "PGDATA=/var/lib/postgresql/data/pgdata",
                "POSTGRES_DB=flowise",
                "POSTGRES_USER=flowise",
                "POSTGRES_PASSWORD=test-password",
            ]
            network_settings = {
                "Networks": {
                    "flowise_flowise_network": {
                        "NetworkID": "flowise-network-id",
                        "Aliases": ["flowise-postgres", "postgres"],
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
    environment = {
        "FLOWISE_SECRETKEY_OVERWRITE": "k" * 32,
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


def hardened_documents():
    result = documents()
    flowise = result[RELEASE.FLOWISE_CONTAINER]
    candidate, _ = resolved_compose()
    flowise["Config"]["Env"] = [
        f"{key}={value}" for key, value in sorted(candidate["services"]["flowise"]["environment"].items())
    ]
    flowise["Config"]["User"] = "1000:1000"
    flowise["Config"]["Healthcheck"] = {**RELEASE.EXPECTED_RUNTIME_HEALTHCHECK, "StartInterval": 0}
    flowise["HostConfig"] = {
        "ReadonlyRootfs": True,
        "Init": True,
        "Privileged": False,
        "CapAdd": None,
        "CapDrop": ["ALL"],
        "PidsLimit": 512,
        "Memory": 4_294_967_296,
        "MemoryReservation": 2_147_483_648,
        "NanoCpus": 2_000_000_000,
        "PidMode": "",
        "IpcMode": "private",
        "UsernsMode": "",
        "UTSMode": "",
        "CgroupnsMode": "private",
        "NetworkMode": "flowise_flowise_network",
        "SecurityOpt": ["no-new-privileges", f"seccomp={RELEASE.LIVE_SECCOMP}"],
        "Devices": [],
        "DeviceRequests": [],
        "Binds": [],
        "PortBindings": {"3000/tcp": [{"HostIp": "172.20.0.1", "HostPort": "3000"}]},
        "PublishAllPorts": False,
        "RestartPolicy": {"Name": "always", "MaximumRetryCount": 0},
        "LogConfig": copy.deepcopy(RELEASE.EXPECTED_RUNTIME_LOG_CONFIG),
        "Tmpfs": dict(RELEASE.EXPECTED_TMPFS_BY_PATH),
    }
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
                "NetworkID": "flowise-network-id",
                "Gateway": "172.28.0.1",
                "IPPrefixLen": 16,
            },
            "lighthouse_ai_video_net": {
                "NetworkID": "proxy-network-id",
                "Gateway": "172.20.0.1",
                "IPPrefixLen": 16,
            },
        }
    }
    return result


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
        self.root = mock.patch.object(RELEASE, "require_root")

        def tracked_close(descriptor):
            if descriptor == self.fd and self.events is not None:
                self.events.append("lock-released")
            return self.original_close(descriptor)

        self.close = mock.patch.object(RELEASE.os, "close", side_effect=tracked_close)
        self.acquire.start()
        self.root.start()
        self.close.start()
        return self

    def __exit__(self, *args):
        self.close.stop()
        self.root.stop()
        self.acquire.stop()


class ProductionReleaseTests(unittest.TestCase):
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

    def test_candidate_migration_inventory_is_networkless_readonly_and_has_no_database_environment(self):
        captured = []

        def run(args, **_kwargs):
            captured.append(args)
            return json.dumps([{"timestamp": 1693891895163, "name": "Init1693891895163"}]).encode()

        cleanup_results = [types.SimpleNamespace(returncode=1), types.SimpleNamespace(returncode=0, stdout=b"")]
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
            mock.patch.object(RELEASE, "_ensure_rollback_image"),
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
                with mock.patch.object(RELEASE, "verify_regular_identity"), mock.patch.object(
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
                    mock.patch.object(RELEASE, "_ensure_rollback_image", side_effect=lambda *_args: events.append("archive-ready")),
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
                    mock.patch.object(RELEASE, "container_snapshot", return_value={}),
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
                        mock.patch.object(RELEASE, "_ensure_rollback_image"),
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
                sidecars.assert_not_called()

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
                return run_dir, prepared if name == "prepare" else {"run_id": RUN_ID, "state": "complete_candidate_active"}

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
                return run_dir, prepared if name == "prepare" else {"run_id": RUN_ID, "state": "complete_candidate_active"}

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
                RELEASE, "read_regular", side_effect=lambda path, **_kwargs: Path(path).read_bytes()
            ), mock.patch.object(RELEASE, "_restore_rollback", restore), self.assertRaisesRegex(
                RELEASE.DeployError, "UNRESOLVED_ROLLBACK_FAILURE_BLOCKS_RELEASE"
            ):
                RELEASE._recover_interrupted_runs()
            self.assertEqual(restore.call_count, 1)

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
