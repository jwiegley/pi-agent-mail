// How the extension recognises the agent's agent-mail tool calls, names the
// receive tool that exists in this Pi, and holds back the one CLI misuse
// that loses mail.

export type AgentMailOp = "send" | "receive" | "pending" | "subscribe" | "unsubscribe" | "channels" | "reread";

const OPS: ReadonlySet<string> = new Set(["send", "receive", "pending", "subscribe", "unsubscribe", "channels", "reread"]);
// A tool named for agent-mail: pi-mcp-adapter's prefixed direct tools
// (agent_mail_receive, mcp__agent_mail_receive) and Pi's built-in MCP
// (mcp__agent_mail__receive); also the names the mcp proxy accepts in `tool`.
const PREFIXED = /^(?:mcp__)?agent[_-]mail(?:__|_)(send|receive|pending|subscribe|unsubscribe|channels|reread)$/;
const NAMESPACE_TOOL = "mcp__agent_mail";
const PROXY_TOOL = "mcp";
const DIRECT_RECEIVE = ["agent_mail_receive", "mcp__agent_mail__receive", "mcp__agent_mail_receive"] as const;

export const GUARD_REASON =
  "agent-mail's rule: never pipe agent-mail read or watch through head, tail, sed or grep: what they print is consumed, " +
  "so whatever the pipe cuts off is lost. Use the agent-mail receive tool, or run the command without that pipe.";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The agent-mail tool a finished call reached, or null when it reached none. */
export function classifyCall(toolName: string, args: unknown): AgentMailOp | null {
  const direct = PREFIXED.exec(toolName);
  if (direct) return direct[1] as AgentMailOp;
  if (toolName !== PROXY_TOOL && toolName !== NAMESPACE_TOOL) return null;
  if (!isObject(args) || typeof args.tool !== "string") return null;
  const named = PREFIXED.exec(args.tool);
  if (named) return named[1] as AgentMailOp;
  const forAgentMail = toolName === NAMESPACE_TOOL || args.server === "agent-mail" || args.server === "agent_mail";
  return forAgentMail && OPS.has(args.tool) ? (args.tool as AgentMailOp) : null;
}

/** How to reach agent-mail's receive in this Pi, from the tools it has, or null when none can. */
export function receiveHint(toolNames: readonly string[]): string | null {
  const names = new Set(toolNames);
  for (const name of DIRECT_RECEIVE) {
    if (names.has(name)) return `the ${name} tool`;
  }
  if (names.has(NAMESPACE_TOOL)) return `the ${NAMESPACE_TOOL} tool with tool "receive"`;
  if (names.has(PROXY_TOOL)) return 'the mcp tool with server "agent-mail" and tool "receive"';
  return null;
}

const CUTTERS: ReadonlySet<string> = new Set(["head", "tail", "sed", "grep"]);
// Commands that run the command after them; their options are skipped, with
// the value of an option that takes one, and timeout's duration.
const WRAPPERS: ReadonlySet<string> = new Set(["env", "command", "exec", "nohup", "time", "timeout", "stdbuf", "nice", "sudo", "doas"]);
const OPTIONS_WITH_VALUES: ReadonlySet<string> = new Set(["-n", "-u", "-g", "-s", "-k", "-C", "-p", "-U"]);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const PYTHON = /^python(?:3(?:\.\d+)?)?$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEREDOC = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;

/** COMMAND without its heredoc bodies, which are data, not commands. */
function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  let tabs = false;
  for (const line of command.split("\n")) {
    if (end !== null) {
      if ((tabs ? line.replace(/^\t+/, "") : line) === end) end = null;
      continue;
    }
    kept.push(line);
    const opened = HEREDOC.exec(line);
    if (opened) {
      tabs = opened[1] === "-";
      end = opened[3];
    }
  }
  return kept.join("\n");
}

/** One logical command line: backslash-newlines and newlines after a pipe join their lines. */
function logical(command: string): string {
  return withoutHeredocs(command)
    .replace(/\\\n/g, " ")
    .replace(/(\|&?)[ \t]*\n/g, "$1 ");
}

/** A pipeline stage's words; command substitution, subshell and group openers are dropped. */
function words(stage: string): string[] {
  return stage
    .replace(/\$\(|`|(^|\s)[({]+/g, " ")
    .trim()
    .replace(/^&\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
}

function base(word: string): string {
  return word.replace(/^['"]+|['"]+$/g, "").split("/").pop() ?? "";
}

/** True when STAGE runs `agent-mail read` or `agent-mail watch`, directly, through python, or through a wrapper. */
function runsReadOrWatch(stage: string): boolean {
  const w = words(stage);
  let i = 0;
  while (i < w.length) {
    if (ASSIGNMENT.test(w[i])) {
      i++;
      continue;
    }
    const wrapper = base(w[i]);
    if (!WRAPPERS.has(wrapper)) break;
    i++;
    while (i < w.length && w[i].startsWith("-")) i += OPTIONS_WITH_VALUES.has(w[i]) ? 2 : 1;
    if (wrapper === "timeout" && i < w.length && DURATION.test(w[i])) i++;
  }
  if (i < w.length && PYTHON.test(base(w[i]))) {
    i++;
    while (i < w.length && /^-[A-Za-z]+$/.test(w[i])) i++;
  }
  if (i >= w.length || base(w[i]) !== "agent-mail") return false;
  i++;
  while (i < w.length && w[i].startsWith("--")) i += w[i] === "--dir" ? 2 : 1;
  return i < w.length && (w[i] === "read" || w[i] === "watch");
}

/** The reason to block a bash command that pipes agent-mail read or watch into a cutter, else null. */
export function guardBash(command: string): string | null {
  for (const part of logical(command).split(/\n|;|&&|\|\|/)) {
    const stages = part.split("|");
    for (let s = 0; s < stages.length - 1; s++) {
      if (!runsReadOrWatch(stages[s])) continue;
      const cut = stages.slice(s + 1).some((later) => {
        const w = words(later);
        return w.length > 0 && CUTTERS.has(base(w[0]));
      });
      if (cut) return GUARD_REASON;
    }
  }
  return null;
}
