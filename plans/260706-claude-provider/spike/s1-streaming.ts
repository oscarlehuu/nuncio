// S1 — Streaming input mode + deltas.
// Confirms: system/init first (session_id), initializationResult() shape (models+account),
// stream_event delta payload path, message-id changes across blocks (glued-text risk),
// and that result.result == concatenation of emitted text.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg, redact, trim } from "./spike-common.ts";

const q = new MessageQueue();
q.push(userMsg("Reply with exactly two short sentences about the color blue. No preamble."));

const handle = query({
  prompt: q,
  options: {
    cwd: WS1,
    model: HAIKU,
    maxTurns: 1,
    includePartialMessages: true,
    settingSources: [], // v1 default — isolate from ~/.claude
  },
});

let sawInit = false;
let deltaText = "";
const deltaEvents: string[] = [];
const assistantMsgIds = new Set<string>();
let resultText = "";

// Kick off initializationResult() in parallel (resolves once init arrives).
handle.initializationResult().then((init) => {
  console.log("\n[S1] initializationResult():");
  console.log("  models count:", init.models?.length);
  console.log("  first 3 models:", trim(init.models?.slice(0, 3), 600));
  console.log("  account:", redact(JSON.stringify(init.account)));
}).catch((e) => console.log("[S1] initializationResult error:", (e as Error).message));

for await (const msg of handle) {
  if (msg.type === "system" && msg.subtype === "init") {
    sawInit = true;
    console.log("[S1] system/init  session_id:", msg.session_id, "model:", msg.model);
    console.log("[S1]   tools:", trim(msg.tools, 200), "permissionMode:", msg.permissionMode);
  } else if (msg.type === "stream_event") {
    const ev: any = msg.event;
    // capture the exact delta path
    if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
      deltaText += ev.delta.text;
      deltaEvents.push(`delta[msg=${msg.uuid.slice(0, 8)}]: ${JSON.stringify(ev.delta.text)}`);
    } else {
      deltaEvents.push(`event.type=${ev.type}${ev.delta ? " delta.type=" + ev.delta.type : ""}`);
    }
  } else if (msg.type === "assistant") {
    assistantMsgIds.add((msg as any).message?.id ?? "?");
  } else if (msg.type === "result") {
    resultText = (msg as any).result ?? "";
    console.log("\n[S1] result subtype:", msg.subtype, "is_error:", (msg as any).is_error);
    console.log("[S1]   cost_usd:", (msg as any).total_cost_usd, "num_turns:", (msg as any).num_turns);
    q.close();
    break;
  }
}

console.log("\n[S1] --- delta events (first 8) ---");
deltaEvents.slice(0, 8).forEach((e) => console.log("  " + e));
console.log("[S1] distinct assistant message ids:", [...assistantMsgIds]);
console.log("[S1] concatenated deltaText === result.result ?",
  deltaText.trim() === resultText.trim());
console.log("[S1]   deltaText:", JSON.stringify(deltaText.trim()));
console.log("[S1]   result   :", JSON.stringify(resultText.trim()));
console.log("[S1] sawInit:", sawInit);
process.exit(0);
