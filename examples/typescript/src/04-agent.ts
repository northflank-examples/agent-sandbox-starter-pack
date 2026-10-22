// Connect an AI agent to a sandbox. Claude gets one tool, `run_code`, and every
// call executes inside a dedicated Northflank sandbox, never on this machine.
//
// The agent loop runs here; only the code runs in the sandbox. The Anthropic
// API key stays on this side of the boundary.
//
// Run with: npm run agent -- "your task"

import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { SandboxClient } from "./sandbox.js";

const task =
  process.argv.slice(2).join(" ") ||
  "Generate 10,000 random points in the unit square and use them to estimate pi. " +
    "Then tell me how far off the estimate was.";

// Cap what goes back to the model so a chatty program can't flood the context.
const MAX_OUTPUT_CHARS = 10_000;
const truncate = (s: string) =>
  s.length > MAX_OUTPUT_CHARS
    ? `${s.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
    : s;

const sandboxes = await SandboxClient.fromEnv();
const sandbox = await sandboxes.create({
  image: "nikolaik/python-nodejs:python3.12-nodejs22-slim",
});
console.log(`Sandbox ${sandbox.id} starting...`);

const runCode = betaZodTool({
  name: "run_code",
  description:
    "Execute a Python or JavaScript program in an isolated Linux sandbox. Returns " +
    "its stdout, stderr and exit code. The sandbox persists for this conversation, so " +
    "files written under /tmp/agent are available to later calls. Print anything you " +
    "need to see. Each run is killed after 30 seconds.",
  inputSchema: z.object({
    language: z.enum(["python", "javascript"]),
    code: z.string().describe("The complete program to run."),
  }),
  run: async ({ language, code }) => {
    console.log(`\n--- run_code (${language}) ---\n${code}\n`);
    const r = await sandbox.runCode(language, code, { timeoutSeconds: 30 });
    const status = r.timedOut ? "timed out after 30s" : `exit code ${r.exitCode}`;
    console.log(`--- ${status} ---\n${r.stdout}${r.stderr}`);
    return [
      `status: ${status}`,
      `stdout:\n${truncate(r.stdout)}`,
      `stderr:\n${truncate(r.stderr)}`,
    ].join("\n");
  },
});

const anthropic = new Anthropic();

try {
  await sandbox.waitUntilReady();
  const runner = anthropic.beta.messages.toolRunner({
    model: "claude-opus-5-5",
    max_tokens: 16000,
    // Server-side refusal fallback: if the model declines, the API retries on a
    // fallback model inside the same call. Remove these two lines to opt out.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    max_iterations: 10,
    system:
      "You are a data assistant. Use the run_code tool to compute answers instead of " +
      "estimating them. Keep programs short and print the results you need.",
    tools: [runCode],
    messages: [{ role: "user", content: task }],
  } as Parameters<typeof anthropic.beta.messages.toolRunner>[0]);

  const final = await runner;
  if (final.stop_reason === "refusal") {
    console.log("\nThe model declined this request.");
  } else if (final.stop_reason === "tool_use") {
    console.log("\nStopped after 10 iterations without a final answer.");
  } else {
    const text = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    console.log(`\n=== Answer ===\n${text}`);
  }
} finally {
  await sandbox.destroy();
  console.log(`\nDestroyed ${sandbox.id}`);
}
