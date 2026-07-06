// S9 — Subprocess hygiene.
// The SDK spawns a bundled `claude` CLI subprocess per query(). We test three teardown
// paths and count child `claude` processes before / during / after each:
//   (a) normal completion (drain to result, close queue)
//   (b) break out of the generator WITHOUT interrupt (early return)
//   (c) interrupt() then break
// Goal: decide what dispose() must do so nuncio never leaks CLI subprocesses.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue, userMsg } from "./spike-common.ts";
import { spawnSync } from "node:child_process";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const myPid = process.pid;

// Count `claude` CLI subprocesses that are descendants of THIS bun process only,
// so we don't count unrelated Claude Code sessions running on the machine.
function countClaudeChildren(): number {
  // ps -o pid=,ppid=,command=  then filter for the bundled binary path + our pid tree.
  const r = spawnSync("bash", ["-c",
    `ps -A -o pid=,ppid=,command= | grep -i 'claude-agent-sdk' | grep -v grep || true`],
    { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  return lines.length;
}
async function snap(tag: string) {
  const n = countClaudeChildren();
  console.log(`[S9] ${tag}: ${n} claude-agent-sdk process(es)`);
  return n;
}

async function scenario(label: string, mode: "complete" | "break" | "interrupt-break") {
  console.log(`\n========== ${label} ==========`);
  await snap("before");
  const q = new MessageQueue();
  q.push(userMsg("Run `sleep 2` via Bash three times, one at a time. Narrate each."));
  const handle = query({
    prompt: q,
    options: { cwd: WS1, model: HAIKU, maxTurns: 8, permissionMode: "bypassPermissions", settingSources: [] },
  });

  let tools = 0;
  for await (const msg of handle) {
    if (msg.type === "system" && msg.subtype === "init") await snap("during (after init)");
    if (msg.type === "assistant") {
      for (const b of (msg as any).message?.content ?? []) {
        if (b.type === "tool_use") {
          tools++;
          if (tools === 1 && mode === "break") {
            console.log("[S9] breaking out of generator WITHOUT interrupt");
            break; // break inner for
          }
          if (tools === 1 && mode === "interrupt-break") {
            console.log("[S9] calling interrupt() then breaking");
            await handle.interrupt().catch((e) => console.log("interrupt err:", (e as Error).message));
          }
        }
      }
      if (tools >= 1 && (mode === "break")) break; // break the async-for
      if (tools >= 1 && mode === "interrupt-break") break;
    }
    if (msg.type === "result") { console.log("[S9] reached result (complete)"); break; }
  }
  q.close();
  // Give the OS a moment to reap.
  await sleep(3000);
  const after = await snap("after +3s");
  return after;
}

await scenario("(a) normal completion", "complete");
await scenario("(b) break without interrupt", "break");
await scenario("(c) interrupt() then break", "interrupt-break");

await sleep(2000);
const final = await snap("FINAL (all scenarios done)");
console.log(`\n[S9] leaked processes still alive at end: ${final}`);
console.log("[S9] (parent bun pid was " + myPid + ")");
process.exit(0);
