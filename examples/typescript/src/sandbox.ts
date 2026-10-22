// A small, dependency-light wrapper around the Northflank JS client that
// exposes the sandbox lifecycle most agent code needs:
//
//   create -> waitUntilReady -> exec / writeFile / runCode -> pause | resume -> destroy
//
// On Northflank, a sandbox is a deployment service. On Northflank's managed
// cloud, each one runs in its own microVM (Kata Containers) with a dedicated
// guest kernel. See ../../../guides/isolation-technologies.md for what that means.

import { randomUUID } from "node:crypto";
import {
  ApiClient,
  ApiClientInMemoryContextProvider,
} from "@northflank/js-client";

/** Every sandbox created by these examples starts with this prefix, so
 *  `npm run cleanup` can find (and only find) them. */
export const SANDBOX_PREFIX = "sbx-";

export interface SandboxOptions {
  /** Container image with the runtimes your agent needs. */
  image?: string;
  /** Northflank compute plan. nf-compute-20 = 0.2 vCPU / 512 MB. */
  plan?: string;
  /** Ephemeral disk per sandbox, in MB. */
  ephemeralStorageMb?: number;
  /** Non-secret environment variables injected at runtime. */
  env?: Record<string, string>;
  /** Volume IDs to attach at creation (see 06-persistent-volume.ts). */
  volumes?: string[];
  /** Extra tags; every sandbox also gets SANDBOX_TAG so network policies
   *  can target sandboxes (see 08-networking.ts). */
  tags?: string[];
}

/** Tag applied to every sandbox these examples create. */
export const SANDBOX_TAG = "agent-sandbox";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the command was killed by the in-sandbox timeout. */
  timedOut: boolean;
}

export interface ExecOptions {
  /** Kill the command after this many seconds (enforced inside the sandbox). */
  timeoutSeconds?: number;
  /** Run as this user instead of the image default, e.g. "nobody". */
  user?: string | number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** Quote a string so `sh -c` receives it as one literal argument. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class SandboxClient {
  private constructor(
    readonly api: ApiClient,
    readonly projectId: string,
  ) {}

  /** Build a client from NF_API_TOKEN and NF_PROJECT_ID. */
  static async fromEnv(): Promise<SandboxClient> {
    const contextProvider = new ApiClientInMemoryContextProvider();
    await contextProvider.addContext({
      name: "agent-sandbox-starter-pack",
      token: requireEnv("NF_API_TOKEN"),
    });
    const api = new ApiClient(contextProvider, {
      throwErrorOnHttpErrorCode: true,
    });
    return new SandboxClient(api, requireEnv("NF_PROJECT_ID"));
  }

  /** Provision a new sandbox and return its ID. Does not wait for it to boot. */
  async create(options: SandboxOptions = {}): Promise<Sandbox> {
    const id = `${SANDBOX_PREFIX}${randomUUID().split("-")[0]}`;
    await this.api.create.service.deployment({
      parameters: { projectId: this.projectId },
      data: {
        name: id,
        description: "Agent sandbox created by agent-sandbox-starter-pack",
        tags: [SANDBOX_TAG, ...(options.tags ?? [])],
        billing: { deploymentPlan: options.plan ?? "nf-compute-20" },
        deployment: {
          instances: 1,
          external: { imagePath: options.image ?? "python:3.12-slim" },
          // Base images exit immediately; keep the sandbox alive so we can exec into it.
          docker: { configType: "customCommand", customCommand: "sleep infinity" },
          storage: {
            ephemeralStorage: { storageSize: options.ephemeralStorageMb ?? 2048 },
          },
        },
        runtimeEnvironment: options.env ?? {},
        // Attach volumes at creation; attaching later (attach.volume) redeploys the sandbox.
        ...(options.volumes?.length
          ? { createOptions: { volumesToAttach: options.volumes } }
          : {}),
      },
    });
    return new Sandbox(this, id);
  }

  /** Get a handle to an existing sandbox by ID. */
  get(id: string): Sandbox {
    return new Sandbox(this, id);
  }

  /** List the IDs of sandboxes created by these examples. */
  async list(): Promise<string[]> {
    // List endpoints return 50 items per page; .all() follows every page.
    const { data } = await this.api.list.services.all({
      parameters: { projectId: this.projectId },
    });
    return data.services
      .map((s) => s.id)
      .filter((id) => id.startsWith(SANDBOX_PREFIX));
  }
}

export class Sandbox {
  constructor(
    private readonly client: SandboxClient,
    readonly id: string,
  ) {}

