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
// pi-mcp-adapter's default "server" prefix keeps the hyphen (agent-mail_receive); its
// other prefixes and Pi's built-in MCP use underscores.
const DIRECT_RECEIVE = [
  "agent_mail_receive",
  "agent-mail_receive",
  "mcp__agent_mail__receive",
  "mcp__agent_mail_receive",
] as const;

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
// A shell named as a command: its heredoc body, or its -c argument, is commands too.
const SHELL_COMMAND = /(?:^|[|;&(]\s*|\s)(?:\S*\/)?(?:ba|z|da|k)?sh(?:\s|$)/;
const SHELL_C = /(?:^|[\s|;&(])(?:\S*\/)?(?:ba|z|da|k)?sh\s+(?:-[A-Za-z]+\s+)*?-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*?)\1/g;

/** COMMAND without the heredoc bodies that are data; a body fed to a shell is kept, since it runs. */
function withoutHeredocs(command: string): string {
  const kept: string[] = [];
  let end: string | null = null;
  let tabs = false;
  let runs = false;
  for (const line of command.split("\n")) {
    if (end !== null) {
      if ((tabs ? line.replace(/^\t+/, "") : line) === end) end = null;
      else if (runs) kept.push(line);
      continue;
    }
    kept.push(line);
    const opened = HEREDOC.exec(line);
    if (opened) {
      tabs = opened[1] === "-";
      end = opened[3];
      runs = SHELL_COMMAND.test(line.slice(0, opened.index)) || SHELL_COMMAND.test(line.slice(opened.index + opened[0].length));
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

/** A pipeline stage's words; substitution, subshell and group openers and closers are dropped. */
function words(stage: string): string[] {
  return stage
    .replace(/\$\(|`|(^|\s)[({]+/g, " ")
    .replace(/[)}]+(?=\s|$)/g, " ")
    .trim()
    .replace(/^&\s*/, "")
    .split(/\s+/)
    .filter(Boolean);
}

function unquote(word: string): string {
  return word.replace(/^['"]+|['"]+$/g, "");
}

function base(word: string): string {
  return unquote(word).split("/").pop() ?? "";
}

/** Where the command itself starts in W: past assignments, and wrappers with their options. */
function commandIndex(w: string[]): number {
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
  return i;
}

/** True when STAGE runs `agent-mail read` or `agent-mail watch`, directly, through python, or through a wrapper. */
function runsReadOrWatch(stage: string): boolean {
  const w = words(stage);
  let i = commandIndex(w);
  if (i < w.length && PYTHON.test(base(w[i]))) {
    i++;
    while (i < w.length && /^-[A-Za-z]+$/.test(w[i])) i++;
  }
  if (i >= w.length || base(w[i]) !== "agent-mail") return false;
  i++;
  while (i < w.length && unquote(w[i]).startsWith("--")) i += unquote(w[i]) === "--dir" ? 2 : 1;
  return i < w.length && (unquote(w[i]) === "read" || unquote(w[i]) === "watch");
}

/** True when STAGE runs head, tail, sed or grep, directly or through a wrapper. */
function cuts(stage: string): boolean {
  const w = words(stage);
  const i = commandIndex(w);
  return i < w.length && CUTTERS.has(base(w[i]));
}

/**
 * The reason to block a bash command that pipes agent-mail read or watch into a cutter, else
 * null. It is a text check of the usual spellings, including a shell's -c argument and a
 * heredoc fed to a shell; quoting tricks, aliases and scripts can still hide the pipe.
 */
export function guardBash(command: string, depth = 0): string | null {
  const line = logical(command);
  for (const part of line.split(/\n|;|&&|\|\|/)) {
    const stages = part.split("|");
    for (let s = 0; s < stages.length - 1; s++) {
      if (runsReadOrWatch(stages[s]) && stages.slice(s + 1).some(cuts)) return GUARD_REASON;
    }
  }
  if (depth < 2) {
    for (const inner of line.matchAll(SHELL_C)) {
      if (guardBash(inner[2], depth + 1)) return GUARD_REASON;
    }
  }
  return null;
}
