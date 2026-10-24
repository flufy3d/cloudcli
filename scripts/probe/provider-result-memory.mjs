/** Synthetic, isolated RSS regression probe; never starts or restarts a server. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function probe(base) {
  const require=createRequire(base+'package.json');
  const Database=require('better-sqlite3');
  const {OpenCodeSessionEventTranslator}=await import(base+'dist-server/server/modules/providers/list/opencode/opencode-event-translator.js');
  const {chatRunRegistry}=await import(base+'dist-server/server/modules/websocket/services/chat-run-registry.service.js');
  const {OpenCodeSessionsProvider}=await import(base+'dist-server/server/modules/providers/list/opencode/opencode-sessions.provider.js');
  const sid='memory-probe-native-session';
  const db=new Database(process.env.HOME+'/.local/share/opencode/opencode.db',{readonly:true,fileMustExist:true});
  const translator=new OpenCodeSessionEventTranslator('memory-probe');
  const run=chatRunRegistry.startRun({appSessionId:'memory-probe',provider:'opencode',providerSessionId:sid,connection:null,userId:null});
  let images=0;
  const start=performance.now();
  for(const {data} of db.prepare('SELECT data FROM session_message WHERE session_id=? ORDER BY seq').iterate(sid)){
   for(const block of JSON.parse(data).content??[]){
    if(block.type!=='tool'||!block.state?.content?.some(c=>c.uri?.startsWith('data:')))continue;
    for(const frame of translator.translate({type:'session.tool.success',data:{id:block.id,content:block.state.content}}).frames){run.writer.send(frame);images++;}
   }
  }
  db.close();assert.equal(images, 51);
  const bufferedWireBytes = run.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
  global.gc();
  const mem=()=>({rssMiB:Math.round(process.memoryUsage().rss/1048576),heapMiB:Math.round(process.memoryUsage().heapUsed/1048576),peakRSSMiB:Math.round(process.resourceUsage().maxRSS/1024)});
  console.log(JSON.stringify({stage:'replayed',images,bufferedWireBytes,...mem()}));
  const reader=new OpenCodeSessionsProvider();
  for(let i=0;i<4;i++){const result=await reader.fetchHistory(sid,{providerSessionId:sid,limit:20});assert.equal(result.total, 51);assert.equal(result.messages.length, 20);console.log(JSON.stringify({stage:'history-'+i,total:result.total,returned:result.messages.length,...mem()}));}
  console.log(JSON.stringify({stage:'summary',elapsedMs:Math.round(performance.now()-start),...mem()}));
  chatRunRegistry.clearAll();

}

if (process.argv[2] === '--worker') {
  await probe(`${path.resolve(process.argv[3])}/`);
} else {
  const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--baseline'), 'Usage: node scripts/probe/provider-result-memory.mjs [--baseline /path/to/old/package]');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-memory-'));
  try {
    const require = createRequire(import.meta.url);
    const Database = require('better-sqlite3');
    const directory = path.join(home, '.local/share/opencode');
    await fs.mkdir(directory, { recursive: true });
    const db = new Database(path.join(directory, 'opencode.db'));
    const sid = 'memory-probe-native-session';
    const imageBytes = 1_392_000;
    try {
      db.exec('CREATE TABLE session_v2 (id TEXT, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)');
      db.prepare('INSERT INTO session_v2 VALUES (?,0,0,0,0,0)').run(sid);
      const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=', 'base64');
      for (let index = 0; index < 51; index += 1) {
        // A tiny valid PNG plus deterministic trailing bytes models differently
        // sized screenshots without storing private screenshots in the repo.
        const bytes = Buffer.alloc(imageBytes, createHash('sha256').update(String(index)).digest());
        png.copy(bytes);
        const data = { content: [{ type: 'tool', id: `t${index}`, name: 'read', state: { status: 'completed', input: {}, content: [{ type: 'image', uri: `data:image/png;base64,${bytes.toString('base64')}` }] } }] };
        insert.run(`m${index}`, sid, 'assistant', index, 1, 1, JSON.stringify(data));
      }
    } finally { db.close(); }
    console.log(JSON.stringify({ fixture: 'synthetic', images: 51, encodedImageBytes: 51 * imageBytes * 4 / 3, rssBudgetMiB: 512 }));
    const targets = args.length > 0 ? [['baseline', args[1]], ['current', repository]] : [['current', repository]];
    for (const [label, root] of targets) {
      await fs.access(path.join(root, 'dist-server/server/modules/providers/list/opencode/opencode-sessions.provider.js'));
      const result = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--worker', root], {
        env: { ...process.env, HOME: home, DATABASE_PATH: path.join(home, 'auth.db') }, encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Memory probe failed: ${result.stderr || result.stdout}`);
      console.log(label);process.stdout.write(result.stdout);
      const summary = result.stdout.trim().split('\n').map((line) => JSON.parse(line)).find((entry) => entry.stage === 'summary');
      assert.ok(summary, 'Worker must report its peak RSS');
      if (label === 'current') assert.ok(summary.peakRSSMiB <= 512, `Peak RSS ${summary.peakRSSMiB} MiB exceeds the isolated 512 MiB probe budget`);
    }
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}
