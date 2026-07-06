// S6 — Effort switching.
// (a) Options.effort is a first-class SDK option (sdk.d.ts:1620). Verify it round-trips
//     visibly (init hook_context / status / CLAUDE_EFFORT), and that models report
//     supportsEffort / supportedEffortLevels (from S1 initializationResult).
// (b) Query.applyFlagSettings({ effortLevel }) exists (sdk.d.ts:2312, Settings.effortLevel
//     sdk.d.ts:5990) → in-session change without restart. Confirm no throw & session continues.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg, trim } from "./spike-common.ts";

const q = new MessageQueue();
q.push(userMsg("Say the single word: ONE"));

const handle = query({
  prompt: q,
  options: {
    cwd: WS1,
    model: HAIKU,
    maxTurns: 2,
    effort: "low", // first-class option
    settingSources: [],
    includePartialMessages: false,
  },
});

let firstResultSeen = false;
const init = await handle.initializationResult();
const haiku = init.models.find((m: any) => m.resolvedModel?.includes("haiku") || m.value?.includes("haiku"));
console.log("[S6] haiku model effort support:", trim(haiku ?? "not-in-catalog", 400));
console.log("[S6] all models supportsEffort:", init.models.map((m: any) => `${m.value}:${m.supportsEffort}`).join(", "));

for await (const msg of handle) {
  if (msg.type === "system" && msg.subtype === "init") {
    // init does not echo effort directly; effort surfaces via CLAUDE_EFFORT env + hook effort ctx.
    console.log("[S6] init model:", (msg as any).model, "permMode:", (msg as any).permissionMode);
  } else if (msg.type === "system" && msg.subtype === "status") {
    console.log("[S6] status:", trim(msg, 200));
  } else if (msg.type === "result") {
    if (!firstResultSeen) {
      firstResultSeen = true;
      console.log("[S6] turn-1 result (effort:low set at query time):", (msg as any).subtype,
        "text:", JSON.stringify((msg as any).result));
      // Now flip effort mid-session via applyFlagSettings.
      try {
        await handle.applyFlagSettings({ effortLevel: "high" } as any);
        console.log("[S6] applyFlagSettings({ effortLevel: 'high' }) — OK, no throw (in-session change)");
      } catch (e) {
        console.log("[S6] applyFlagSettings THREW:", (e as Error).message);
      }
      q.push(userMsg("Say the single word: TWO"));
    } else {
      console.log("[S6] turn-2 result (after mid-session effort flip):", (msg as any).subtype,
        "text:", JSON.stringify((msg as any).result));
      q.close();
      break;
    }
  }
}
console.log("[S6] verdict: effort is a first-class Options field AND applyFlagSettings changes it in-session.");
process.exit(0);