  private get params() {
    return { projectId: this.client.projectId, serviceId: this.id };
  }

  /** Poll until the sandbox is running. `COMPLETED` means "rolled out and
   *  running", not "exited". */
  async waitUntilReady(timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data } = await this.client.api.get.service({
        parameters: this.params,
      });
      const status =
        data.status && "deployment" in data.status
          ? data.status.deployment?.status
          : undefined;
      if (status === "COMPLETED") {
        // Confirm the sandbox accepts commands before returning.
        const probe = await this.exec("true").catch(() => undefined);
        if (probe?.exitCode === 0) return;
      }
      if (status === "FAILED") {
        throw new Error(`Sandbox ${this.id} failed to start`);
      }
      await sleep(1_000);
    }
    throw new Error(`Sandbox ${this.id} was not ready after ${timeoutMs} ms`);
  }

  /** Run a shell command inside the sandbox and capture its output. */
  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const timeoutSeconds = options.timeoutSeconds ?? 60;
    // `timeout` runs inside the sandbox, so a runaway process is killed there
    // rather than left consuming CPU after we stop waiting for it.
    const wrapped = `timeout -s KILL ${timeoutSeconds} sh -c ${shellQuote(command)}`;
    const result = await this.client.api.exec.execServiceCommand(this.params, {
      command: wrapped,
      shell: "sh -c",
      ...(options.user !== undefined ? { user: options.user } : {}),
    });
    const exitCode = result.commandResult.exitCode;
    return {
      stdout: result.stdOut,
      stderr: result.stdErr,
      exitCode,
      // GNU timeout exits 137 (128 + SIGKILL) when it kills the command.
      timedOut: exitCode === 137,
    };
  }

  /** Write a text file inside the sandbox. Content is base64-encoded in
   *  transit so quotes, newlines and shell metacharacters survive intact.
   *  For large files or directories, use api.upload.service.files instead. */
  async writeFile(path: string, content: string): Promise<void> {
    const encoded = Buffer.from(content, "utf8").toString("base64");
    const dir = path.substring(0, path.lastIndexOf("/")) || "/";
    const result = await this.exec(
      `mkdir -p ${shellQuote(dir)} && printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(path)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`writeFile ${path} failed: ${result.stderr}`);
    }
  }

  /** Read a text file from the sandbox. */
  async readFile(path: string): Promise<string> {
    const result = await this.exec(`cat ${shellQuote(path)}`);
    if (result.exitCode !== 0) {
      throw new Error(`readFile ${path} failed: ${result.stderr}`);
    }
    return result.stdout;
  }

  /** Write `code` to a file and run it with the matching interpreter. */
  async runCode(
    language: "python" | "javascript" | "bash",
    code: string,
    options: ExecOptions = {},
  ): Promise<ExecResult> {
    const files = {
      python: { path: "/tmp/agent/main.py", run: "python3 /tmp/agent/main.py" },
      javascript: { path: "/tmp/agent/main.js", run: "node /tmp/agent/main.js" },
      bash: { path: "/tmp/agent/main.sh", run: "bash /tmp/agent/main.sh" },
    } as const;
    const { path, run } = files[language];
    await this.writeFile(path, code);
    return this.exec(`cd /tmp/agent && ${run}`, options);
  }

  /** Pause: stops compute billing and running processes, keeps configuration
   *  (and any attached volume). Ephemeral disk is lost. */
  async pause(timeoutMs = 120_000): Promise<void> {
    await this.client.api.pause.service({ parameters: this.params });
    // Pausing settles asynchronously; resuming before it has settled can race it.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { data } = await this.client.api.get.service({
        parameters: this.params,
      });
      // Same check as the official Python SDK's wait_for_service_paused: the
      // legacy servicePaused flag, or zero desired deployment instances.
      const legacyFlag = (data as { servicePaused?: boolean }).servicePaused;
      const instances =
        "deployment" in data ? data.deployment?.instances : undefined;
      if (legacyFlag === true || instances === 0) return;
      await sleep(1_000);
    }
    throw new Error(`Sandbox ${this.id} did not pause after ${timeoutMs} ms`);
  }

  /** Resume a paused sandbox and wait until it accepts commands. */
  async resume(): Promise<void> {
    await this.client.api.resume.service({ parameters: this.params, data: {} });
    await this.waitUntilReady();
  }

  /** Permanently delete the sandbox. */
  async destroy(): Promise<void> {
    await this.client.api.delete.service({ parameters: this.params });
  }
}
