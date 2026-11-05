// The two ways the extension runs agent-mail: one short command at a time
// (pending), with a deadline and an output cap, and the long-lived doorbell,
// whose stdout lines it hands on whole. Neither uses a shell.

import { type ChildProcess, spawn } from "node:child_process";

export const RUN_TIMEOUT_MS = 10_000;
export const RUN_MAX_BYTES = 65_536;
export const MAX_LINE = 2_048;
const KILL_GRACE_MS = 1_000;

// The environment nix-config's managed MCP stdio transport gives the
// agent-mail server: its platform baseline and the session identity names
// (config/ai/managed-stdio.nix). agent-mail runs here get the same, plus
// PATH to find the program, so they bind the name and mailbox the server binds.
export const PLATFORM_ENVIRONMENT = [
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "NIX_SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "SHELL",
  "SSL_CERT_FILE",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
] as const;
export const SESSION_ENVIRONMENT = [
  "AGENTDECK_IDENTITY_FILE",
  "AGENTDECK_INSTANCE_ID",
  "AGENTDECK_TITLE",
  "AGENT_MAIL_CONFIG",
  "AGENT_MAIL_NAME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_JOB_DIR",
] as const;

/** The variables of ENV that the managed agent-mail MCP server would see, plus PATH. */
export function sessionEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...PLATFORM_ENVIRONMENT, ...SESSION_ENVIRONMENT, "PATH"]) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
  spawnError: string | null;
}

export interface RunOptions {
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

// Each child leads its own process group, so stopping it also stops anything
// it started, and nothing is left holding its stdout open.
function launch(bin: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined): ChildProcess | string {
  try {
    return spawn(bin, [...args], { stdio: ["ignore", "pipe", "ignore"], env: env ?? process.env, detached: true });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function terminate(child: ChildProcess): void {
  signalGroup(child, "SIGTERM");
  setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS).unref();
}

/** Run agent-mail once and collect its stdout; stderr is discarded. Never rejects. */
export function runAgentMail(bin: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? RUN_MAX_BYTES;
  return new Promise((resolve) => {
    const child = launch(bin, args, opts.env);
    if (typeof child === "string") {
      resolve({ code: null, signal: null, stdout: "", timedOut: false, truncated: false, spawnError: child });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(chunks).toString("utf8"), timedOut, truncated, spawnError });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      finish(null, null);
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        terminate(child);
        finish(null, null);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on("error", (error) => {
      spawnError = error.message;
      if (child.pid === undefined) finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export interface DoorbellHandle {
  readonly pid: number | undefined;
  stop(): void;
}

export interface DoorbellOptions {
  env?: NodeJS.ProcessEnv;
  maxLine?: number;
}

/**
 * Start `agent-mail watch --doorbell --forever --parent PARENT`. Each complete
 * stdout line of at most maxLine characters goes to onLine; a longer one is
 * dropped whole. onExit runs once, when the doorbell ends or cannot start.
 */
export function startDoorbell(
  bin: string,
  parentPid: number,
  onLine: (line: string) => void,
  onExit: (code: number | null, signal: string | null) => void,
  opts: DoorbellOptions = {},
): DoorbellHandle {
  const maxLine = opts.maxLine ?? MAX_LINE;
  let exited = false;
  const finish = (code: number | null, signal: string | null) => {
    if (exited) return;
    exited = true;
    onExit(code, signal);
  };
  const child = launch(bin, ["watch", "--doorbell", "--forever", "--parent", String(parentPid)], opts.env);
  if (typeof child === "string") {
    queueMicrotask(() => finish(null, null));
    return { pid: undefined, stop() {} };
  }
  let buffer = "";
  let dropping = false;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (text: string) => {
    buffer += text;
    let end = buffer.indexOf("\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (dropping) dropping = false;
      else if (line.length <= maxLine) onLine(line);
      end = buffer.indexOf("\n");
    }
    if (buffer.length > maxLine) {
      buffer = "";
      dropping = true;
    }
  });
  child.on("error", () => {
    if (child.pid === undefined) finish(null, null);
  });
  child.on("close", (code, signal) => finish(code, signal));
  // Pi's own exit never waits for the doorbell; session_shutdown stops it, and
  // --parent ends it if Pi goes first.
  child.unref();
  return {
    get pid() {
      return child.pid;
    },
    stop() {
      if (!exited) terminate(child);
    },
  };
}
