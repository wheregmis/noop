// MCP end to end against the real Worker under `wrangler dev` (no SMTP: the login code comes from /api/host/login-code).
//   cd cloud && bunx wrangler dev --port 8799 --var HUB_TOKEN:machinetok
//   BASE=http://localhost:8799 TOKEN=machinetok bun test/cloud-auth/mcp-e2e.ts
// Walks the path a claude.ai / ChatGPT connector takes: 401 → metadata → DCR → sign-in page → PKCE token → MCP session,
// then checks tools and that a fleet event reaches the client as an MCP notification over the SSE stream.
import { pkceChallenge } from "../../cloud/src/mcp";
const BASE = process.env.BASE ?? "http://localhost:8799", TOKEN = process.env.TOKEN ?? "machinetok";
let fail = 0;
const ok = (c: unknown, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fail++; };
const M = { authorization: `Bearer ${TOKEN}` };

// 1. discovery
let r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const wa = r.headers.get("www-authenticate") ?? "";
ok(r.status === 401 && wa.includes("resource_metadata="), `401 + WWW-Authenticate: ${wa}`);
const prm = await (await fetch(wa.match(/resource_metadata="([^"]+)"/)![1])).json() as any;
const asm = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json() as any;
ok(asm.registration_endpoint && asm.code_challenge_methods_supported.includes("S256"), "authorization server metadata");
ok((await fetch(`${BASE}/mcp`, { method: "OPTIONS" })).headers.get("access-control-allow-origin") === "*", "CORS preflight");

// 2. dynamic client registration
const redirect = "http://localhost:6274/oauth/callback";
const client = await (await fetch(asm.registration_endpoint, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "e2e", redirect_uris: [redirect], token_endpoint_auth_method: "none" }) })).json() as any;
ok(client.client_id, `registered ${client.client_id}`);

// 3. authorize: email → code (CLI delivery) → redirect with code
const verifier = crypto.randomUUID() + crypto.randomUUID();
const q = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, state: "xyz",
  code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", scope: "noop", resource: prm.resource });
ok((await (await fetch(`${asm.authorization_endpoint}?${q}`)).text()).includes("Send code"), "sign-in page");
const step = (b: Record<string, string>) => fetch(`${asm.authorization_endpoint}?${q}`, { method: "POST", body: new URLSearchParams(b), redirect: "manual" });
const sent = await (await step({ step: "send", email: "owner@example.com" })).text();
ok(sent.includes("noop login"), "code page (code shown by `noop login`)");
const { code: emailCode } = await (await fetch(`${BASE}/api/host/login-code`, { headers: M })).json() as any;
r = await step({ step: "verify", email: "owner@example.com", code: emailCode });
const loc = new URL(r.headers.get("location") ?? "http://x/");
ok(r.status === 302 && loc.searchParams.get("state") === "xyz" && loc.searchParams.get("code"), `302 → ${loc.origin}${loc.pathname}`);

// 4. token
const tok = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code: loc.searchParams.get("code")!, client_id: client.client_id, code_verifier: verifier, redirect_uri: redirect }) })).json() as any;
ok(tok.access_token && tok.refresh_token, "access + refresh token");
const A = { authorization: `Bearer ${tok.access_token}` };
ok((await fetch(`${BASE}/api/status`, { headers: A })).status === 200, "access token is an owner session");

// 5. MCP session
let id = 0, sid = "";
const call = async (method: string, params: unknown = {}) => {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...A, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  sid ||= res.headers.get("mcp-session-id") ?? "";
  if (res.headers.get("content-type") === "text/event-stream") // streamed tools/call: the response is the message with our id
    return (await res.text()).split("\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6))).find((m) => m.id === id);
  return (await res.json() as any);
};
const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
ok(init.result?.serverInfo?.name === "noop" && sid, `initialize (session ${sid.slice(0, 8)}…)`);
await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...A, "content-type": "application/json", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
const tools = (await call("tools/list")).result.tools.map((t: any) => t.name);
ok(tools.length === 11 && tools.includes("search") && tools.includes("fetch"), `tools/list: ${tools.join(", ")}`);
const tool = async (name: string, args = {}) => { const x = await call("tools/call", { name, arguments: args }); return x.result.isError ? x.result : JSON.parse(x.result.content[0].text); };
ok((await tool("get_status")).hub, "get_status");
const { cursor } = await tool("get_feed", { limit: 5 });
ok(typeof cursor === "number", `get_feed cursor ${cursor}`);
await call("resources/subscribe", { uri: "noop://tasks/T-9001" });

// 6. notifications over SSE
const ctl = new AbortController();
const stream = await fetch(`${BASE}/mcp`, { headers: { ...A, accept: "text/event-stream", "mcp-session-id": sid }, signal: ctl.signal });
ok(stream.headers.get("content-type") === "text/event-stream", "GET /mcp opens an SSE stream");
const reader = stream.body!.getReader(), dec = new TextDecoder();
await new Promise((res) => setTimeout(res, 300));
const marker = `e2e ${Date.now()}`;
await fetch(`${BASE}/api/events`, { method: "POST", headers: { ...M, "content-type": "application/json" }, body: JSON.stringify({ from: "lead@e2e", kind: "result", text: `T-9001 ${marker}`, ref: "T-9001" }) });
let buf = "";
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !(buf.includes(marker) && buf.includes("resources/updated"))) buf += dec.decode((await reader.read()).value);
const notes = buf.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
ok(notes.some((n) => n.method === "notifications/message" && n.params.data.text.includes(marker)), "fleet event → notifications/message");
ok(notes.some((n) => n.method === "notifications/resources/updated" && n.params.uri === "noop://tasks/T-9001"), "subscribed task → resources/updated");
ctl.abort();

