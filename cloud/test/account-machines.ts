// True two-process account flow against the isolated local Worker; all provider executables are fixtures.
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { encodeAccountSegment } from "../src/machine-requests";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8798");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Run only against an isolated local Worker");
const root = mkdtempSync(join(tmpdir(), "noop-two-account-machines-")), code = resolve(import.meta.dir, "../..");
const legacy = "ui-test-token", owner = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
const session = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)))].map((n) => n.toString(16).padStart(2, "0")).join("");
const observed: string[] = [];
const request = async (path: string, method = "GET", body?: unknown, token = owner) => {
  const response = await fetch(new URL(path, base), { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  return { status: response.status, data: await response.json() as any };
};
async function until(check: () => boolean | Promise<boolean>, message: string, ms = 20_000) {
  const end = Date.now() + ms;
  while (!await check()) { if (Date.now() > end) throw new Error(message); await Bun.sleep(100); }
}
async function command(host: string, method = "GET", suffix = "", body?: unknown) {
  const start = await request(`/api/machines/${host}/accounts${suffix}`, method, body);
  assert.equal(start.status, 202, JSON.stringify(start));
  let result = start;
  await until(async () => { result = await request(`/api/machine-requests/${start.data.ticket}`); return result.status !== 202; }, "Machine account command timed out");
  observed.push(JSON.stringify(result)); return result;
}
const tag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
type Machine = { host: string; dir: string; home: string; data: string; token: string; proc: ReturnType<typeof Bun.spawn>; output: Promise<string[]> };
const machines: Machine[] = [];
async function machine(label: string): Promise<Machine> {
  const host = `two-accounts-${label}-${tag}`, dir = join(root, label), home = join(dir, "home"), data = join(dir, "data"), bin = join(dir, "bin");
  for (const folder of [home, data, bin, join(home, "accounts")]) mkdirSync(folder, { recursive: true, mode: 0o700 });
  const joined = await request("/api/host/join", "POST", { host }); assert.equal(joined.status, 200);
  const token = joined.data.token;
  writeFileSync(join(home, "noop.toml"), `[cloud]\nurl = ${JSON.stringify(base.origin)}\n[server]\ntoken = ${JSON.stringify(token)}\n`, { mode: 0o600 });
  writeFileSync(join(home, "accounts/config.json"), JSON.stringify({ claude: [], codex: [], hermes: [] }), { mode: 0o600 });
  writeFileSync(join(data, "config.toml"), `[host]\nname = ${JSON.stringify(host)}\n[clis]\nenabled = ["claude", "codex"]\n[cloud]\npoll_seconds = 0.1\n`);
  const fixture = join(dir, "provider.ts");
  writeFileSync(fixture, `
    import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
    const args = process.argv.slice(2);
    if (args[0] === '--version') { console.log('fixture'); process.exit(0); }
    if (args[0] === 'setup-token') {
      console.log('https://claude.ai/oauth/authorize?state=fixture-${label}');
      let code = ''; for await (const chunk of Bun.stdin.stream()) { code += new TextDecoder().decode(chunk); if (/[\\r\\n]/.test(code)) break; }
      writeFileSync(${JSON.stringify(join(dir, "received-code"))}, code.trim());
      console.log('sk-ant-oat01-machine-${label}-fixture-token'); process.exit(0);
    }
    if (args[0] === 'login') {
      console.log('https://auth.openai.com/codex/device'); console.log('ABCD-EFGH');
      for (let n=0;n<3000;n++) { if (existsSync(${JSON.stringify(join(dir, "approve-codex"))})) {
        mkdirSync(process.env.CODEX_HOME!, {recursive:true}); writeFileSync(process.env.CODEX_HOME!+'/auth.json', JSON.stringify({token:'codex-machine-${label}-fixture-token'})); process.exit(0);
      } await Bun.sleep(10); } process.exit(1);
    }
    process.exit(99);
  `);
  for (const cli of ["claude", "codex", "hermes"]) writeFileSync(join(bin, cli), `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "script"), '#!/bin/sh\nif [ "$1" = "-qfec" ]; then exec /bin/sh -c "$2"; fi\nshift 2\nexec "$@"\n', { mode: 0o755 });
  const entry = join(dir, "bridge.ts");
  writeFileSync(entry, `
    import {loadConfig} from ${JSON.stringify(join(code, "src/core.ts"))};
    import {startMachineBridge} from ${JSON.stringify(join(code, "src/machine-bridge.ts"))};
    import {accounts,cancelLogin,hasPendingLogin,loginInfo} from ${JSON.stringify(join(code, "src/accounts.ts"))};
    import {writeFileSync} from 'node:fs';
    const originalFetch=globalThis.fetch;
    let failedResult='', uploadAttempts=0;
    globalThis.fetch=async(input,init)=>{
      const path=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).pathname;
      if(${label === "a"} && init?.method==='PUT' && /^\\/api\\/host\\/machine-requests\\//.test(path)){
        const result=JSON.parse(String(init.body));
        if(!failedResult && result.data?.accounts?.some((account)=>account.cli==='claude'&&account.name==='work')){
          failedResult=path; uploadAttempts++;
          writeFileSync(${JSON.stringify(join(dir, "result-upload.json"))},JSON.stringify({path:failedResult,attempts:uploadAttempts}));
          throw new Error('fixture result upload failed once');
        }
        if(path===failedResult){uploadAttempts++;writeFileSync(${JSON.stringify(join(dir, "result-upload.json"))},JSON.stringify({path:failedResult,attempts:uploadAttempts}));}
      }
      return originalFetch(input,init);
    };
    const stop=startMachineBridge(loadConfig());
    for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{
      stop(); const cfg=loadConfig();
      for(const cli of ['claude','codex','hermes']) for(const account of accounts(cfg,cli)) {const login=loginInfo(account);if(login&&hasPendingLogin(account))cancelLogin(account,login.id);}
      setTimeout(()=>process.exit(0),100);
    });
    console.log('fixture bridge ready');
  `);
  const proc = Bun.spawn([process.execPath, entry], { env: { PATH: bin, NOOP_HOME: home, HUB_DATA: data, HUB_CONF: join(home, "noop.toml"), HUB_HOST: host, HUB_SYNC: "local", TMPDIR: dir, LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const result = { host, dir, home, data, token, proc, output }; machines.push(result);
  await until(async () => { const ready = await request(`/api/machines/${host}/accounts`); return ready.status === 202; }, "Fixture bridge did not report account support");
  return result;
}
function treeText(dir: string): string {
  return readdirSync(dir, { withFileTypes: true }).map((entry) => entry.isDirectory() ? treeText(join(dir, entry.name)) : readFileSync(join(dir, entry.name), "utf8")).join("\n");
}
try {
  assert.equal((await request("/api/host/import", "POST", { table: "sessions", rows: [{ id: session, email: "account-machines@example.com", created: Date.now(), last_seen: Date.now(), ua: "two-account-machines-test" }] }, legacy)).status, 200);
  const [a, b] = await Promise.all([machine("a"), machine("b")]);
  const configA = readFileSync(join(a.data, "config.toml"), "utf8"), configB = readFileSync(join(b.data, "config.toml"), "utf8");
  assert.equal((await command(a.host, "POST", "", { cli: "claude", name: "work" })).status, 200);
  assert.equal(JSON.parse(readFileSync(join(a.dir, "result-upload.json"), "utf8")).attempts, 2, "The running request must retry its cached result after the first upload fails");
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, "accounts/config.json"), "utf8")).claude, ["work"]);
  assert.deepEqual(JSON.parse(readFileSync(join(b.home, "accounts/config.json"), "utf8")).claude, []);
  assert.equal((await command(a.host, "POST", "", { cli: "claude", name: "backup" })).status, 200);
  assert.equal((await command(a.host, "PUT", "", { cli: "claude", names: ["backup", "work"] })).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, "accounts/config.json"), "utf8")).claude, ["backup", "work"]);
  assert.deepEqual(JSON.parse(readFileSync(join(b.home, "accounts/config.json"), "utf8")).claude, []);
  assert.equal((await command(a.host, "PUT", "", { cli: "claude", names: ["work", "backup"] })).status, 200);
  assert.equal((await command(a.host, "DELETE", "/claude/backup")).status, 200);

  assert.equal((await command(a.host, "POST", "", { cli: "codex", name: "temporary" })).status, 200);
  assert.equal((await command(a.host, "DELETE", "/codex/temporary")).status, 200);
  const reset = await command(a.host, "PUT", "", { cli: "codex", names: null });
  assert.equal(reset.status, 200); assert(reset.data.accounts.some((account: any) => account.cli === "codex" && account.default));
  assert.equal(JSON.parse(readFileSync(join(a.home, "accounts/config.json"), "utf8")).codex, undefined);
  assert.equal((await command(a.host, "DELETE", "/codex/default")).status, 200);

  assert.deepEqual(JSON.parse(readFileSync(join(b.home, "accounts/config.json"), "utf8")), { claude: [], codex: [], hermes: [] });
  assert.equal((await command(b.host, "POST", "", { cli: "claude", name: "work" })).status, 200);
  assert.equal((await command(a.host, "POST", "/claude/work/login", {})).status, 200);
  assert.equal((await command(b.host, "POST", "/claude/work/login", {})).status, 200);
  let loginA: any, loginB: any;
  await until(async () => { loginA = (await command(a.host)).data.accounts.find((row: any) => row.cli === "claude").login; loginB = (await command(b.host)).data.accounts.find((row: any) => row.cli === "claude").login; return !!loginA?.url && !!loginB?.url; }, "Fixture OAuth URLs not received");
  assert.notEqual(loginA.id, loginB.id, "Pending login IDs must not collide across machines");
  assert.equal((await command(b.host, "PUT", "", { cli: "claude", names: null })).status, 409);
  assert.deepEqual(JSON.parse(readFileSync(join(b.home, "accounts/config.json"), "utf8")).claude, ["work"]);

  assert.equal((await command(b.host, "POST", "/claude/work/code", { id: loginA.id, code: "authorization-for-A" })).status, 409);
  assert(!existsSync(join(b.dir, "received-code")));
  assert.equal((await command(a.host, "POST", "/claude/work/code", { id: loginA.id, code: "authorization-for-A" })).status, 200);
  let completedA: any;
  await until(async () => { completedA = (await command(a.host)).data.accounts.find((row: any) => row.cli === "claude"); return completedA.login?.status === "complete"; }, "Fixture Claude sign-in did not complete");
  assert.equal(completedA.state, "ok"); assert.equal(completedA.login.url, undefined);
  assert.equal(readFileSync(join(a.dir, "received-code"), "utf8"), "authorization-for-A");
  assert(readFileSync(join(a.home, "accounts/state.json"), "utf8").includes("sk-ant-oat01-machine-a-fixture-token"));
  assert(!readFileSync(join(b.home, "accounts/state.json"), "utf8").includes("fixture-token"));
  const waitingB = (await command(b.host)).data.accounts.find((row: any) => row.cli === "claude"); assert.equal(waitingB.login.status, "waiting");
  assert.equal((await command(b.host, "POST", "/claude/work/cancel", { id: loginB.id })).status, 200);
  assert.equal((await command(b.host, "POST", "", { cli: "codex", name: "device" })).status, 200);
  assert.equal((await command(b.host, "POST", "/codex/device/login", {})).status, 200);
  let device: any;
  await until(async () => { device = (await command(b.host)).data.accounts.find((row: any) => row.cli === "codex"); return !!device.login?.user_code; }, "Fixture Codex challenge not received");
  assert.equal(device.login.user_code, "ABCD-EFGH"); assert.equal(device.login.needs_code, false);
  writeFileSync(join(b.dir, "approve-codex"), "fixture approved");
  await until(async () => (await command(b.host)).data.accounts.find((row: any) => row.cli === "codex").login?.status === "complete", "Fixture Codex sign-in did not complete");
  assert(readFileSync(join(b.home, "accounts/codex-device/auth.json"), "utf8").includes("codex-machine-b-fixture-token"));
  assert(!existsSync(join(a.home, "accounts/codex-device/auth.json")));
  assert.equal((await command(a.host, "DELETE", "/claude/work")).status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, "accounts/config.json"), "utf8")).claude, []);
  assert.deepEqual(JSON.parse(readFileSync(join(b.home, "accounts/config.json"), "utf8")).claude, ["work"]);
  assert(readFileSync(join(a.home, "accounts/state.json"), "utf8").includes("sk-ant-oat01-machine-a-fixture-token"));
  assert.equal(readFileSync(join(a.data, "config.toml"), "utf8"), configA); assert.equal(readFileSync(join(b.data, "config.toml"), "utf8"), configB);
  const legacyNames = ["Work account", "Personal/Office", "..", "~desk"];
  const legacyConfig = configB + legacyNames.map((name, index) => `\n[[accounts]]\ncli = "claude"\nname = ${JSON.stringify(name)}\ndir = ${JSON.stringify(join(b.home, "accounts", `legacy-${index}`))}\n`).join("");
  writeFileSync(join(b.data, "config.toml"), legacyConfig);
  const inherited = await command(b.host, "PUT", "", { cli: "claude", names: null });
  assert.equal(inherited.status, 200); assert.deepEqual(inherited.data.accounts.filter((account: any) => account.cli === "claude").map((account: any) => account.name), legacyNames);
  assert.equal((await command(b.host, "PUT", "", { cli: "claude", names: [...legacyNames].reverse() })).status, 200);
  for (const name of ["Work account", ".."]) {
    const login = await command(b.host, "POST", `/claude/${encodeAccountSegment(name)}/login`, {});
    assert.equal(login.status, 200, JSON.stringify(login));
    const pending = login.data.accounts.find((account: any) => account.cli === "claude" && account.name === name).login;
    assert.equal((await command(b.host, "POST", `/claude/${encodeAccountSegment(name)}/cancel`, { id: pending.id })).status, 200);
  }
  assert.equal((await command(b.host, "DELETE", `/claude/${encodeAccountSegment("Personal/Office")}`)).status, 200);
  assert.deepEqual((await command(b.host)).data.accounts.filter((account: any) => account.cli === "claude").map((account: any) => account.name), ["~desk", "..", "Work account"]);
  const feed = JSON.stringify((await request("/api/feed")).data), localData = treeText(a.data) + treeText(b.data), responses = observed.join("\n");
  for (const secret of ["sk-ant-oat01-machine-a-fixture-token", "codex-machine-b-fixture-token", "authorization-for-A", a.token, b.token]) {
    assert(!responses.includes(secret)); assert(!feed.includes(secret)); assert(!localData.includes(secret));
  }
  console.log("Two machine account flow passed: cached result retry, independent metadata, bound sign-ins, wrong-host code rejection, local-only tokens, device approval, account priority, guarded file defaults and legacy labels through the production bridge.");
} finally {
  let leaked = false;
  for (const machine of machines) if (machine.proc.exitCode === null) machine.proc.kill("SIGTERM");
  for (const machine of machines) {
    await Promise.race([machine.proc.exited, Bun.sleep(2000)]);
    if (machine.proc.exitCode === null) { machine.proc.kill("SIGKILL"); await machine.proc.exited; }
    const output = (await machine.output).join("\n");
    leaked ||= output.includes("fixture-token") || output.includes(machine.token);
  }
  await request("/api/auth/logout", "POST", {}, owner).catch(() => null);
  rmSync(root, { recursive: true, force: true });
  assert(!leaked, "Fixture process output contained a credential");
}
