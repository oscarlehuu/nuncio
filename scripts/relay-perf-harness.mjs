/**
 * Relay performance harness — machine-as-cloud baseline.
 *
 * Boots the REAL session module graph (SQLite + SessionsService + a simulated
 * streaming provider) and the REAL WS relay over loopback, then measures what a
 * phone/remote client actually feels: time-to-first-delta (WS push vs REST
 * bootstrap), delta throughput + end-to-end latency percentiles under N
 * concurrent streaming sessions, relay CPU/memory during fan-out, and on-the-wire
 * payload sizes (how many bytes per delta are envelope vs content).
 *
 * Run from the server workspace so bun picks up its decorator tsconfig:
 *   bun run perf:relay            # from repo root (wraps the cwd)
 *   bun run perf:relay -- --write # also (re)write docs/relay-performance-baseline.md
 *
 * In-process over loopback: numbers are relay + serialization overhead only —
 * real networks add RTT per hop on top. That is the point: this isolates what the
 * relay itself costs so a future ratchet has a stable, machine-noted reference.
 */
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bootRelayHarness } from '../apps/server/test/helpers/relay-harness.ts';
import { printReport, renderDoc } from './relay-perf-report.mjs';

const CONCURRENCIES = (argFlag('--n') ?? '1,5,20').split(',').map((s) => Number(s.trim()));
const ROUNDS = Number(argFlag('--rounds') ?? '6');
const TRIALS = Number(argFlag('--trials') ?? '12');
const WRITE = process.argv.includes('--write');

function argFlag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);
const round2 = (n) => Math.round(n * 100) / 100;

/** A measuring WS client: records every pushed frame's bytes + receive time. */
function measuringClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let rpcId = 1;
    const frames = [];
    const client = {
      subscribe: (sessionId, since = 0) =>
        ws.send(JSON.stringify({ id: rpcId++, method: 'subscribe', params: { sessionId, since } })),
      frames,
      firstDeltaAt: null,
      close: () => new Promise((res) => (ws.onclose = () => res(), ws.close())),
    };
    ws.addEventListener('message', (e) => {
      const raw = String(e.data);
      const recvAt = performance.now();
      const msg = JSON.parse(raw);
      if ('channel' in msg && msg.event) {
        frames.push({ wire: bytes(raw), recvAt, event: msg.event });
        if (client.firstDeltaAt === null && msg.event.type === 'assistant_delta') client.firstDeltaAt = recvAt;
      }
    });
    ws.addEventListener('open', () => resolve(client));
    ws.addEventListener('error', () => reject(new Error('perf client connect failed')));
  });
}

async function measureTtfd(harness) {
  const wsSamples = [];
  const restSamples = [];
  for (let i = 0; i < TRIALS; i += 1) {
    const session = await harness.service.create({ prompt: `ttfd ${i}`, provider: 'cursor' });
    await harness.service.awaitRun(session.id);
    // WS push: time from turn start to the first delta arriving on the socket.
    const client = await measuringClient(harness.wsUrl);
    client.subscribe(session.id, harness.service.getEvents(session.id, 0).length);
    const t0 = performance.now();
    const steer = harness.service.steer(session.id, `push ${i}`);
    while (client.firstDeltaAt === null) await sleep(2);
    wsSamples.push(client.firstDeltaAt - t0);
    await steer;
    await client.close();
    // REST bootstrap: cost of the getEvents catch-up a reconnecting client pays.
    const r0 = performance.now();
    harness.service.getEvents(session.id, 0);
    restSamples.push(performance.now() - r0);
  }
  wsSamples.sort((a, b) => a - b);
  restSamples.sort((a, b) => a - b);
  return {
    wsFirstDeltaMs: { p50: round2(pct(wsSamples, 50)), p90: round2(pct(wsSamples, 90)) },
    restBootstrapMs: { p50: round2(pct(restSamples, 50)), p90: round2(pct(restSamples, 90)) },
  };
}

async function measureFanout(n) {
  const harness = await bootRelayHarness();
  try {
    const sessions = await Promise.all(
      Array.from({ length: n }, (_, i) => harness.service.create({ prompt: `sess ${i}`, provider: 'cursor' })),
    );
    await Promise.all(sessions.map((s) => harness.service.awaitRun(s.id)));
    const clients = await Promise.all(sessions.map(() => measuringClient(harness.wsUrl)));
    clients.forEach((c, i) => c.subscribe(sessions[i].id, harness.service.getEvents(sessions[i].id, 0).length));
    await sleep(50);

    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    for (let r = 0; r < ROUNDS; r += 1) {
      await Promise.all(sessions.map((s) => harness.service.steer(s.id, `round ${r}`)));
    }
    const wallMs = performance.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    await sleep(150); // let the tail flush to every socket
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const rssMb = process.memoryUsage().rss / (1024 * 1024);

    const latencies = [];
    let events = 0;
    let wireTotal = 0;
    const deltaWire = [];
    const deltaContent = [];
    for (const c of clients) {
      for (const f of c.frames) {
        events += 1;
        wireTotal += f.wire;
        latencies.push(f.recvAt - (f.event.createdAt - perfEpoch()));
        if (f.event.type === 'assistant_delta') {
          deltaWire.push(f.wire);
          deltaContent.push(bytes(String(f.event.payload?.delta ?? '')));
        }
      }
    }
    latencies.sort((a, b) => a - b);
    await Promise.all(clients.map((c) => c.close()));

    const avgDeltaWire = deltaWire.length ? deltaWire.reduce((a, b) => a + b, 0) / deltaWire.length : 0;
    const avgDeltaContent = deltaContent.length ? deltaContent.reduce((a, b) => a + b, 0) / deltaContent.length : 0;
    return {
      n,
      events,
      throughputPerSec: round2(events / (wallMs / 1000)),
      latencyMs: { p50: round2(pct(latencies, 50)), p90: round2(pct(latencies, 90)), p99: round2(pct(latencies, 99)) },
      cpuMs: round2(cpuMs),
      cpuPct: round2((cpuMs / wallMs) * 100),
      rssMb: round2(rssMb),
      avgFrameBytes: round2(events ? wireTotal / events : 0),
      avgDeltaFrameBytes: round2(avgDeltaWire),
      avgDeltaContentBytes: round2(avgDeltaContent),
      deltaEnvelopeOverheadBytes: round2(avgDeltaWire - avgDeltaContent),
    };
  } finally {
    await harness.close();
  }
}

// Date.now() and performance.now() share no epoch; align event.createdAt (Date.now
// based) to the performance clock so latency = receive - emit is comparable.
let _perfEpoch = null;
function perfEpoch() {
  if (_perfEpoch === null) _perfEpoch = Date.now() - performance.now();
  return _perfEpoch;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  perfEpoch();
  const ttfdHarness = await bootRelayHarness();
  let ttfd;
  try {
    ttfd = await measureTtfd(ttfdHarness);
  } finally {
    await ttfdHarness.close();
  }
  const fanout = [];
  for (const n of CONCURRENCIES) fanout.push(await measureFanout(n));

  const machine = {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    memGb: round2(os.totalmem() / 1024 ** 3),
    platform: `${process.platform}/${process.arch}`,
    runtime: `bun ${process.versions.bun}`,
    date: new Date().toISOString().slice(0, 10),
  };

  printReport(machine, ttfd, fanout);
  if (WRITE) {
    const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'relay-performance-baseline.md');
    writeFileSync(out, renderDoc(machine, ttfd, fanout, ROUNDS));
    console.log(`\nwrote ${out}`);
  }
  process.exit(0);
}

main();
