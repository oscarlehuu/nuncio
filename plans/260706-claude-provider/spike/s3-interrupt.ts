// S3 — Interrupt.
// Start a long tool-heavy turn (sleep 2 five times via Bash), call query.interrupt()
// mid-turn, and observe: which SDK message shapes the interrupt (result subtype /
// stop_reason), that the stream ends cleanly, the process survives, and a follow-up
// message on the SAME query still works.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg, trim } from "./spike-common.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = new MessageQueue();
q.push(userMsg(
  "Run `sleep 2` via Bash five times, one at a time (five separate Bash calls). " +
  "Narrate each one before you run it.",
));

const handle = query({
  prompt: q,
  options: {
    cwd: WS1,
    model: HAIKU,
    maxTurns: 12,
    permissionMode: "bypassPermissions", // let the sleeps run without prompts
    settingSources: [],
  },
});

let interrupted = false;
let toolStarts = 0;
let resultCount = 0;

// Fire interrupt shortly after the second Bash tool_use appears.
async function watchAndInterrupt() {
  // guarded by the loop below via toolStarts; this is a fallback timer.
  await sleep(6000);
  if (!interrupted) {
    interrupted = true;
    console.log("[S3] >>> calling handle.interrupt() (timer)");
    await handle.interrupt().then(() => console.log("[S3] interrupt() resolved"))
      .catch((e) => console.log("[S3] interrupt() rejected:", (e as Error).message));
  }
}
watchAndInterrupt();

for await (const msg of handle) {
  if (msg.type === "assistant") {
    const blocks = (msg as any).message?.content ?? [];
    for (const b of blocks) {
      if (b.type === "tool_use") {
        toolStarts++;
        console.log(`[S3] tool_use #${toolStarts}: ${b.name} ${trim(b.input, 80)}`);
        if (toolStarts === 2 && !interrupted) {
          interrupted = true;
          console.log("[S3] >>> calling handle.interrupt() (after 2nd tool_use)");
          handle.interrupt().then(() => console.log("[S3] interrupt() resolved"))
            .catch((e) => console.log("[S3] interrupt() rejected:", (e as Error).message));
        }
      }
    }
  } else if (msg.type === "result") {
    resultCount++;
    console.log(`[S3] result #${resultCount} subtype=${msg.subtype} stop_reason=${JSON.stringify((msg as any).stop_reason)} terminal_reason=${JSON.stringify((msg as any).terminal_reason)} num_turns=${(msg as any).num_turns}`);
    console.log("[S3]   text:", JSON.stringify((msg as any).result ?? (msg as any).errors));
    if (resultCount === 1) {
      // Prove the SAME query still works after interrupt: send a follow-up.
      console.log("[S3] >>> sending follow-up on the same query after interrupt");
      q.push(userMsg("Are you still there? Reply with just: YES"));
    } else {
      q.close();
      break;
    }
  }
}
console.log("[S3] done. interrupted:", interrupted, "process alive:", true);
process.exit(0);
