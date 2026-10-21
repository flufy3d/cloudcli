/** Browser acceptance against the real frontend with fixture HTTP/WebSocket.
 * Start Vite separately, set TITLE_PROBE_URL and optional PLAYWRIGHT_MODULE_PATH.
 * --search opens the session from Conversations search before the name update.
 * No production backend or account is contacted.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Use an installed Playwright module; this probe does not install dependencies.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const search = process.argv.includes('--search');
const evidenceRoot = mkdtempSync(path.join(tmpdir(), 'cloudcli-title-browser-'));
const baseUrl = process.env.TITLE_PROBE_URL || 'http://127.0.0.1:5719';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[]; const requests=[]; let socket;
page.on('pageerror', e=>errors.push(e.message));
const session = {id:'app-1',providerSessionId:'native-1',provider:'codex',__provider:'codex',summary:'排查重复文字的原始首句',messageCount:30,lastActivity:'2026-10-20T10:00:00.000Z',createdAt:'2026-10-20T10:00:00.000Z',__projectId:'project-1',cwd:'/tmp/title-browser'};
const other={...session,id:'app-2',providerSessionId:'native-2',summary:'后台会话的原始首句',lastActivity:'2026-10-19T10:00:00.000Z'};
const project={projectId:'project-1',name:'title-browser',path:'/tmp/title-browser',fullPath:'/tmp/title-browser',displayName:'标题验收',isStarred:false,sessions:[session,other],sessionMeta:{hasMore:false,total:2}};
await page.addInitScript(()=>{const now=Math.floor(Date.now()/1000); localStorage.setItem('auth-token',btoa('{}')+'.'+btoa(JSON.stringify({iat:now,exp:now+3600})) +'.fixture');localStorage.setItem('language','zh-CN');});
await page.route('**/api/**',async route=>{
 const u=new URL(route.request().url());requests.push(u.pathname+u.search); let body={success:true,data:{}};
 if(u.pathname==='/api/providers/search/sessions') {
  const payload={projectResult:{projectId:'project-1',projectName:'title-browser',projectDisplayName:'标题验收',sessions:[{sessionId:'app-1',sessionSummary:session.summary,provider:'codex',matches:[{role:'user',snippet:'浏览器验收消息 10',timestamp:'2026-10-20T10:00:00.000Z',highlights:[{start:0,end:7}]}]}]},totalMatches:1,scannedProjects:1,totalProjects:1};
  await route.fulfill({status:200,contentType:'text/event-stream',body:'event: result\ndata: '+JSON.stringify(payload)+'\n\nevent: done\ndata: {}\n\n'});return;
 }
 if(u.pathname==='/api/auth/status')body={needsSetup:false};
 else if(u.pathname==='/api/auth/user')body={user:{id:1,username:'browser-probe'}};
 else if(u.pathname==='/api/user/onboarding-status')body={hasCompletedOnboarding:true};
 else if(u.pathname.endsWith('/archived'))body={success:true,data:{sessions:[],projects:[]}};
 else if(u.pathname.includes('/file-tree/'))body=[];
 else if(u.pathname==='/api/projects')body=[project];
 else if(u.pathname.includes('/messages'))body={success:true,data:{messages:Array.from({length:30},(_,i)=>({id:'message-'+i,kind:'text',role:i%2?'assistant':'user',content:('浏览器验收消息 '+i+'，检查标题更新后滚动位置保持。').repeat(10),sessionId:'app-1',provider:'codex',timestamp:'2026-10-20T10:00:00.000Z'})),total:30,hasMore:false}};
 else if(u.pathname.endsWith('/running'))body={success:true,data:{sessions:[]}};
 else if(u.pathname.endsWith('/recent'))body={success:true,data:{sessions:[session,other],hasMore:false,total:2}};
 else if(u.pathname==='/api/providers/sessions/app-1')body={success:true,data:{session,project}};
 else if(u.pathname.endsWith('/providers'))body={success:true,data:[]};
 else if(u.pathname.includes('/sessions'))body={success:true,data:{sessions:[session,other],hasMore:false,total:2}};
 await route.fulfill({json:body});
});
await page.routeWebSocket(/\/ws(?:\?|$)/,ws=>{socket=ws;ws.onMessage(()=>{});});
try {
 await page.goto(`${baseUrl}/session/app-1`);
 await page.waitForTimeout(4000);

 if (search) {
   await page.getByText('Conversations',{exact:true}).first().click();
   await page.locator('input.nav-search-input:visible').fill('浏览器验收');
   await page.getByText('浏览器验收消息 10',{exact:true}).first().click();
   await page.waitForTimeout(700);
 }
 const emit=(id,name)=>socket.send(JSON.stringify({kind:'session_upserted',sessionId:id,providerSessionId:id==='app-1'?'native-1':'native-2',provider:'codex',metadataOnly:true,session:{...(id==='app-1'?session:other),summary:name},project:{...project,sessions:undefined},timestamp:new Date().toISOString()}));
 const scroll=await page.evaluate(()=>{
   const elements=[...document.querySelectorAll('div')].filter(e=>e.clientHeight>100&&e.scrollHeight>e.clientHeight+200&&e.innerText.includes('浏览器验收消息'));
   const el=elements.sort((a,b)=>a.clientHeight-b.clientHeight)[0];
   if(!el)throw new Error('chat scroll pane missing');
   el.dataset.probeScroll='true';el.scrollTop=Math.max(100,el.scrollHeight-el.clientHeight-600);return {top:el.scrollTop,height:el.scrollHeight};
 });
 await page.waitForTimeout(300);
 const beforeCount=requests.filter(p=>p.includes('/messages')).length;
 const beforeUrl=page.url();
 emit('app-1','排查版本重复文字问题');
 await page.waitForFunction(()=>document.title==='排查版本重复文字问题',null,{timeout:2000});
 assert.equal(await page.getByText('排查版本重复文字问题',{exact:true}).count(),search?1:2);
 emit('app-2','后台会话新标题');
 if (!search) await page.getByText('后台会话新标题',{exact:true}).waitFor();

 await page.waitForTimeout(500);
 assert.equal(await page.title(),'排查版本重复文字问题');
 assert.equal(page.url(),beforeUrl);
 assert.equal(requests.filter(p=>p.includes('/messages')).length,beforeCount);
 const finalScrollTop=await page.locator('[data-probe-scroll]').evaluate(el=>el.scrollTop);
 // Virtualized rows can round an anchor by one CSS pixel in Chromium.
 assert.ok(Math.abs(finalScrollTop-scroll.top)<=1, `scroll moved from ${scroll.top} to ${finalScrollTop}`);
 assert.equal(await page.locator('[aria-label="Session needs attention"]').count(),0);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:path.join(evidenceRoot, 'after.png')});
 const evidence={status:'passed',search,currentTitle:await page.title(),scrollTop:scroll.top,historyRequests:beforeCount,errors};
 writeFileSync(path.join(evidenceRoot,'result.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({evidenceRoot,...evidence},null,2));

} finally {await browser.close();}
