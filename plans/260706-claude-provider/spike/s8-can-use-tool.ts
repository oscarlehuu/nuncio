// S8 — canUseTool round-trip.
// permissionMode 'default'; callback logs the full options payload, delays 4s, then
// ALLOWS the first gated call and DENIES the second. Confirms: tool blocks until callback
// resolves, title/displayName/decisionReason/suggestions populated, deny → clean tool
// error (not a crashed turn).
//
// IMPORTANT finding baked into this test: `echo`-class Bash commands are auto-classified
// safe and BYPASS canUseTool even in 'default' mode, so they can't demonstrate gating.
// We use Write to a path OUTSIDE the cwd — that reliably triggers a permission request.
// Also: never put a tool name bare in `allowedTools` — it auto-approves and SHADOWS the
// callback (SDK warns CLAUDE_SDK_CAN_USE_TOOL_SHADOWED).
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg, trim } from "./spike-common.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let call = 0;

const canUseTool: CanUseTool = async (toolName, input, options) => {
  call++;
  const t0 = Date.now();
  console.log(`\n[S8] canUseTool call #${call} tool=${toolName}`);
  console.log("[S8]   input:", trim(input, 200));
  console.log("[S8]   options.title:", JSON.stringify(options.title));
  console.log("[S8]   options.displayName:", JSON.stringify(options.displayName));
  console.log("[S8]   options.description:", JSON.stringify((options as any).description));
  console.log("[S8]   options.decisionReason:", JSON.stringify(options.decisionReason));
  console.log("[S8]   options.blockedPath:", JSON.stringify((options as any).blockedPath));
  console.log("[S8]   options.suggestions:", trim(options.suggestions ?? null, 400));
  console.log("[S8]   options.toolUseID:", options.toolUseID, "requestId:", options.requestId);
  console.log("[S8]   options.signal aborted?", options.signal.aborted);
  await sleep(4000); // deliberate delay — prove the tool blocks on the callback
  console.log(`[S8]   callback resolving after ${Date.now() - t0}ms`);
  if (call === 1) return { behavior: "allow", updatedInput: input };
  return { behavior: "deny", message: "spike: denied by nuncio approval policy" };
};

const q = new MessageQueue();
// Two Writes to /tmp paths that are OUTSIDE the session cwd -> both require permission.
q.push(userMsg(
  "Using the Write tool, create /tmp/nuncio-claude-spike/s8-allow.txt with the text ALLOWED. " +
  "Then, using the Write tool, create /tmp/nuncio-claude-spike/s8-deny.txt with the text DENIED. " +
  "Do them one at a time. Report whether each write succeeded.",
));

const handle = query({
  prompt: q,
  options: {
    cwd: WS1,
    model: HAIKU,
    maxTurns: 8,
    permissionMode: "default",
    canUseTool,
    settingSources: [],
  },
});

for await (const msg of handle) {
  if (msg.type === "system" && msg.subtype === "permission_denied") {
    console.log("[S8] system/permission_denied event:", trim(msg, 300));
  } else if (msg.type === "user") {
    const content = (msg as any).message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === "tool_result") {
          console.log("[S8] tool_result is_error:", b.is_error, "content:", trim(b.content, 200));
        }
      }
    }
  } else if (msg.type === "result") {
    console.log("\n[S8] result subtype:", msg.subtype, "is_error:", (msg as any).is_error);
    console.log("[S8] permission_denials:", trim((msg as any).permission_denials, 300));
    console.log("[S8] final text:", JSON.stringify((msg as any).result ?? (msg as any).errors));
    q.close();
    break;
  }
}
process.exit(0);
