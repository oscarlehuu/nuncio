// S4 — Resume across process restart.
// Turn 1 in process A persists session_id to a file. Process B (a fresh `bun run`) calls
// query({ resume: sessionId, cwd: SAME }) and asks "what did I ask before?" — context must
// be intact. A third mode uses a WRONG cwd to capture the exact resume error (drives the
// "cannot resume" UX).
//
// Usage:
//   bun run s4-resume.ts turn1        # process A, writes sessionId
//   bun run s4-resume.ts turn2        # process B, resumes with correct cwd
//   bun run s4-resume.ts wrongcwd     # process C, resumes with wrong cwd -> capture error
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, WS3, MessageQueue, userMsg } from "./spike-common.ts";
import { writeFileSync, readFileSync } from "node:fs";

const SID_FILE = "/tmp/nuncio-claude-spike/s4-session-id.txt";
const mode = process.argv[2];

async function turn1() {
  const q = new MessageQueue();
  q.push(userMsg("Remember this magic phrase for later: BANANA-BOAT-42. Just acknowledge with OK."));
  const h = query({ prompt: q, options: { cwd: WS1, model: HAIKU, maxTurns: 1, settingSources: [] } });
  let sid = "";
  for await (const m of h) {
    if (m.type === "system" && m.subtype === "init") sid = (m as any).session_id;
    if (m.type === "result") {
      console.log("[S4:turn1] session_id:", sid, "reply:", JSON.stringify((m as any).result));
      writeFileSync(SID_FILE, sid);
      q.close(); break;
    }
  }
  process.exit(0);
}

async function turn2(cwd: string, tag: string) {
  const sid = readFileSync(SID_FILE, "utf8").trim();
  console.log(`[S4:${tag}] resuming session_id=${sid} cwd=${cwd}`);
  const q = new MessageQueue();
  q.push(userMsg("What magic phrase did I ask you to remember? Reply with just the phrase."));
  try {
    const h = query({ prompt: q, options: { cwd, model: HAIKU, maxTurns: 1, resume: sid, settingSources: [] } });
    for await (const m of h) {
      if (m.type === "result") {
        console.log(`[S4:${tag}] subtype=${m.subtype} reply=${JSON.stringify((m as any).result ?? (m as any).errors)}`);
        const ok = JSON.stringify((m as any).result ?? "").includes("BANANA-BOAT-42");
        console.log(`[S4:${tag}] context retained? ${ok ? "YES" : "NO"}`);
        q.close(); break;
      }
    }
  } catch (e) {
    console.log(`[S4:${tag}] RESUME THREW: ${(e as Error).name}: ${(e as Error).message}`);
  }
  process.exit(0);
}

if (mode === "turn1") await turn1();
else if (mode === "turn2") await turn2(WS1, "turn2");        // correct cwd
else if (mode === "wrongcwd") await turn2(WS3, "wrongcwd");  // different cwd
else { console.log("usage: bun run s4-resume.ts turn1|turn2|wrongcwd"); process.exit(1); }
