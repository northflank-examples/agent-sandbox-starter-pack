# Python examples: AI agent sandboxes on Northflank

[`northflank_sandbox.py`](northflank_sandbox.py) is a single-file wrapper around the official [Northflank Python SDK](https://northflank.com/docs/v1/api/use-the-python-client) (`pip install northflank`) that you can copy into your project: `create`, `wait_until_ready`, `exec`, `write_file`, `run_code`, `run_python`, `pause`, `resume`, `destroy`, and a context manager that destroys the sandbox on exit.

It uses the SDK's `create.service.deployment`, `helpers.wait_for_service_ready`, `exec.run_service_command`, `pause.service` / `resume.service` and `delete.service`, and adds a per-command timeout enforced inside the sandbox.

## Setup

Python 3.10+:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt   # northflank==2.1.0

export NF_API_TOKEN=...      # API tokens in your team, created from an RBAC role (NORTHFLANK_API_TOKEN also works)
export NF_PROJECT_ID=...     # project ID
```

## Scripts

| Command | What it shows |
| --- | --- |
| `python first_sandbox.py` | Create, wait, exec, destroy |
| `python run_python_code.py` | Untrusted Python: success, exception, infinite loop (timeout), secrets check |
| `python lifecycle.py` | Pause and resume; what survives |
| `python agent.py "task"` | Claude with a `run_code` tool that executes in the sandbox (needs `ANTHROPIC_API_KEY`) |
| `python parallel.py` | One sandbox per task, run concurrently |
| `python persistent_volume.py` | Volume at `/workspace` survives pause/resume; safe cleanup (`--keep-volume` to keep it) |
| `python monitor_sandbox.py` | CPU and memory metrics, platform logs, a watchdog enforcing lifetime and memory limits |
| `python secure_networking.py` | Public port behind basic auth, verified from outside; egress probe; `--egress-policy` applies a network policy |

## Using the wrapper

```python
from northflank_sandbox import SandboxClient

with SandboxClient().create(image="python:3.12-slim", plan="nf-compute-50") as sandbox:
    sandbox.wait_until_ready()
    sandbox.write_file("/tmp/agent/data.csv", "a,b\n1,2\n")
    r = sandbox.run_python("import csv; print(list(csv.reader(open('data.csv'))))", timeout_seconds=10)
    print(r.exit_code, r.stdout, r.stderr, r.timed_out)
```

The underlying SDK client is available as `SandboxClient().api` for anything the wrapper doesn't cover, such as `api.files.upload` / `api.files.download` for larger files (the image needs `tar`), `api.logs.tail_service_logs`, or `api.get.service.metrics`.

Tutorials: [first sandbox](../../tutorials/create-your-first-sandbox/README.md) · [execute code](../../tutorials/execute-code-in-a-sandbox/README.md) · [persist files](../../tutorials/persist-files-between-sessions/README.md) · [monitor usage](../../tutorials/monitor-sandbox-usage/README.md) · [secure networking](../../tutorials/secure-sandbox-networking/README.md).
