// S10 — settingSources blast radius.
// WS2 contains a CLAUDE.md with a distinctive marker ("Always end every reply with the
// word PINEAPPLE."). Run the SAME prompt twice:
//   (a) settingSources: []           -> CLAUDE.md must be IGNORED (no PINEAPPLE)
//   (b) settingSources: ['project']  -> CLAUDE.md must be OBEYED (PINEAPPLE present)
// This pins the v1 default (empty) and documents the founder toggle.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS2, MessageQueue, userMsg } from "./spike-common.ts";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";

async function run(label: string, settingSources: SettingSource[] | undefined) {
  const q = new MessageQueue();
  q.push(userMsg("Say hello in one short sentence."));
  const h = query({ prompt: q, options: { cwd: WS2, model: HAIKU, maxTurns: 1, settingSources } });
  for await (const m of h) {
    if (m.type === "result") {
      const text = String((m as any).result ?? "");
      const obeyed = /PINEAPPLE/i.test(text);
      console.log(`[S10] settingSources=${JSON.stringify(settingSources)} -> obeyed CLAUDE.md marker? ${obeyed ? "YES" : "no"}`);
      console.log(`[S10]   reply: ${JSON.stringify(text)}`);
      q.close(); break;
    }
  }
}

console.log("[S10] WS2 CLAUDE.md instructs: end every reply with PINEAPPLE");
await run("empty", []);            // v1 default — should NOT obey
await run("project", ["project"]); // toggle — should obey (needs 'project' to load CLAUDE.md)
process.exit(0);
