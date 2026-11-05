import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";

// A local model for the end-to-end run; no request leaves Pi. It answers by
// the last message in its context:
// - the extension's wake notice: call agent-mail's receive through the mcp
//   proxy, or say "no-adapter" when this Pi has no mcp tool;
// - the prompt "guard-check": run a bash command that pipes agent-mail read
//   into head, which the extension must block;
// - a tool result: say "done", naming the tool and whether it failed;
// - anything else: say "ok".

const NAME = process.env.AGENT_MAIL_NAME ?? "testpi";
let turn = 0;

function textOf(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part: any) => part?.type === "text")
    .map((part: any) => part.text)
    .join("\n");
}

// Pi 1.5 carries tool declarations in system messages (toolsAdded and
// toolsRemoved), not in a tools field of the context.
function toolNames(messages: any[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message?.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) if (tool?.name) names.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) names.delete(typeof tool === "string" ? tool : tool?.name);
  }
  return names;
}

function respond(context: any) {
  turn++;
  const messages: any[] = context?.messages ?? [];
  const last = [...messages].reverse().find((message) => message?.role !== "system");
  const tools = toolNames(messages);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage(`done: ${last.toolName} ${last.isError ? "failed" : "succeeded"}`);
  }
  const text = textOf(last);
  if (text.includes(`peer mail is waiting for ${NAME}`)) {
    if (!tools.has("mcp")) return fauxAssistantMessage("no-adapter");
    return fauxAssistantMessage(
      fauxToolCall("mcp", { server: "agent-mail", tool: "receive", args: { me: NAME } }, { id: `receive-${turn}` }),
      { stopReason: "toolUse" },
    );
  }
  if (text.trim() === "guard-check") {
    return fauxAssistantMessage(fauxToolCall("bash", { command: `agent-mail read ${NAME} | head -1` }, { id: `guard-${turn}` }), {
      stopReason: "toolUse",
    });
  }
  return fauxAssistantMessage("ok");
}

export default function syntheticMail(pi: any) {
  const faux = registerFauxProvider({
    api: "synthetic-mail-api",
    provider: "synthetic-mail",
    models: [{ id: "target", name: "Synthetic Mail" }],
  });
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider("synthetic-mail", {
    baseUrl: "synthetic://local",
    apiKey: "synthetic",
    api: faux.api,
    models: faux.models,
  });
}
