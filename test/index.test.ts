import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { createAgentMailExtension, optionsFromEnv } from "../src/index.ts";
import { GUARD_REASON } from "../src/tools.ts";
import { literal, nothingMatches, privateCopy } from "./processes.ts";

const FAKE = privateCopy(join(import.meta.dir, "fixtures", "fake-agent-mail.sh"));
const STATUS = {
  v: 1,
  agent_mail: "2.3.0",
  name: "pi",
  host: "hera",
  paused: false,
  direct: 1,
  broadcast: 0,
  channels: [{ name: "fleet", unread: 2, wake: true, write: false, pinned: false, missing: false }],
  write_targets: [],
  default_channel: "fleet",
  ring: { digest: "0123456789ab", direct: 1, channel: 2 },
  last_delivery: null,
};

type Handler = (event: any, ctx: any) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => {};
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
    getActiveTools() {
      return ["read", "bash", "mcp"];
    },
  };
  return {
    pi,
    handlers,
    commands,
    sent,
    emit(event: string, payload: unknown, ctx: unknown) {
      return (handlers.get(event) ?? []).map((handler) => handler(payload, ctx));
    },
  };
}

function fakeCtx(mode = "rpc") {
  const statuses: Array<[string, string | undefined]> = [];
  const notices: string[] = [];
  return {
    statuses,
    notices,
    ctx: {
      mode,
      hasUI: mode === "rpc" || mode === "tui",
      isIdle: () => true,
      ui: {
        setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
        notify: (text: string) => notices.push(text),
        theme: { fg: (_color: string, text: string) => text },
      },
    },
  };
}

async function until(what: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["FAKE_MODE", "FAKE_JSON"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  (globalThis as any)[Symbol.for("pi-agent-mail/process-slot")] = undefined;
});

function noDoorbellLeft(): boolean {
  // Anchored: the doorbell's command line ends with the parent pid, and a longer pid must not match.
  return nothingMatches(`--parent ${process.pid}$`);
}

describe("registration", () => {
  test("registers its handlers and the /mail command, and starts nothing", () => {
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE })(f.pi as any);
    expect([...f.handlers.keys()].sort()).toEqual(
      [
        "agent_settled",
        "session_shutdown",
        "session_start",
        "tool_call",
        "tool_execution_end",
        "tool_execution_start",
        "input",
        "ui_prompt_end",
        "ui_prompt_start",
      ].sort(),
    );
    const mail = f.commands.get("mail");
    expect(mail.description).toContain("agent-mail");
    expect(mail.getArgumentCompletions("re").map((i: any) => i.value)).toEqual(["resume", "restart"]);
    expect(mail.getArgumentCompletions("zz")).toBeNull();
    expect(f.commands.get("mailbox-check").description).toContain("at most once every TIME");
    expect(f.commands.get("mailbox").description).toContain("/mailbox [NAME] [+topic");
    expect(f.sent).toEqual([]);
  });
});

describe("the bash guard", () => {
  for (const mode of ["tui", "rpc", "print", "json"]) {
    test(`blocks a piped read in ${mode} mode`, async () => {
      const f = fakePi();
      createAgentMailExtension({ bin: FAKE, disabled: mode === "json" })(f.pi as any);
      const [result] = f.emit("tool_call", { toolName: "bash", input: { command: "agent-mail read pi | head -3" } }, fakeCtx(mode).ctx);
      expect(await result).toEqual({ block: true, reason: GUARD_REASON });
    });
  }

  test("lets everything else through", async () => {
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE })(f.pi as any);
    const ctx = fakeCtx().ctx;
    expect(await f.emit("tool_call", { toolName: "bash", input: { command: "agent-mail read pi" } }, ctx)[0]).toBeUndefined();
    expect(await f.emit("tool_call", { toolName: "read", input: { path: "x | head" } }, ctx)[0]).toBeUndefined();
    expect(await f.emit("tool_call", { toolName: "bash", input: {} }, ctx)[0]).toBeUndefined();
  });
});

