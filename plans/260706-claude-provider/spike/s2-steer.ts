// S2 — Mid-run steer (steerWhileRunning gate).
// While a long tool-heavy turn runs (five sequential `sleep 2` Bash calls), push a second
// user message mid-turn and observe when it takes effect:
//   - priority:'now'        -> does it interject/redirect the IN-FLIGHT turn?
//   - priority:'next'       -> queue until the current turn ends, then run as a fresh turn?
//   - shouldQuery:false     -> append to transcript WITHOUT triggering any turn?
// Each case is bounded: after the first result we wait up to `graceMs` for a possible
// second turn, then close the queue so nothing hangs.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg, trim } from "./spike-common.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(label: string, steer: (q: MessageQueue) => void) {
  console.log(`\n========== ${label} ==========`);
  const q = new MessageQueue();
  q.push(userMsg(
    "Run `sleep 2` via Bash five times, one at a time (five separate Bash calls). " +
    "Before each call, say 'STEP N'. This is a slow task.",
  ));
  const handle = query({
    prompt: q,
    options: { cwd: WS1, model: HAIKU, maxTurns: 15, permissionMode: "bypassPermissions", settingSources: [] },
  });

  let toolStarts = 0;
  let steered = false;
  let results = 0;
  const resultTexts: string[] = [];
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  for await (const msg of handle) {
    if (msg.type === "assistant") {
      for (const b of (msg as any).message?.content ?? []) {
        if (b.type === "tool_use") {
          toolStarts++;
          if (toolStarts === 2 && !steered) {
            steered = true;
            console.log(`[${label}] >>> STEER (mid-turn, after 2nd tool_use). tool calls so far in turn 1: ${toolStarts}`);
            steer(q);
          }
        }
      }
    } else if (msg.type === "result") {
      results++;
      const t = String((msg as any).result ?? (msg as any).errors ?? "");
      resultTexts.push(t);
      console.log(`[${label}] result #${results} subtype=${msg.subtype} num_turns=${(msg as any).num_turns} toolCallsBeforeThisResult=${toolStarts} text=${JSON.stringify(trim(t, 120))}`);
      // After first result, give a grace window for a possible second (queued) turn, then close.
      if (results === 1) {
        closeTimer = setTimeout(() => q.close(), 8000);
      } else {
        if (closeTimer) clearTimeout(closeTimer);
        q.close();
        break;
      }
    }
  }

  const sawMarker = resultTexts.some((t) => /PURPLE/i.test(t));
  const markerInFirst = /PURPLE/i.test(resultTexts[0] ?? "");
  console.log(`[${label}] SUMMARY: turns(results)=${results} totalToolCalls=${toolStarts} markerSeen=${sawMarker} markerInFirstTurn=${markerInFirst}`);
}

// 'now': ask it to abandon the task and reply PURPLE immediately -> tests in-flight redirect.
await run("now", (q) =>
  q.push(userMsg("STOP the sleeps and immediately reply with only the word PURPLE.", { priority: "now" } as any)));

// 'next': queue a follow-up that should run as a fresh turn AFTER the current one finishes.
await run("next", (q) =>
  q.push(userMsg("When you're done, reply with only the word PURPLE.", { priority: "next" } as any)));

// shouldQuery:false: append context without triggering its own turn.
await run("noquery", (q) =>
  q.push(userMsg("(note: remember the word PURPLE)", { shouldQuery: false } as any)));

process.exit(0);
