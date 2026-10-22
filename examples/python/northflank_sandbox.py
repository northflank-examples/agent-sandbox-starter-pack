"""A small wrapper around the official Northflank Python SDK that exposes the
sandbox lifecycle most agent code needs:

    create -> wait_until_ready -> exec / write_file / run_code -> pause | resume -> destroy

On Northflank, a sandbox is a deployment service. On Northflank's managed
cloud, each one runs in its own microVM with a dedicated guest kernel.

Setup:
    pip install -r requirements.txt
    export NF_API_TOKEN=... NF_PROJECT_ID=...

SDK docs: https://northflank.com/docs/v1/api/use-the-python-client
"""

from __future__ import annotations

import base64
import os
import shlex
import uuid
from dataclasses import dataclass

from northflank import ApiClient

SANDBOX_PREFIX = "sbx-"
# Tag applied to every sandbox, so network policies can target sandboxes.
SANDBOX_TAG = "agent-sandbox"


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int

    @property
    def timed_out(self) -> bool:
        # GNU timeout exits 137 (128 + SIGKILL) when it kills the command.
        return self.exit_code == 137


class SandboxError(RuntimeError):
    pass


class SandboxClient:
    def __init__(self, api_token: str | None = None, project_id: str | None = None):
        project_id = project_id or os.environ.get("NF_PROJECT_ID")
        if not project_id:
            raise SandboxError("NF_PROJECT_ID is not set (see examples/python/README.md)")
        self.project_id = project_id
        # Reads NORTHFLANK_API_TOKEN or NF_API_TOKEN when api_token is None, and
        # raises ApiCallError on any non-2xx response.
        self.api = ApiClient(api_token=api_token) if api_token else ApiClient()

    def create(
        self,
        image: str = "python:3.12-slim",
        plan: str = "nf-compute-20",
        ephemeral_storage_mb: int = 2048,
        env: dict[str, str] | None = None,
        volumes: list[str] | None = None,
        tags: list[str] | None = None,
    ) -> "Sandbox":
        """Provision a sandbox. Returns immediately; call wait_until_ready().

        volumes: volume IDs to attach at creation (attaching later redeploys the sandbox).
        tags: extra tags; SANDBOX_TAG is always added.
        """
        sandbox_id = f"{SANDBOX_PREFIX}{uuid.uuid4().hex[:8]}"
        self.api.create.service.deployment(
            project_id=self.project_id,
            data={
                "name": sandbox_id,
                "description": "Agent sandbox created by agent-sandbox-starter-pack",
                "tags": [SANDBOX_TAG, *(tags or [])],
                "billing": {"deploymentPlan": plan},
                "deployment": {
                    "instances": 1,
                    "external": {"imagePath": image},
                    # Base images exit immediately; keep the sandbox alive for exec.
                    "docker": {"configType": "customCommand", "customCommand": "sleep infinity"},
                    "storage": {"ephemeralStorage": {"storageSize": ephemeral_storage_mb}},
                },
                "runtimeEnvironment": env or {},
                # Attach volumes at creation; attaching later redeploys the sandbox. (mypy can't
                # check a conditional ** spread inside a TypedDict literal.)
                **({"createOptions": {"volumesToAttach": volumes}} if volumes else {}),  # type: ignore[typeddict-item]
            },
        )
        return Sandbox(self, sandbox_id)

    def get(self, sandbox_id: str) -> "Sandbox":
        return Sandbox(self, sandbox_id)

    def list(self) -> list[str]:
        """IDs of sandboxes created by these examples (all pages)."""
        response = self.api.list.services.all(project_id=self.project_id)
        return [s["id"] for s in response.data["services"] if s["id"].startswith(SANDBOX_PREFIX)]


class Sandbox:
    def __init__(self, client: SandboxClient, sandbox_id: str):
        self.client = client
        self.id = sandbox_id

    def __enter__(self) -> "Sandbox":
        return self

    def __exit__(self, *exc) -> None:
        self.destroy()

    def wait_until_ready(self, timeout: float = 180) -> None:
        """Wait until the deployment reports COMPLETED (rolled out and running,
        not "exited"). Raises TimeoutError, or RuntimeError if it FAILED."""
        self.client.api.helpers.wait_for_service_ready(
            project_id=self.client.project_id, service_id=self.id, timeout_s=timeout, poll_interval_s=1
        )

    def exec(self, command: str, timeout_seconds: int = 60) -> ExecResult:
        """Run a shell command in the sandbox; capture stdout, stderr, exit code."""
        # `timeout` runs inside the sandbox, so a runaway process is killed
        # there rather than left consuming CPU after we stop waiting for it.
        wrapped = f"timeout -s KILL {timeout_seconds} sh -c {shlex.quote(command)}"
        result = self.client.api.exec.run_service_command(
            project_id=self.client.project_id, service_id=self.id,
            command=wrapped,
            shell="sh -c",
            timeout=timeout_seconds + 30,  # client-side wait, a little longer than the kill
        )
        return ExecResult(
            stdout=result.stdout,
            stderr=result.stderr,
            exit_code=result.exit_code if result.exit_code is not None else -1,
        )

    def write_file(self, path: str, content: str) -> None:
        """Write a text file. Content travels base64-encoded so quoting is safe.
        For large files or directories use client.api.files.upload instead."""
        encoded = base64.b64encode(content.encode()).decode()
        directory = os.path.dirname(path) or "/"
        result = self.exec(
            f"mkdir -p {shlex.quote(directory)} && printf %s {shlex.quote(encoded)} | base64 -d > {shlex.quote(path)}"
        )
        if result.exit_code != 0:
            raise SandboxError(f"write_file {path} failed: {result.stderr}")

    def run_code(self, language: str, code: str, timeout_seconds: int = 30) -> ExecResult:
        """Write `code` to a file and run it with the matching interpreter.
        language: "python", "javascript" or "bash"."""
        path, command = {
            "python": ("/tmp/agent/main.py", "python3 main.py"),
            "javascript": ("/tmp/agent/main.js", "node main.js"),
            "bash": ("/tmp/agent/main.sh", "bash main.sh"),
        }[language]
        self.write_file(path, code)
        return self.exec(f"cd /tmp/agent && {command}", timeout_seconds=timeout_seconds)

    def run_python(self, code: str, timeout_seconds: int = 30) -> ExecResult:
        """Write `code` to a file and run it with python3."""
        return self.run_code("python", code, timeout_seconds)

    def pause(self) -> None:
        """Stop compute billing and running processes. Ephemeral disk is lost;
        configuration and attached volumes are kept."""
        self.client.api.pause.service(project_id=self.client.project_id, service_id=self.id)
        # Pausing settles asynchronously; resuming before it has settled can race it.
        self.client.api.helpers.wait_for_service_paused(
            project_id=self.client.project_id, service_id=self.id, poll_interval_s=1
        )

    def resume(self) -> None:
        self.client.api.resume.service(project_id=self.client.project_id, service_id=self.id, data={})
        self.wait_until_ready()

    def destroy(self) -> None:
        """Permanently delete the sandbox."""
        self.client.api.delete.service(project_id=self.client.project_id, service_id=self.id)
