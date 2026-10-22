"""Execute untrusted, AI-generated Python in a sandbox and handle every outcome:
success, an exception, and a runaway process. Run with: python run_python_code.py"""

from northflank_sandbox import ExecResult, SandboxClient

# Pretend these came from an LLM. Treat them as untrusted input.
SNIPPETS = {
    "compute something": (
        "import statistics, json\n"
        "data = [12, 7, 3, 21, 9, 14]\n"
        "print(json.dumps({'mean': statistics.mean(data), 'stdev': round(statistics.stdev(data), 3)}))"
    ),
    "raises an exception": "print('about to fail')\nraise ValueError('the model wrote a bug')",
    "infinite loop (killed by timeout)": "while True:\n    pass",
    "tries to read host secrets": (
        "import os\n"
        "print('NF_API_TOKEN' in os.environ, 'ANTHROPIC_API_KEY' in os.environ)\n"
        "print(open('/etc/hostname').read().strip())"
    ),
}


def report(name: str, r: ExecResult) -> None:
    status = "TIMED OUT" if r.timed_out else "OK" if r.exit_code == 0 else f"FAILED (exit {r.exit_code})"
    print(f"\n## {name}: {status}")
    if r.stdout.strip():
        print(f"stdout:\n{r.stdout.rstrip()}")
    if r.stderr.strip():
        print(f"stderr:\n{r.stderr.rstrip()}")


client = SandboxClient()
with client.create(image="python:3.12-slim") as sandbox:
    print(f"Created {sandbox.id}, waiting for it to boot...")
    sandbox.wait_until_ready()
    for name, code in SNIPPETS.items():
        report(name, sandbox.run_python(code, timeout_seconds=5))
print(f"\nDestroyed {sandbox.id}")