describe("a session end to end against a fake agent-mail", () => {
  test("lights the status, wakes through sendMessage, and stops its doorbell at shutdown", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("rpc");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => c.statuses.some(([, text]) => text === "✉ pi · 1 direct · ++fleet 2"));
    await until(() => f.sent.length === 1);
    expect(f.sent[0].message.customType).toBe("agent-mail");
    expect(f.sent[0].message.display).toBe(true);
    expect(f.sent[0].message.content).toContain('Call the agent-mail receive tool with me "pi"');
    expect(f.sent[0].message.content).toContain('(in this Pi: the mcp tool with server "agent-mail" and tool "receive")');
    expect(f.sent[0].message.details).toEqual({ name: "pi", direct: 1, channel: 2, digest: "0123456789ab" });
    expect(f.sent[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

    await f.commands.get("mail").handler("", c.ctx);
    expect(c.notices[c.notices.length - 1].split("\n")[0]).toBe("agent-mail: pi@hera (agent-mail 2.3.0)");

    await f.commands.get("mailbox-check").handler(" 4h ", c.ctx);
    expect(c.notices[c.notices.length - 1]).toContain("at most once every 4 h; direct mail still wakes it at once");
    await f.commands.get("mailbox-check").handler("sometimes", c.ctx);
    expect(c.notices[c.notices.length - 1]).toContain("usage: /mailbox-check");
    await f.commands.get("mailbox-check").handler("", c.ctx);
    expect(c.notices[c.notices.length - 1]).toContain("at most once every 4 h");
    await f.commands.get("mail").handler("", c.ctx);
    expect(c.notices[c.notices.length - 1]).toContain("channel posts at most once every 4 h (/mailbox-check)");

    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    expect(c.statuses[c.statuses.length - 1]).toEqual(["agent-mail", undefined]);
    await until(noDoorbellLeft);
  });

  test("an open dialog holds the wake until it closes and Pi settles", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("rpc");
    f.emit("ui_prompt_start", { reason: "ui_prompt", kind: "confirm" }, c.ctx);
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => c.statuses.some(([, text]) => text === "✉ pi · 1 direct · ++fleet 2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.sent).toEqual([]);
    f.emit("ui_prompt_end", { reason: "ui_prompt" }, c.ctx);
    f.emit("agent_settled", { aborted: false }, c.ctx);
    await until(() => f.sent.length === 1);
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(noDoorbellLeft);
  });

  test("a dialog whose end arrived before its start does not hold wakes forever", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("rpc");
    f.emit("ui_prompt_end", { reason: "ui_prompt" }, c.ctx);
    f.emit("ui_prompt_start", { reason: "ui_prompt", kind: "custom" }, c.ctx);
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => c.statuses.some(([, text]) => text === "✉ pi · 1 direct · ++fleet 2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.sent).toEqual([]);
    f.emit("input", { text: "hello", source: "rpc" }, c.ctx);
    f.emit("agent_settled", { aborted: false }, c.ctx);
    await until(() => f.sent.length === 1);
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(noDoorbellLeft);
  });

  test("on agent-mail 2.2 a session with no name source starts no doorbell and shows nothing", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_MODE: "exit2" };
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env })(f.pi as any);
    const c = fakeCtx("tui");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(c.statuses.every(([, text]) => text === undefined)).toBe(true);
    expect(noDoorbellLeft()).toBe(true);
    await f.commands.get("mail").handler("", c.ctx);
    expect(c.notices).toEqual(["agent-mail: inactive (no mailbox name for this session)"]);
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
  });

  test("a draft in the TUI editor holds the wake", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("tui");
    let draft = "half a thought";
    (c.ctx.ui as any).getEditorText = () => draft;
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => c.statuses.some(([, text]) => text === "✉ pi · 1 direct · ++fleet 2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.sent).toEqual([]);
    draft = "";
    f.emit("agent_settled", { aborted: false }, c.ctx);
    await until(() => f.sent.length === 1);
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(noDoorbellLeft);
  });

  test("the doorbell check sees a running doorbell", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("rpc");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => !noDoorbellLeft());
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(noDoorbellLeft);
  });

  test("session_shutdown ends an agent-mail run still in flight", async () => {
    process.env.FAKE_MODE = "sleep";
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("rpc");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    // Anchored to the fixture's own command, so a shell whose command line mentions it never matches.
    const probe = `${literal(FAKE)} pending --format json$`;
    await until(() => !nothingMatches(probe));
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(() => nothingMatches(probe), 3_000);
  });

  test("an editor that cannot be read holds the wake", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("tui");
    let broken = true;
    (c.ctx.ui as any).getEditorText = () => {
      if (broken) throw new Error("editor gone");
      return "";
    };
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await until(() => c.statuses.some(([, text]) => text === "✉ pi · 1 direct · ++fleet 2"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(f.sent).toEqual([]);
    broken = false;
    f.emit("agent_settled", { aborted: false }, c.ctx);
    await until(() => f.sent.length === 1);
    f.emit("session_shutdown", { reason: "quit" }, c.ctx);
    await until(noDoorbellLeft);
  });

  test("the cooldown runs on a monotonic clock, not the wall clock", async () => {
    process.env.FAKE_MODE = "pi2";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const realNow = Date.now;
    Date.now = () => 0;
    try {
      const f = fakePi();
      createAgentMailExtension({ bin: FAKE, env: process.env, cooldownSeconds: 1 })(f.pi as any);
      const c = fakeCtx("rpc");
      f.emit("session_start", { reason: "startup" }, c.ctx);
      await until(() => f.sent.length === 2, 6_000);
      expect(f.sent[1].message.details.digest).toBe("abcdefabcdef");
      f.emit("session_shutdown", { reason: "quit" }, c.ctx);
      await until(noDoorbellLeft);
    } finally {
      Date.now = realNow;
    }
  });

  test("print mode starts nothing", async () => {
    process.env.FAKE_MODE = "pi";
    process.env.FAKE_JSON = JSON.stringify(STATUS);
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, env: process.env })(f.pi as any);
    const c = fakeCtx("print");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(c.statuses).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("PI_AGENT_MAIL=off starts nothing, and /mail says so", async () => {
    const f = fakePi();
    createAgentMailExtension({ bin: FAKE, disabled: true })(f.pi as any);
    const c = fakeCtx("tui");
    f.emit("session_start", { reason: "startup" }, c.ctx);
    await f.commands.get("mail").handler("", c.ctx);
    expect(c.statuses).toEqual([]);
    expect(c.notices).toEqual(["agent-mail: off (PI_AGENT_MAIL=off)"]);
  });
});

