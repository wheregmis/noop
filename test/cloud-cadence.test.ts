import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Separate process: module globals, clock, transport and PATH cannot affect another test or inspect real AI tools.
async function fixture(body: string) {
  const root = mkdtempSync(join(tmpdir(), "noop-cloud-cadence-"));
  const script = `
    import assert from 'node:assert/strict';
    import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
    import {spyOn} from 'bun:test';
    import {P} from ${JSON.stringify(resolve("src/core.ts"))};
    import * as server from ${JSON.stringify(resolve("src/server.ts"))};
    import {startCloudBridge} from ${JSON.stringify(resolve("src/cloud.ts"))};
    import {startMachineBridge} from ${JSON.stringify(resolve("src/machine-bridge.ts"))};
    mkdirSync(P(),{recursive:true});
    mkdirSync(P('agents/lead'),{recursive:true});writeFileSync(P('agents/lead/profile.md'),'# Lead');
    writeFileSync(P('config.toml'),'[host]\\nname="fixture"\\n[cloud]\\npoll_seconds=1\\n');
    const settings=(value)=>writeFileSync(P('settings.json'),JSON.stringify({configuration:{cloud:{poll_seconds:value}}}));
    const nativeTimeout=globalThis.setTimeout;
    let now=1000000,seq=0;
    const timers=new Map();
    Date.now=()=>now;
    globalThis.setTimeout=(fn,ms=0,...args)=>{const id=++seq;timers.set(id,{at:now+ms,ms,fn:()=>fn(...args)});return id;};
    globalThis.clearTimeout=(id)=>timers.delete(id);
    const settle=async()=>{for(let i=0;i<30;i++)await Promise.resolve();await new Promise(r=>nativeTimeout(r,0));};
    const advance=async(ms)=>{now+=ms;for(const [id,t] of [...timers].sort((a,b)=>a[1].at-b[1].at)){if(t.at<=now&&timers.delete(id)){t.fn();await settle();}}};
    const delays=()=>[...timers.values()].map(t=>t.ms).sort((a,b)=>a-b);
    const cfg={cloud:{url:'http://fixture.invalid',poll_seconds:60,machine_token:'e'.repeat(64)},server:{token:'fixture'},host:{name:'fixture'}};
    const statusSpy=spyOn(server,'status').mockReturnValue({active:[]});
    const settingsSpy=spyOn(server,'settingsView').mockReturnValue({});
    const calls=[];
    let transport=async(path,init)=>Response.json(path.endsWith('identity')?{host:'fixture',legacy:false}:path.includes('inbox')?{items:[]}:{ok:true});
    globalThis.fetch=async(input,init={})=>{const url=new URL(String(input));calls.push({path:url.pathname,query:url.search,init,at:now});return transport(url.pathname,init,url);};
    const holding=(signal)=>new Promise((resolve,reject)=>{if(signal.aborted)reject(new Error('aborted'));else signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
    ${body}
    statusSpy.mockRestore();settingsSpy.mockRestore();
    assert.equal(timers.size,0,'stopped bridges leave no scheduled callbacks');
    console.log('cadence fixture passed');
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: { ...process.env, PATH: "", NOOP_HOME: join(root, "home"), HUB_DATA: join(root, "data"), HUB_CONF: join(root, "noop.toml"), HUB_HOST: "fixture", HUB_SYNC: "local" },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exit = await child.exited, [stdout, stderr] = await output;
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("cadence fixture passed");
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
    rmSync(root, { recursive: true, force: true });
  }
}

test("both running bridges use fresh shared cadence and reject invalid direct-file values", async () => {
  await fixture(`
    for(const start of [startCloudBridge,startMachineBridge]){
      settings(1);
      const stop=start(cfg);await settle();
      assert.equal(delays().length,start===startCloudBridge?2:1);
      assert(delays().every(ms=>ms===1000),'persisted cadence wins over captured config');
      settings(60);await advance(1000);
      assert(delays().every(ms=>ms===60000),'new UI cadence applies at next schedule');
      for(const invalid of [0,0.1,61,'2',null]){
        settings(invalid);await advance(delays()[0]);
        assert(delays().every(ms=>ms===3000),'invalid direct-file cadence uses safe default');
      }
      writeFileSync(P('settings.json'),'{broken');await advance(3000);
      assert(delays().every(ms=>ms===3000),'unreadable config uses safe default');
      await stop();assert.equal(timers.size,0);
    }
    const polls=calls.filter(c=>c.path==='/api/host/inbox');
    assert(polls.length>0&&polls.every(c=>new URLSearchParams(c.query).get('wait')==='25'),'owner inbox keeps 25s long poll');
  `);
});

test("primary cycles and event uploads stay single-flight and unchanged status uses elapsed five minutes", async () => {
  await fixture(`
    settings(1);
    let releaseState,releaseEvent;
    transport=async(path,init)=>{
      if(path==='/api/host/state'&&!releaseState)return new Promise(r=>releaseState=()=>r(Response.json({ok:true})));
      if(path==='/api/events'&&!releaseEvent)return new Promise(r=>releaseEvent=()=>r(Response.json({ok:true})));
      return Response.json(path.includes('inbox')?{items:[]}:{ok:true});
    };
    const stop=startCloudBridge(cfg);await settle();
    for(let i=0;i<4;i++)await advance(1000);
    assert.equal(calls.filter(c=>c.path==='/api/host/state').length,1,'slow status has no overlapping cycle');
    server.appendEvent({from:'hub',kind:'system',text:'first'});
    server.appendEvent({from:'hub',kind:'system',text:'second'});await settle();
    assert.equal(calls.filter(c=>c.path==='/api/events').length,1,'mirror callbacks share the same flush');
    releaseEvent();releaseState();await settle();
    assert.deepEqual(calls.filter(c=>c.path==='/api/events').map(c=>JSON.parse(c.init.body).text),['first','second']);
    for(let i=0;i<101;i++)await advance(1000);
    assert.equal(calls.filter(c=>c.path==='/api/host/state').length,1,'100 quick polls do not force status');
    await advance(300000);
    assert.equal(calls.filter(c=>c.path==='/api/host/state').length,2,'elapsed five minutes forces unchanged status');
    let drained=false,releaseFinal,finalSignal;
    transport=async(path,init)=>path==='/api/events'?new Promise(r=>{finalSignal=init.signal;releaseFinal=()=>r(Response.json({ok:true}));}):Response.json({items:[]});
    server.appendEvent({from:'hub',kind:'system',text:'shutdown event'});await settle();
    const stopping=stop().then(()=>drained=true);await settle();
    assert.equal(drained,false,'graceful shutdown waits for an event already uploading');
    assert.equal(finalSignal.aborted,false,'poll abort must not cancel the final event upload');
    releaseFinal();await stopping;
    const count=calls.length;
    server.appendEvent({from:'hub',kind:'system',text:'after stop'});await advance(600000);
    assert.equal(calls.length,count,'stopped mirror cannot restart transport');
    transport=async(path)=>path==='/api/events'?Response.json({error:'offline'},{status:503}):Response.json({items:[]});
    const offlineStop=startCloudBridge(cfg);await settle();
    server.appendEvent({from:'hub',kind:'system',text:'retained locally while offline'});await settle();await offlineStop();
    assert(server.feed().some(e=>e.text==='retained locally while offline'),'failed shutdown mirror leaves durable local feed intact');
  `);
});

test("primary inbox backoff subtracts long-poll time and shutdown wakes sleeps or aborts polls", async () => {
  await fixture(`
    settings(60);
    let release;
    transport=async(path,init)=>path.includes('inbox')?new Promise(r=>release=()=>r(Response.json({items:[]}))):Response.json({ok:true});
    let stop=startCloudBridge(cfg);await settle();
    now+=25000;release();await settle();
    assert(delays().includes(35000),'long poll consumes part of the requested cadence');
    await stop();assert.equal(timers.size,0,'stop wakes sleeping inbox immediately');
    transport=async(path,init)=>path.includes('inbox')?holding(init.signal):Response.json({ok:true});
    stop=startCloudBridge(cfg);await settle();
    const poll=calls.at(-1);await stop();
    assert(poll.init.signal.aborted,'stop aborts an outstanding long poll');
  `);
});

test("primary shutdown drains an owner action already started without consuming the next action", async () => {
  await fixture(`
    let release,started=0,finished=false;
    server.setCancelTask(async()=>{started++;await new Promise(r=>release=r);server.appendEvent({from:'hub',kind:'system',text:'owner action finished'});return 'cancelled';});
    transport=async(path)=>Response.json(path.includes('inbox')?{items:[{seq:1,type:'cancel',id:'T-0001'},{seq:2,type:'cancel',id:'T-0002'}]}:{ok:true});
    const stop=startCloudBridge(cfg);await settle();
    assert.equal(started,1);
    const drained=stop().then(()=>finished=true);await settle();
    assert.equal(finished,false,'shutdown waits for already-started mutation');
    release();await drained;
    assert.equal(started,1,'shutdown never starts the next inbox action');
    assert.equal(calls.filter(c=>c.path==='/api/events'&&JSON.parse(c.init.body).text==='owner action finished').length,1,'in-flight action final event is mirrored before shutdown');
  `);
});

test("primary shutdown preserves an already-started owner message attachment download", async () => {
  await fixture(`
    let release,mediaSignal,ownerText,finished=false;
    server.setOwnerTask(async(text)=>{ownerText=text;});
    const event={id:'cloud-image-message',ts:new Date().toISOString(),from:'owner',kind:'owner',text:'Use this image',attachments:['/media/picture.png']};
    transport=async(path,init)=>{
      if(path==='/media/picture.png')return new Promise((resolve,reject)=>{mediaSignal=init.signal;release=()=>resolve(new Response(new Uint8Array([1,2,3])));init.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});
      return Response.json(path.includes('inbox')?{items:[{seq:1,type:'message',event}]}:{ok:true});
    };
    const stop=startCloudBridge(cfg);await settle();
    assert(mediaSignal,'owner image download started');
    const drained=stop().then(()=>finished=true);await settle();
    assert.equal(finished,false,'shutdown waits for message attachment');
    assert.equal(mediaSignal.aborted,false,'poll cancellation cannot drop a started message image');
    assert.equal(ownerText,undefined,'owner action has not consumed an incomplete image');
    release();await drained;
    const saved=server.ATTACH_DIR+'/cloud-image-message/picture.png';
    assert(ownerText.includes(saved)&&!ownerText.includes('could not be downloaded'));
    assert.deepEqual([...readFileSync(saved)],[1,2,3]);
  `);
});

test("machine polling remains single-flight, heartbeat stays throttled and registration failures retry after 30 seconds", async () => {
  await fixture(`
    settings(1);
    let inboxes=0,release;
    transport=async(path,init)=>{
      if(path.endsWith('identity'))return Response.json({host:'fixture',legacy:false});
      if(path.endsWith('machine-inbox')){inboxes++;return new Promise(r=>{release=()=>r(Response.json({items:[]}));init.signal.addEventListener('abort',()=>r(Response.json({items:[]})),{once:true});});}
      return Response.json({ok:true});
    };
    let stop=startMachineBridge(cfg,{taskReady:()=>true});await settle();
    await advance(10000);assert.equal(inboxes,1,'slow machine inbox cannot overlap');
    release();await settle();
    for(let i=0;i<20;i++){await advance(1000);release();await settle();}
    assert.equal(calls.filter(c=>c.path.endsWith('machine-state')).length,2,'machine heartbeat remains 30s apart');
    await advance(1000);await stop();
    assert.equal(timers.size,0,'stop drains current poll without scheduling again');
    transport=async()=>Response.json({error:'offline'},{status:503});
    stop=startMachineBridge(cfg);await settle();
    assert.deepEqual(delays(),[30000],'failed channel registration retains fixed retry interval');
    await stop();
  `);
});
