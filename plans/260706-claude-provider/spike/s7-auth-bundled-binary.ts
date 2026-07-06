// S7 — Auth probe via the SDK-bundled CLI binary (no ANTHROPIC_API_KEY set).
// Locate the platform optionalDependency binary and run `auth status`, then
// compare to the system `claude auth status`. Rides the machine's Max keychain login.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function redact(json: string): string {
  return json
    .replace(/"orgId"\s*:\s*"[^"]*"/g, '"orgId":"<redacted-uuid>"')
    .replace(/"orgName"\s*:\s*"[^"]*"/g, '"orgName":"<redacted>"')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>");
}

// Resolve the bundled binary the same way the SDK would: platform optionalDependency.
const plat = `${process.platform}-${process.arch}`; // e.g. darwin-arm64
const pkg = `@anthropic-ai/claude-agent-sdk-${plat}`;
let bundled: string | null = null;
try {
  // The platform package ships the raw `claude` executable at its root.
  const pkgRoot = require.resolve(`${pkg}/package.json`).replace(/package\.json$/, "");
  const candidate = pkgRoot + "claude";
  if (existsSync(candidate)) bundled = candidate;
} catch (e) {
  console.log(`[S7] could not resolve ${pkg}: ${(e as Error).message}`);
}

console.log(`[S7] platform=${plat} bundledBinary=${bundled ?? "NOT FOUND"}`);
console.log(`[S7] ANTHROPIC_API_KEY set? ${process.env.ANTHROPIC_API_KEY ? "YES" : "no"}`);

function authStatus(bin: string): { code: number | null; out: string } {
  // Strip auth env so we prove keychain ride, not env-key fallback.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const r = spawnSync(bin, ["auth", "status", "--output-format", "json"], {
    env,
    encoding: "utf8",
  });
  // Some CLI versions don't accept --output-format on auth status; retry plain.
  if (r.status !== 0 || !r.stdout.trim().startsWith("{")) {
    const r2 = spawnSync(bin, ["auth", "status"], { env, encoding: "utf8" });
    return { code: r2.status, out: (r2.stdout || r2.stderr || "").trim() };
  }
  return { code: r.status, out: (r.stdout || r.stderr || "").trim() };
}

if (bundled) {
  const b = authStatus(bundled);
  console.log(`\n[S7] BUNDLED binary auth status (exit ${b.code}):`);
  console.log(redact(b.out));
}

const sysR = spawnSync("claude", ["auth", "status"], { encoding: "utf8" });
console.log(`\n[S7] SYSTEM claude auth status (exit ${sysR.status}):`);
console.log(redact((sysR.stdout || sysR.stderr || "").trim()));