describe("optionsFromEnv", () => {
  test("reads each variable", () => {
    expect(optionsFromEnv({})).toEqual({});
    expect(optionsFromEnv({ PI_AGENT_MAIL: "off" })).toEqual({ disabled: true });
    expect(optionsFromEnv({ PI_AGENT_MAIL: "OFF " })).toEqual({ disabled: true });
    expect(optionsFromEnv({ PI_AGENT_MAIL: "on" })).toEqual({});
    expect(optionsFromEnv({ PI_AGENT_MAIL_BIN: " /nix/store/x/bin/agent-mail " })).toEqual({ bin: "/nix/store/x/bin/agent-mail" });
    expect(optionsFromEnv({ PI_AGENT_MAIL_WAKE: "0" })).toEqual({ wake: false });
    expect(optionsFromEnv({ PI_AGENT_MAIL_WAKE: "1" })).toEqual({});
  });

  test("clamps the refresh interval to 10 to 600 seconds", () => {
    expect(optionsFromEnv({ PI_AGENT_MAIL_REFRESH: "45" })).toEqual({ refreshSeconds: 45 });
    expect(optionsFromEnv({ PI_AGENT_MAIL_REFRESH: "1" })).toEqual({ refreshSeconds: 10 });
    expect(optionsFromEnv({ PI_AGENT_MAIL_REFRESH: "99999" })).toEqual({ refreshSeconds: 600 });
    expect(optionsFromEnv({ PI_AGENT_MAIL_REFRESH: "soon" })).toEqual({});
  });
});
