// The Cloudflare hub pushes {"$status": …} to clients that ask for ?v=2; the primary's own server must too, or a client
// served straight from it (the phone on tailscale, an app pointed at :8787) would only see a card open or close when it
// reconnects — and the badge counts that dashboard.
import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { P, writeDoc } from "../src/core";
import type { Cfg } from "../src/core";
import { appendEvent, startServer } from "../src/server";

type Frame = Record<string, any>;

/** A socket that keeps every frame, so a test can wait for the one it wants without racing the 5 s push. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  ws.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error(`cannot open ${url}`));
  });
  return {
    ws,
    frames,
    wait: async (ok: (f: Frame) => boolean) => {
      for (let i = 0; i < 80; i++) {
        const f = frames.find(ok);
        if (f) return f;
        await Bun.sleep(100);
      }
      throw new Error(`no matching frame; got ${JSON.stringify(frames)}`);
    },
  };
}

const start = () => startServer({ server: { host: "127.0.0.1", port: 0, token: "test" } } as Cfg, async () => {})!;

test("a v=2 client is pushed the dashboard; a plain client only gets the feed", async () => {
  const server = start();
  const base = `ws://127.0.0.1:${server.port}/api/stream?token=test`;
  const watching = await connect(`${base}&v=2`);
  const plain = await connect(base);
  try {
    const first = await watching.wait((f) => !!f.$status);
    expect(Array.isArray(first.$status.decisions)).toBe(true);
    const ev = appendEvent({ from: "hub@test", kind: "notice", text: "dashboard push test" });
    expect((await plain.wait((f) => f.id === ev.id)).text).toBe("dashboard push test");
    expect((await watching.wait((f) => f.id === ev.id)).id).toBe(ev.id);
    expect(plain.frames.some((f) => f.$status)).toBe(false);
  } finally {
    watching.ws.close();
    plain.ws.close();
    server.stop(true);
  }
});

test("a card opening reaches a watching client without a reconnect", async () => {
  const server = start();
  const watching = await connect(`ws://127.0.0.1:${server.port}/api/stream?v=2&token=test`);
  try {
    await watching.wait((f) => !!f.$status);
    writeDoc(P("decisions", "open", "D-4242.md"), { id: "D-4242", kind: "decision", question: "Ship it?", created: "2026-01-01T00:00:00.000Z" }, "");
    const pushed = await watching.wait((f) => f.$status?.decisions?.some((d: Frame) => d.id === "D-4242"));
    expect(pushed.$status.decisions.find((d: Frame) => d.id === "D-4242")).toMatchObject({ held: false });
  } finally {
    unlinkSync(P("decisions", "open", "D-4242.md"));
    watching.ws.close();
    server.stop(true);
  }
}, 15_000); // one 5 s push interval has to pass