// 7. fallback polling + an owner-level write
const waited = await tool("wait_for_events", { cursor, timeout_seconds: 2 });
ok(waited.events.some((e: any) => String(e.text).includes(marker)), "wait_for_events sees the event");
const sentMsg = await tool("send_message", { text: `mcp e2e ${marker}` });
const feed = await (await fetch(`${BASE}/api/feed?since=`, { headers: M })).json() as any;
ok(sentMsg.ok && feed.events.some((e: any) => e.kind === "owner" && e.text === `mcp e2e ${marker}`), "send_message → owner message in the feed");
const inbox = await (await fetch(`${BASE}/api/host/inbox?after=0`, { headers: M })).json() as any;
ok(inbox.items.some((i: any) => i.event?.text === `mcp e2e ${marker}`), "…and in the fleet inbox");

// 8. spec details
const H = (h: Record<string, string> = {}) => ({ ...A, "content-type": "application/json", "mcp-protocol-version": "2025-06-18", "mcp-session-id": sid, ...h });
const ping = (h: Record<string, string>) => fetch(`${BASE}/mcp`, { method: "POST", headers: { ...A, "content-type": "application/json", ...h }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
ok((await ping({})).status === 400, "no Mcp-Session-Id → 400");
ok((await ping({ "mcp-session-id": "0".repeat(32) })).status === 404, "unknown session → 404");
ok((await ping({ "mcp-session-id": sid, "mcp-protocol-version": "1999-01-01" })).status === 400, "bad MCP-Protocol-Version → 400");

/** Reads SSE frames from a response until `until` holds or `ms` passes. */
async function readFrames(res: Response, until: (f: any[]) => boolean, ms = 8000) {
  const rd = res.body!.getReader(), d = new TextDecoder(), end = Date.now() + ms;
  let b = "";
  const parse = () => b.split("\n\n").slice(0, -1).map((blk) => {
    const f: any = {};
    for (const l of blk.split("\n")) { if (l.startsWith("id: ")) f.id = l.slice(4); if (l.startsWith("retry: ")) f.retry = l.slice(7); if (l.startsWith("data: {")) f.data = JSON.parse(l.slice(6)); }
    return f;
  });
  while (Date.now() < end && !until(parse())) {
    const x = await Promise.race([rd.read(), new Promise<null>((r) => setTimeout(() => r(null), Math.max(1, end - Date.now())))]);
    if (!x || x.done) break;
    b += d.decode(x.value);
  }
  rd.cancel().catch(() => {});
  return parse();
}
const emit = (text: string, ref = "T-9001") => fetch(`${BASE}/api/events`, { method: "POST", headers: { ...M, "content-type": "application/json" }, body: JSON.stringify({ from: "lead@e2e", kind: "result", text, ref }) });

// 8a. resumability: ids on every message, then reconnect with Last-Event-ID after missing two events
const m1 = `replay-1 ${Date.now()}`;
const s1 = await fetch(`${BASE}/mcp`, { headers: { ...A, accept: "text/event-stream", "mcp-session-id": sid } });
const got1P = readFrames(s1, (f) => f.some((x) => x.data?.params?.data?.text === m1));
await new Promise((res) => setTimeout(res, 300));
await emit(m1);
const got1 = await got1P;
const f1 = got1.find((x) => x.data?.params?.data?.text === m1);
ok(got1[0]?.retry && f1?.id?.startsWith("g."), `SSE retry hint + event id ${f1?.id}`);
await new Promise((res) => setTimeout(res, 300));
const m2 = `replay-2 ${Date.now()}`, m3 = `replay-3 ${Date.now()}`;
await emit(m2); await emit(m3);
const got2 = await readFrames(await fetch(`${BASE}/mcp`, { headers: { ...A, accept: "text/event-stream", "mcp-session-id": sid, "last-event-id": f1.id } }),
  (f) => f.some((x) => x.data?.params?.data?.text === m3));
const texts = got2.filter((x) => x.data?.method === "notifications/message").map((x) => x.data.params.data.text);
ok(texts.includes(m2) && texts.includes(m3) && !texts.includes(m1), `Last-Event-ID ${f1.id} replays the 2 missed events only`);

// 8b. list_changed when a new open task appears (machine writes the task file, like the daemon does)
const s2 = await fetch(`${BASE}/mcp`, { headers: { ...A, accept: "text/event-stream", "mcp-session-id": sid } });
const lcP = readFrames(s2, (f) => f.some((x) => x.data?.method === "notifications/resources/list_changed"));
await new Promise((res) => setTimeout(res, 300));
const tid = `T-e2e${String(Date.now()).slice(-4)}`;
const content = btoa(`---\nid: ${tid}\ntitle: e2e list_changed\n---\nbody\n`);
const commit = await fetch(`${BASE}/api/files/commit`, { method: "POST", headers: { ...M, "content-type": "application/json" },
  body: JSON.stringify({ msg: "e2e", changes: [{ path: `tasks/active/${tid}.md`, base_version: 0, content }] }) });
ok(commit.ok, `machine commits tasks/active/${tid}.md (${commit.status})`);
ok((await lcP).some((x) => x.data?.method === "notifications/resources/list_changed"), "→ notifications/resources/list_changed");
const list = (await call("resources/list")).result.resources.map((x: any) => x.uri);
ok(list.includes(`noop://tasks/${tid}`), "resources/list has the new task");

// 8c. progress over a POST SSE response, then cancel
const wait = (rid: string, cur: number, secs: number) => fetch(`${BASE}/mcp`, { method: "POST", headers: H({ accept: "application/json, text/event-stream" }),
  body: JSON.stringify({ jsonrpc: "2.0", id: rid, method: "tools/call", params: { name: "wait_for_events", arguments: { cursor: cur, timeout_seconds: secs }, _meta: { progressToken: rid } } }) });
const { cursor: c2 } = await tool("get_feed", { limit: 1 });
const w1 = await wait("w1", c2, 8);
ok(w1.headers.get("content-type") === "text/event-stream", "wait_for_events with progressToken → SSE response");
const m4 = `progress ${Date.now()}`;
setTimeout(() => emit(m4), 6000);
const wf = await readFrames(w1, (f) => f.some((x) => x.data?.id === "w1"), 15000);
const prog = wf.filter((x) => x.data?.method === "notifications/progress");
const resp = wf.find((x) => x.data?.id === "w1");
ok(prog.length >= 2 && prog.every((x) => x.data.params.progressToken === "w1" && x.id), `${prog.length} notifications/progress with ids before the response`);
ok(resp && JSON.parse(resp.data.result.content[0].text).events.some((e: any) => e.text === m4), "…then the result with the new event");
const { cursor: c3 } = await tool("get_feed", { limit: 1 });
const t0 = Date.now();
const w2 = await wait("w2", c3 + 1_000_000, 40);
setTimeout(() => fetch(`${BASE}/mcp`, { method: "POST", headers: H(), body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "w2", reason: "e2e" } }) }), 500);
const cf = await readFrames(w2, () => false, 10000);
ok(Date.now() - t0 < 9000 && !cf.some((x) => x.data?.id === "w2"), `notifications/cancelled ends the wait in ${Date.now() - t0}ms with no response`);

// 8d. DELETE ends the session → 404
const old = sid;
ok((await fetch(`${BASE}/mcp`, { method: "DELETE", headers: H() })).status === 204 && (await ping({ "mcp-session-id": old })).status === 404, "DELETE → later requests 404");

// 9. refresh rotates and revokes the old access token
const t2 = await (await fetch(asm.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: client.client_id }) })).json() as any;
ok(t2.access_token && (await fetch(`${BASE}/api/status`, { headers: A })).status === 401, "refresh → new token, old one revoked");

console.log(fail ? `${fail} FAILED` : "ALL OK");
process.exit(fail ? 1 : 0);
