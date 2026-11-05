// The contract against a real agent-mail 2.3 program: a private mailbox made
// with init, two subscriptions, mail of each kind, and the JSON status read by
// the extension's own parser. Skipped unless PI_AGENT_MAIL_TEST_BIN names the
// program; it never touches ~/Mailbox.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRingLine, parseStatus } from "../src/contract.ts";
import { runAgentMail } from "../src/process.ts";

const PROGRAM = process.env.PI_AGENT_MAIL_TEST_BIN;
const root = mkdtempSync(join(tmpdir(), "pi-agent-mail-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    AGENT_MAIL_DIR: join(root, "mailbox"),
    ...extra,
  };
}

function am(args: string[], body?: string): string {
  return execFileSync(PROGRAM as string, args, { env: env(), input: body, encoding: "utf8" });
}

describe.skipIf(!PROGRAM)("agent-mail pending --format json, for real", () => {
  test("reads a mailbox with direct mail, a wake channel, a quiet channel and a broadcast", async () => {
    for (const dir of ["home", "tmp", "mailbox"]) mkdirSync(join(root, dir), { recursive: true });
    am(["init"]);
    am(["channel", "create", "ops", "--purpose", "contract wake channel"]);
    am(["channel", "create", "notes", "--purpose", "contract quiet channel"]);
    am(["subscribe", "pi", "ops", "--wake"]);
    am(["subscribe", "pi", "notes", "--write"]);
    am(["send", "--from", "peer", "--to", "pi", "--subject", "subject-alpha", "-"], "body-one\n");
    am(["send", "--from", "peer", "--to", "+ops", "--subject", "subject-beta", "-"], "body-two\n");
    am(["send", "--from", "peer", "--to", "+notes", "--subject", "subject-gamma", "-"], "body-three\n");
    await new Promise((resolve) => setTimeout(resolve, 2_500)); // past agent-mail's 2 s settle window

    const named = await runAgentMail(PROGRAM as string, ["pending", "pi", "--format", "json"], { env: env() });
    expect(named.code).toBe(0);
    const parsed = parseStatus(named.stdout);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind !== "ok") return;
    const s = parsed.status;
    expect(s.name).toBe("pi");
    expect(s.direct).toBe(1);
    expect(s.channels.map((c) => [c.name, c.unread, c.wake, c.write])).toEqual([
      ["notes", 1, false, true],
      ["ops", 1, true, false],
    ]);
    expect(s.writeTargets).toEqual(["notes"]);
    expect(s.ring?.direct).toBe(1);
    expect(s.ring?.channel).toBe(1);
    for (const peerText of ["peer", "subject-", "body-", "_from-"]) {
      expect(named.stdout.includes(peerText)).toBe(false);
    }

    const context = await runAgentMail(PROGRAM as string, ["pending", "pi", "--format", "context"], { env: env() });
    const ring = parseRingLine(context.stdout.replace(/\n$/, ""));
    expect(ring?.digest).toBe(s.ring?.digest);

    const unnamed = await runAgentMail(PROGRAM as string, ["pending", "--format", "json"], { env: env({ AGENT_MAIL_NAME: "pi" }) });
    const viaEnv = parseStatus(unnamed.stdout);
    expect(viaEnv.kind === "ok" && viaEnv.status.name).toBe("pi");
  }, 30_000); // agent-mail's settle window and about ten runs of the real program

  test("a session with no name gets one JSON failure line and nothing on stderr", () => {
    const result = spawnSync(PROGRAM as string, ["pending", "--format", "json"], { env: env(), encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("");
    const parsed = parseStatus(result.stdout);
    expect(parsed.kind === "error" && parsed.error).toBe("no_identity");
  });

  test("a missing mailbox is a JSON failure too", () => {
    const missing = join(root, "no-such-mailbox");
    const result = spawnSync(PROGRAM as string, ["pending", "pi", "--format", "json"], {
      env: { ...env(), AGENT_MAIL_DIR: missing },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    const parsed = parseStatus(result.stdout);
    expect(parsed.kind === "error" && parsed.error).toBe("mailbox_missing");
  });
});
