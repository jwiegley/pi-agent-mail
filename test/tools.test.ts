import { describe, expect, test } from "bun:test";

import { classifyCall, GUARD_REASON, guardBash, receiveHint } from "../src/tools.ts";

describe("classifyCall", () => {
  const cases: Array<[string, unknown, string | null]> = [
    ["mcp", { server: "agent-mail", tool: "receive" }, "receive"],
    ["mcp", { server: "agent-mail", tool: "receive", args: '{"me":"pi"}' }, "receive"],
    ["mcp", { tool: "agent_mail_send" }, "send"],
    ["mcp", { tool: "agent-mail_pending" }, "pending"],
    ["mcp", { server: "agent_mail", tool: "channels" }, "channels"],
    ["mcp", { server: "agent-mail", tool: "agent_mail_reread" }, "reread"],
    ["mcp__agent_mail", { tool: "subscribe" }, "subscribe"],
    ["mcp__agent_mail", { tool: "agent_mail_unsubscribe" }, "unsubscribe"],
    ["agent_mail_receive", {}, "receive"],
    ["mcp__agent_mail_receive", {}, "receive"],
    ["mcp__agent_mail__receive", {}, "receive"],
    ["mcp", { server: "other", tool: "receive" }, null],
    ["mcp", { tool: "receive" }, null],
    ["mcp", { search: "mail" }, null],
    ["mcp", { describe: "agent_mail_receive" }, null],
    ["mcp__agent_mail", { tool: "delete" }, null],
    ["mcp__other", { tool: "receive" }, null],
    ["bash", { command: "agent-mail read pi" }, null],
    ["mcp", "string", null],
    ["mcp", null, null],
    ["agent_mail_delete", {}, null],
    ["agent_mail_receive_all", {}, null],
  ];
  for (const [tool, args, op] of cases) {
    test(`${tool} ${JSON.stringify(args)} is ${op}`, () => {
      expect(classifyCall(tool, args)).toBe(op as any);
    });
  }
});

describe("receiveHint", () => {
  test("names the tool that exists", () => {
    expect(receiveHint(["read", "agent_mail_receive", "mcp"])).toBe("the agent_mail_receive tool");
    expect(receiveHint(["agent-mail_receive", "mcp"])).toBe("the agent-mail_receive tool");
    expect(receiveHint(["mcp__agent_mail__receive"])).toBe("the mcp__agent_mail__receive tool");
    expect(receiveHint(["mcp__agent_mail_receive", "mcp"])).toBe("the mcp__agent_mail_receive tool");
    expect(receiveHint(["mcp", "mcp__agent_mail"])).toBe('the mcp__agent_mail tool with tool "receive"');
    expect(receiveHint(["read", "mcp"])).toBe('the mcp tool with server "agent-mail" and tool "receive"');
    expect(receiveHint(["read", "bash"])).toBeNull();
  });
});

describe("guardBash", () => {
  const blocked = [
    "agent-mail read pi | head -5",
    "agent-mail --dir /tmp/m read pi|tail",
    "agent-mail --dir=/tmp/m watch pi | grep x",
    "python3 -I ~/src/sys/agent-mail/agent-mail watch pi | grep x",
    "python3 /Users/johnw/src/sys/agent-mail/agent-mail read pi | head",
    "/nix/store/abc-agent-mail-2.3.0/bin/agent-mail read pi | /usr/bin/sed -n 1p",
    "cd x && agent-mail read pi | head",
    "agent-mail read pi | tee out | head",
    "agent-mail watch --doorbell | head -1",
    "true; agent-mail read pi | grep -v x",
    "agent-mail read pi 2>&1 | tail -n 3",
    "agent-mail read pi |\n  head -20",
    "agent-mail read pi |&\n  head -20",
    "agent-mail read pi \\\n  | head",
    "out=$(agent-mail read pi | head -20)",
    "(agent-mail read pi) | head",
    "timeout 60 agent-mail watch pi | head -5",
    "timeout -k 5 60 agent-mail read pi | head",
    "sudo -u johnw agent-mail read pi | tail",
    "nice -n 5 agent-mail read pi | grep x",
    "stdbuf -oL agent-mail watch pi | grep x",
    "env -i HOME=/h agent-mail read pi | head",
    "x=$(agent-mail read pi | head)",
    "(agent-mail read pi | head)",
    "{ agent-mail read pi | tail; }",
    "bash -c 'agent-mail read pi | head -3'",
    'sh -c "agent-mail watch pi | grep x"',
    "bash -lc 'cd /tmp && agent-mail read pi | tail'",
    "bash <<'EOF'\nagent-mail read pi | head\nEOF",
    "cat <<EOF | sh\nagent-mail read pi | tail\nEOF",
    'agent-mail "read" pi | head',
    "agent-mail read pi | timeout 5 head",
  ];
  for (const command of blocked) {
    test(`blocks: ${command}`, () => {
      expect(guardBash(command)).toBe(GUARD_REASON);
    });
  }

  const passed = [
    "agent-mail read pi",
    "agent-mail read pi > out.txt",
    "agent-mail read pi | tee out",
    "grep agent-mail README.md | head",
    "agent-mail pending pi | head",
    "agent-mail channels | grep fleet",
    'echo "agent-mail read pi | head"',
    "printf '%s' agent-mail read | head",
    "agent-mail read pi || head -1 log",
    "agent-mail-other read pi | head",
    "head -1 file | agent-mail read pi",
    "",
    "cat >> NOTES.md <<'EOF'\nagent-mail read pi | head -5\nEOF",
    "cat <<-EOF\n\tagent-mail read pi | head\n\tEOF\necho done",
    'cat <<"DOC" > notes.md\nNever run agent-mail watch pi | grep x.\nDOC',
    "timeout 60 agent-mail pending pi | head",
    "sudo -u johnw agent-mail channels | grep fleet",
    "bash -c 'agent-mail read pi'",
    "bash -c 'echo hi' | head",
    "x=$(agent-mail pending pi | head)",
  ];
  for (const command of passed) {
    test(`passes: ${JSON.stringify(command)}`, () => {
      expect(guardBash(command)).toBeNull();
    });
  }

  test("the reason states agent-mail's rule", () => {
    expect(GUARD_REASON).toContain("never pipe agent-mail read or watch through head, tail, sed or grep");
    expect(GUARD_REASON).toContain("receive tool");
  });
});
