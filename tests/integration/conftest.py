from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path("/home/wah/Workspaces/MPF-Tracker")
ENV_FILE = REPO_ROOT / ".env.example"
COMPOSE_PROJECT = "mpf-itest"
AUTOMATION_NETWORK = "automation"


@dataclass
class ComposeHarness:
    repo_root: Path
    env: dict[str, str]

    def compose(self, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
        cmd = [
            "docker",
            "compose",
            "--env-file",
            str(ENV_FILE),
            *args,
        ]
        return subprocess.run(
            cmd,
            cwd=self.repo_root,
            env=self.env,
            check=check,
            capture_output=True,
            text=True,
        )

    def api_request(
        self,
        *,
        service_host: str,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[int, Any]:
        script = r"""
import json, os, urllib.request, urllib.error

host = os.environ["TARGET_SERVICE_HOST"]
method = os.environ["TARGET_METHOD"]
path = os.environ["TARGET_PATH"]
api_key = os.environ["TARGET_API_KEY"]
payload_text = os.environ.get("TARGET_PAYLOAD")
headers = {"X-API-Key": api_key}
extra_headers = os.environ.get("TARGET_EXTRA_HEADERS")
if extra_headers:
    headers.update(json.loads(extra_headers))
data = None
if payload_text:
    headers["Content-Type"] = "application/json"
    data = payload_text.encode()
request = urllib.request.Request(
    f"http://{host}:8000{path}",
    data=data,
    headers=headers,
    method=method,
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read().decode()
        body = json.loads(raw) if raw else {}
        print(json.dumps({"status": response.status, "body": body}))
except urllib.error.HTTPError as error:
    raw = error.read().decode()
    body = json.loads(raw) if raw else {"raw": raw}
    print(json.dumps({"status": error.code, "body": body}))
"""
        exec_env_args = [
            "-e",
            f"TARGET_SERVICE_HOST={service_host}",
            "-e",
            f"TARGET_METHOD={method}",
            "-e",
            f"TARGET_PATH={path}",
            "-e",
            "TARGET_API_KEY=REPLACE_ME",
        ]
        if payload is not None:
            exec_env_args.extend(["-e", f"TARGET_PAYLOAD={json.dumps(payload)}"])
        if extra_headers:
            exec_env_args.extend(["-e", f"TARGET_EXTRA_HEADERS={json.dumps(extra_headers)}"])

        cmd = [
            "docker",
            "compose",
            "--env-file",
            str(ENV_FILE),
            "exec",
            "-T",
            *exec_env_args,
            "mpf-crawler",
            "python",
            "-c",
            script,
        ]
        env = self.env.copy()

        result = subprocess.run(
            cmd,
            cwd=self.repo_root,
            env=env,
            check=True,
            capture_output=True,
            text=True,
        )
        parsed = json.loads(result.stdout.strip())
        return parsed["status"], parsed["body"]

    def poll_job(
        self,
        *,
        service_host: str,
        job_path_prefix: str,
        job_id: str,
        timeout_seconds: int = 120,
    ) -> dict[str, Any]:
        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            _, body = self.api_request(
                service_host=service_host,
                method="GET",
                path=f"{job_path_prefix}/{job_id}",
            )
            if body["status"] in ("succeeded", "failed"):
                return body
            time.sleep(1)
        raise TimeoutError(f"Timed out polling job {job_id} on {service_host}")

    def sql_scalar(self, query: str) -> str:
        result = self.compose(
            [
                "exec",
                "-T",
                "mpf-db",
                "psql",
                "-U",
                "mpf_migrator",
                "-d",
                "mpf",
                "-Atc",
                query,
            ]
        )
        return result.stdout.strip()


def _ensure_docker_available() -> None:
    if shutil.which("docker") is None:
        pytest.skip("docker CLI is required for integration tests")
    try:
        subprocess.run(
            ["docker", "version"],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        pytest.skip(f"docker is not available: {exc}")


def _ensure_automation_network() -> None:
    inspect = subprocess.run(
        ["docker", "network", "inspect", AUTOMATION_NETWORK],
        capture_output=True,
        text=True,
    )
    if inspect.returncode == 0:
        return
    subprocess.run(
        ["docker", "network", "create", AUTOMATION_NETWORK],
        check=True,
        capture_output=True,
        text=True,
    )


def _reset_postgres_bind_mount() -> None:
    subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{REPO_ROOT / 'data' / 'postgres'}:/data",
            "busybox",
            "sh",
            "-c",
            "rm -rf /data/* /data/.[!.]* /data/..?* || true",
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _wait_for_health(harness: ComposeHarness) -> None:
    required_services = ("mpf-crawler", "mpf-portfolio", "mpf-purchase", "mpf-valuation")
    deadline = time.time() + 120
    while time.time() < deadline:
        ps = harness.compose(["ps", "-a"], check=False).stdout
        if all(_service_healthy(ps, service) for service in required_services) and _migrate_finished(ps):
            for service in required_services:
                status, body = harness.api_request(
                    service_host=service,
                    method="GET",
                    path="/health",
                )
                if status != 200 or body.get("status") != "ready":
                    break
            else:
                return
        time.sleep(2)
    raise TimeoutError("Services did not become healthy in time")


def _service_healthy(ps_output: str, service: str) -> bool:
    for line in ps_output.splitlines():
        if service in line:
            return "healthy" in line.lower()
    return False


def _migrate_finished(ps_output: str) -> bool:
    for line in ps_output.splitlines():
        if "mpf-migrate" in line:
            return "exited (0)" in line.lower()
    return False


@pytest.fixture(scope="session")
def integration_harness() -> ComposeHarness:
    _ensure_docker_available()
    _ensure_automation_network()

    env = os.environ.copy()
    env["COMPOSE_PROJECT_NAME"] = COMPOSE_PROJECT
    env["ENABLE_JOB_WORKER"] = "true"

    harness = ComposeHarness(repo_root=REPO_ROOT, env=env)
    harness.compose(["down"], check=False)
    _reset_postgres_bind_mount()
    try:
        harness.compose(["up", "-d", "--build"])
        _wait_for_health(harness)
    except Exception:
        harness.compose(["down"], check=False)
        raise

    yield harness

    harness.compose(["down"], check=False)
