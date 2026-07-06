// S5 — Images. Send a base64 PNG image block in SDKUserMessage.message.content and
// confirm the model actually sees it. Validates capabilities.images: true against the
// MediaStore/attachments shape (base64 in → image block).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { HAIKU, WS1, MessageQueue } from "./spike-common.ts";
import { deflateSync } from "node:zlib";

// Build a minimal solid-red PNG (2x2) by hand so the test is fully self-contained.
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const body = new Uint8Array(t.length + data.length);
  body.set(t, 0); body.set(data, t.length);
  const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, data.length);
  const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, crc32(body));
  return new Uint8Array([...len, ...body, ...crc]);
}
function redPng(): string {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 2); dv.setUint32(4, 2); // 2x2
  ihdr[8] = 8; ihdr[9] = 2; // bit depth 8, color type 2 (truecolor RGB)
  // raw scanlines: each row = filter byte 0 + RGB per pixel (255,0,0)
  const row = new Uint8Array([0, 255, 0, 0, 255, 0, 0]); // filter + 2 red px
  const raw = new Uint8Array([...row, ...row]);
  const idat = deflateSync(Buffer.from(raw));
  const png = new Uint8Array([
    ...sig,
    ...chunk("IHDR", ihdr),
    ...chunk("IDAT", new Uint8Array(idat)),
    ...chunk("IEND", new Uint8Array(0)),
  ]);
  return Buffer.from(png).toString("base64");
}

const b64 = redPng();
console.log("[S5] generated 2x2 red PNG, base64 length:", b64.length);

const q = new MessageQueue();
q.push({
  type: "user",
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
      { type: "text", text: "What color is this image? Answer with just the color word." },
    ],
  },
} as any);

const handle = query({
  prompt: q,
  options: { cwd: WS1, model: HAIKU, maxTurns: 1, settingSources: [] },
});

for await (const msg of handle) {
  if (msg.type === "result") {
    console.log("[S5] result subtype:", msg.subtype, "is_error:", (msg as any).is_error);
    console.log("[S5] model answer:", JSON.stringify((msg as any).result ?? (msg as any).errors));
    q.close();
    break;
  }
}
process.exit(0);
