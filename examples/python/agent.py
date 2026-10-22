"""Connect an AI agent to a sandbox. Claude gets one tool, `run_code`, and every
call executes inside a dedicated Northflank sandbox, never on this machine.

The agent loop runs here; only the code runs in the sandbox. The Anthropic API
key stays on this side of the boundary.

Run with: python agent.py "your task"
"""

import sys
from typing import Literal

import anthropic
from anthropic import beta_tool

from northflank_sandbox import SandboxClient

TASK = " ".join(sys.argv[1:]) or (
    "Generate 10,000 random points in the unit square and use them to estimate pi. "
    "Then tell me how far off the estimate was."
)

# Cap what goes back to the model so a chatty program can't flood the context.
MAX_OUTPUT_CHARS = 10_000


def truncate(s: str) -> str:
    if len(s) > MAX_OUTPUT_CHARS:
        return f"{s[:MAX_OUTPUT_CHARS]}\n...[truncated {len(s) - MAX_OUTPUT_CHARS} chars]"
    return s


sandboxes = SandboxClient()
sandbox = sandboxes.create(image="nikolaik/python-nodejs:python3.12-nodejs22-slim")
print(f"Sandbox {sandbox.id} starting...")


@beta_tool
def run_code(language: Literal["python", "javascript"], code: str) -> str:
    """Execute a Python or JavaScript program in an isolated Linux sandbox.

    Returns its stdout, stderr and exit code. The sandbox persists for this
    conversation, so files written under /tmp/agent are available to later calls.
    Print anything you need to see. Each run is killed after 30 seconds.

    Args:
        language: The language of the program.
        code: The complete program to run.
    """
    print(f"\n--- run_code ({language}) ---\n{code}\n")
    r = sandbox.run_code(language, code, timeout_seconds=30)
    status = "timed out after 30s" if r.timed_out else f"exit code {r.exit_code}"
    print(f"--- {status} ---\n{r.stdout}{r.stderr}")
    return f"status: {status}\nstdout:\n{truncate(r.stdout)}\nstderr:\n{truncate(r.stderr)}"


client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY

try:
    sandbox.wait_until_ready()
    runner = client.beta.messages.tool_runner(
        model="claude-opus-5-5",
        max_tokens=16000,
        # Server-side refusal fallback: if the model declines, the API retries on a
        # fallback model inside the same call. Remove these two lines to opt out.
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
        max_iterations=10,
        system=(
            "You are a data assistant. Use the run_code tool to compute answers instead of "
            "estimating them. Keep programs short and print the results you need."
        ),
        tools=[run_code],
        messages=[{"role": "user", "content": TASK}],
    )
    final = runner.until_done()
    if final.stop_reason == "refusal":
        print("\nThe model declined this request.")
    elif final.stop_reason == "tool_use":
        print("\nStopped after 10 iterations without a final answer.")
    else:
        answer = "\n".join(block.text for block in final.content if block.type == "text")
        print(f"\n=== Answer ===\n{answer}")
finally:
    sandbox.destroy()
    print(f"\nDestroyed {sandbox.id}")
