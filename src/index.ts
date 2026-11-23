// pi-agent-mail: a Pi extension that keeps a session with an agent-mail name
// in touch with its mailbox. It runs agent-mail's doorbell and wakes the
// agent with a fixed notice when peer mail waits, watches the agent's own
// agent-mail tool calls, holds back the one CLI misuse that loses mail, and
// keeps a status light of the subscribed channels and what waits in each.
// It never receives mail itself: the agent-mail MCP server stays the reader.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type Config, Controller, type Deps, type ProcessSlot } from "./controller.ts";
import { runAgentMail, sessionEnvironment, startDoorbell } from "./process.ts";
import type { Theme } from "./render.ts";
import { guardBash } from "./tools.ts";

export interface AgentMailOptions {
  /** The agent-mail executable; default `agent-mail` on PATH. */
  bin?: string;
  /** Start with automatic wakes on (default) or off. */
  wake?: boolean;
  /** Seconds between refreshes of the light, 10 to 600 (default 30). */
  refreshSeconds?: number;
  /** Seconds between automatic wakes (default 20). */
  cooldownSeconds?: number;
  /** Do nothing but the bash guard. */
  disabled?: boolean;
  /** The environment agent-mail runs with; default the managed MCP server's set, taken from Pi's. */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_REFRESH_SECONDS = 30;
export const MIN_REFRESH_SECONDS = 10;
export const MAX_REFRESH_SECONDS = 600;
export const DEFAULT_COOLDOWN_SECONDS = 20;
export const STATUS_KEY = "agent-mail";
export const MESSAGE_TYPE = "agent-mail";
export const SUBCOMMANDS = ["check", "pause", "resume", "restart"] as const;

const SLOT_KEY = Symbol.for("pi-agent-mail/process-slot");
const PLAIN: Theme = { fg: (_color, text) => text };
// agent-mail's sources of a session's name (resolve_identity), as its environment carries them.
const NAME_SOURCES = ["AGENT_MAIL_NAME", "AGENTDECK_TITLE", "AGENTDECK_IDENTITY_FILE", "AGENTDECK_INSTANCE_ID"] as const;

function clampRefresh(seconds: number): number {
  return Math.min(MAX_REFRESH_SECONDS, Math.max(MIN_REFRESH_SECONDS, Math.round(seconds)));
}

/** Options from PI_AGENT_MAIL, PI_AGENT_MAIL_BIN, PI_AGENT_MAIL_WAKE and PI_AGENT_MAIL_REFRESH. */
export function optionsFromEnv(env: Record<string, string | undefined>): AgentMailOptions {
  const options: AgentMailOptions = {};
  if (env.PI_AGENT_MAIL?.trim().toLowerCase() === "off") options.disabled = true;
  const bin = env.PI_AGENT_MAIL_BIN?.trim();
  if (bin) options.bin = bin;
  if (env.PI_AGENT_MAIL_WAKE?.trim() === "0") options.wake = false;
  const refresh = env.PI_AGENT_MAIL_REFRESH?.trim();
  if (refresh && Number.isFinite(Number(refresh))) options.refreshSeconds = clampRefresh(Number(refresh));
  return options;
}

/** The record every instance in this Pi process shares, even across reloads of this module. */
function processSlot(): ProcessSlot {
  const holder = globalThis as unknown as Record<symbol, ProcessSlot | undefined>;
  holder[SLOT_KEY] ??= { owner: null, carry: null };
  return holder[SLOT_KEY];
}

function unref<T extends { unref?: () => unknown }>(timer: T): T {
  timer.unref?.();
  return timer;
}

/**
 * True while John has a draft in the TUI editor; never true outside the TUI. An editor that
 * cannot be read counts as holding a draft, so a failing context holds wakes rather than
 * letting one through.
 */
function hasDraft(ctx: ExtensionContext): boolean {
  if (ctx.mode !== "tui") return false;
  try {
    return (ctx.ui.getEditorText?.() ?? "").trim() !== "";
  } catch {
    return true;
  }
}

export function createAgentMailExtension(options: AgentMailOptions = {}): (pi: ExtensionAPI) => void {
  const bin = options.bin ?? "agent-mail";
  const config: Config = {
    wake: options.wake ?? true,
    refreshMs: clampRefresh(options.refreshSeconds ?? DEFAULT_REFRESH_SECONDS) * 1_000,
    cooldownMs: Math.max(0, options.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS) * 1_000,
  };

  return function agentMail(pi: ExtensionAPI): void {
    let controller: Controller | null = null;
    let runs: AbortController | null = null;
    // A dialog waiting on John holds wakes. Pi delivers the start and end of a dialog in
    // separate dispatches that can arrive out of order, so the hold also lifts when John
    // types and when Pi settles, rather than counting and sticking.
    let promptOpen = false;

    // agent-mail's rule, in every mode: never pipe read or watch into a cutter.
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== "string") return undefined;
      const reason = guardBash(command);
      return reason ? { block: true, reason } : undefined;
    });

    pi.on("session_start", (_event, ctx) => {
      controller?.stop();
      runs?.abort();
      controller = null;
      if (options.disabled) return;
      const env = options.env ?? sessionEnvironment(process.env);
      const aborter = new AbortController();
      runs = aborter;
      const deps: Deps = {
        slot: processSlot(),
        run: (args) => runAgentMail(bin, args, { env, signal: aborter.signal }),
        startDoorbell: (onLine, onExit) => startDoorbell(bin, process.pid, onLine, onExit, { env }),
        // Monotonic, so a clock step never stretches the cooldown; the hand-over between
        // runtimes stays inside this process, where it is comparable.
        now: () => performance.now(),
        setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
        clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => unref(setInterval(fn, ms)),
        clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        // These run from timers and child-process callbacks, so none of them may throw:
        // a context that is being torn down answers "busy", "no tools" and "plain".
        isIdle: () => {
          try {
            return ctx.isIdle() && !promptOpen && !hasDraft(ctx);
          } catch {
            return false;
          }
        },
        hasNameSource: () => NAME_SOURCES.some((name) => (env[name] ?? "").trim() !== ""),
        toolNames: () => {
          try {
            return pi.getActiveTools();
          } catch {
            return [];
          }
        },
        sendWake: (text, details) =>
          pi.sendMessage(
            { customType: MESSAGE_TYPE, content: text, display: true, details },
            { triggerTurn: true, deliverAs: "followUp" },
          ),
        setStatus: (text) => {
          try {
            if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
          } catch {
            // A runtime being torn down may refuse UI calls; the light is best effort.
          }
        },
        theme: () => {
          try {
            return (ctx.ui?.theme as Theme | undefined) ?? PLAIN;
          } catch {
            return PLAIN;
          }
        },
      };
      controller = new Controller(deps, config);
      void controller.start(ctx.mode);
    });

    pi.on("session_shutdown", () => {
      controller?.stop();
      controller = null;
      runs?.abort();
      runs = null;
      promptOpen = false;
    });

    pi.on("agent_settled", (event) => {
      promptOpen = false;
      void controller?.onSettled(Boolean((event as { aborted?: boolean } | undefined)?.aborted));
    });

    pi.on("ui_prompt_start", () => {
      promptOpen = true;
    });

    pi.on("ui_prompt_end", () => {
      promptOpen = false;
    });

    pi.on("input", () => {
      promptOpen = false;
      return undefined;
    });

    pi.on("tool_execution_start", (event) => {
      controller?.onToolStart(event.toolCallId, event.toolName, event.args);
    });

    pi.on("tool_execution_end", (event) => {
      controller?.onToolEnd(event.toolCallId, event.toolName);
    });

    pi.registerCommand("mailbox", {
      description: "agent-mail: join this session's mailbox and wire its topics: /mailbox [NAME] [+topic | ++topic | !+topic | !++topic ...]",
      handler: async (args, ctx) => {
        let text: string;
        if (options.disabled) text = "agent-mail: off (PI_AGENT_MAIL=off)";
        else if (controller) text = await controller.mailbox(args);
        else text = "agent-mail: not started";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      },
    });

    pi.registerCommand("mailbox-check", {
      description: "agent-mail: wake this session for channel posts at most once every TIME (5m, 4h, 1d), or default; direct mail always wakes at once",
      handler: async (args, ctx) => {
        let text: string;
        if (options.disabled) text = "agent-mail: off (PI_AGENT_MAIL=off)";
        else if (controller) text = await controller.mailboxCheck(args);
        else text = "agent-mail: not started";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      },
    });

    pi.registerCommand("mail", {
      description: "agent-mail: this session's channels and waiting mail; /mail check | pause | resume | restart",
      getArgumentCompletions: (prefix: string) => {
        const items = SUBCOMMANDS.filter((word) => word.startsWith(prefix.trim())).map((word) => ({ value: word, label: word }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        let text: string;
        if (options.disabled) text = "agent-mail: off (PI_AGENT_MAIL=off)";
        else if (controller) text = await controller.command(args);
        else text = "agent-mail: not started";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
      },
    });
  };
}

export default createAgentMailExtension(optionsFromEnv(process.env));
