import {test,expect,chromium} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import http from 'node:http';
test('Batch scan overlaps requests for different chapters',async()=>{
  const {context,manager}=await setup();
  let active=0, peak=0;
  try {
    await context.route('**/studentstudyAjax?**',async route=>{
      active++;
      peak=Math.max(peak,active);
      try {
        await new Promise(resolve=>setTimeout(resolve,200));
        const id=new URL(route.request().url()).searchParams.get('chapterId');
        await route.fulfill({contentType:'text/html; charset=utf-8',body:fragment(id)});
      } finally { active--; }
    });
    await manager.locator('#all').check();
    await manager.locator('#scan').click();
    await expect(manager.locator('#notice')).toContainText('扫描完成');
    expect(peak).toBeGreaterThan(1);
    await expect(manager.locator('#summary')).toContainText('课节 5/5');
  } finally { await context.close(); }
});
test('Preview lets the user remove a PDF from the download selection',async()=>{
  const {context,manager,worker}=await setup();
  try {
    await manager.getByRole('checkbox',{name:'1.1 集合',exact:true}).check();
    await manager.locator('#scan').click();
    await expect(manager.locator('#notice')).toContainText('扫描完成');
    await manager.getByRole('button',{name:'预览 原始名字.pdf'}).click();
    await expect(manager.locator('#preview-content iframe')).toHaveAttribute('src',/^blob:/);
    await manager.locator('#preview-choice').uncheck();
    await manager.getByRole('button',{name:'关闭',exact:true}).click();
    await expect(manager.getByRole('checkbox',{name:/第1份 · 原始名字/})).not.toBeChecked();
    expect(await worker.evaluate(()=>chrome.downloads.search({}))).toHaveLength(0);
    await context.route('https://raw.githubusercontent.com/**',route=>route.fulfill({json:{version:'9.0.0'}}));
    await manager.locator('#check-update').click();
    await expect(manager.locator('#update-status')).toContainText('有新版本 v9.0.0');
    await expect(manager.locator('#update-link')).toBeVisible();
  }finally{await context.close();}
});
test('Restored manifest downloads only the outstanding file in a ZIP supplement',async()=>{
  const failure={id:'mapping_1'};
  const {context,manager,worker,requests}=await setup('chromium',failure);
  try {
    await manager.getByRole('checkbox',{name:'1.3 映射',exact:true}).check();
    await manager.locator('#scan').click();
    await expect(manager.locator('#notice')).toContainText('扫描完成');
    const scans = requests.filter(u=>u.includes('/studentstudyAjax')).length;
    await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('部分课件失败');
    await manager.reload();
    await expect(manager.locator('#notice')).toContainText('已恢复');
    await expect(manager.locator('.file-list')).toContainText('已保存');
    await expect(manager.locator('.file-list')).toContainText('失败');
    failure.id=null;
    await manager.locator('#retry').click();
    await expect(manager.locator('#notice')).toContainText('下载完成');
    expect(requests.filter(u=>u.includes('/studentstudyAjax'))).toHaveLength(scans);
    const [saved]=await worker.evaluate(()=>chrome.downloads.search({orderBy:['-startTime']}));
    expect(saved.filename).toContain('补充课件');
    const zip=await JSZip.loadAsync(await fs.readFile(saved.filename));
    expect(Object.keys(zip.files)).toEqual(['映射（2）.pptx']);
  }finally{await context.close();}
});
const extension=path.resolve('extension');
const sourceURL='https://mooc1.chaoxing.com/mycourse/studentstudy?chapterId=10000001&courseId=1&clazzid=2&cpi=3&enc=test';
const pdf=Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog>> endobj\n%%EOF');
const catalog=`<div class="posCatalog_select firstLayer" id="10000000"><span class="posCatalog_title" title="第一章"><em class="posCatalog_sbar">1</em>第一章</span></div>${[['10000001','1.1','集合'],['10000002','1.2','空章节'],['10000003','1.3','映射'],['10000004','1.4','集合']].map(([id,num,title])=>`<div class="posCatalog_select" id="cur${id}"><span class="posCatalog_name" title="${title}" onclick="getTeacherAjax('1','2','${id}')"><em class="posCatalog_sbar">${num}</em>${title}</span></div>`).join('')}`;
const study=id=>`<!doctype html><html><body>${catalog}<div id="mainid"><iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=${id}&num=0&courseid=1&clazzid=2&cpi=3"></iframe></div><li onclick="changeDisplayContent(1,1,'${id}')"></li>${id==='10000003'?`<li onclick="changeDisplayContent(2,2,'${id}')"></li>`:''}</body></html>`;
const fragment=id=>`<div id="mainid"><iframe id="iframe" src="/mooc-ans/knowledge/cards?knowledgeid=${id}&num=0&courseid=1&clazzid=2&cpi=3"></iframe></div><li onclick="changeDisplayContent(1,1,'${id}')"></li>${id==='10000003'?`<li onclick="changeDisplayContent(2,2,'${id}')"></li>`:''}<script>/* 原站包含验证码和请先登录的休眠处理逻辑 */</script><div hidden>请输入验证码</div>`;
function card(id,num){
  const files=id==='10000001'||id==='10000004'?[{type:'document',property:{objectid:'object_'+id,name:'原始名字.pdf'}}]:id==='10000003'?[{type:'document',property:{objectid:'mapping_'+num,name:'原文件'+num+'.pptx'}}]:[];
  return `<html><body><div class="ans-cc"></div><script>/* 验证码组件 */ mArg=${JSON.stringify({coursename:'测试课程',attachments:files})};</script></body></html>`;
}
async function setup(browserName='chromium',failure={}){
  const profile=path.resolve('browser-profiles',`profile-${browserName}-${Date.now()}`);
  const downloadDir=path.resolve('test-downloads',String(Date.now()));
  await fs.mkdir(path.join(profile,'Default'),{recursive:true});await fs.mkdir(downloadDir,{recursive:true});
  await fs.writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false}}));
  const context=await chromium.launchPersistentContext(profile,{
    channel:browserName==='edge'?'msedge':'chromium',headless:true,
    
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],acceptDownloads:false,
  });
  const requests=[];
  await context.route(/^https:\/\/[^/]+\.(chaoxing\.com|cldisk\.com)\//,async route=>{
    const u=new URL(route.request().url());requests.push(u.href);
    if(u.pathname.endsWith('/studentstudyAjax')) return route.fulfill({contentType:'text/html; charset=utf-8',body:fragment(u.searchParams.get('chapterId'))});
    if(u.pathname.endsWith('/studentstudy')) {
      if(u.searchParams.get('chapterId')!=='10000001') return route.fulfill({status:403,body:'signature does not match changed chapter'});
      return route.fulfill({contentType:'text/html; charset=utf-8',body:study(u.searchParams.get('chapterId'))});
    }
    if(u.pathname.includes('/knowledge/cards'))return route.fulfill({contentType:'text/html; charset=utf-8',body:failure.card===u.searchParams.get('knowledgeid')?'<html><input type="password"></html>':card(u.searchParams.get('knowledgeid'),u.searchParams.get('num'))});
    if(u.pathname.includes('/ananas/status/')){
      const id=u.pathname.split('/').pop();
      if(failure.id===id)return route.fulfill({status:403,body:'denied'});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({status:'success',download:failure.cdn?(id==='object_10000004'?`https://s3.cldisk.com/${id}`:`http://d0.cldisk.com/${id}`):`https://download.chaoxing.com/${id}`,filename:id.startsWith('mapping')?'a.pptx':'a.pdf'})});
    }
    if(u.hostname==='download.chaoxing.com')return route.fulfill({contentType:'application/octet-stream',body:pdf});
    if(u.hostname==='d0.cldisk.com')return route.fulfill({contentType:'application/octet-stream',body:pdf});
    if(u.hostname==='s3.cldisk.com')return route.fulfill({contentType:'application/octet-stream',body:pdf});
    return route.fulfill({status:404,body:'not found'});
  });
  let worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js'));if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/background.js'),timeout:15000});
  const extId=new URL(worker.url()).hostname;
  const source=await context.newPage();await source.goto(sourceURL,{waitUntil:'domcontentloaded',timeout:15000});
  const cdp=await context.newCDPSession(source);
  await cdp.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true});
  const sourceId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.includes('/studentstudy')).id;});
  const manager=await context.newPage();await manager.goto(`chrome-extension://${extId}/manager.html?source=${sourceId}`,{waitUntil:'domcontentloaded',timeout:15000});
  await expect(manager.locator('#selection')).toContainText('共 5');
  return {context,manager,requests,worker};
}
test('Chromium: ZIP, empty sections, multi-card files, chapter naming, duplicate naming',async()=>{
  const {context,manager,requests,worker}=await setup();
  try{
    await manager.locator('#all').check();
    await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toHaveText(/下载完成/,{timeout:45000});
    const [saved]=await worker.evaluate(()=>chrome.downloads.search({orderBy:['-startTime'],limit:1}));
    const bytes=await fs.readFile(saved.filename);const zip=await JSZip.loadAsync(bytes,{checkCRC32:true});
    expect(Object.keys(zip.files)).toEqual(['集合.pdf','映射（1）.pptx','映射（2）.pptx','集合（2）.pdf']);
    expect(await zip.file('集合.pdf').async('nodebuffer')).toEqual(pdf);
    await expect(manager.locator('#summary')).toContainText('已保存 4 份');
    await expect(manager.locator('#summary')).toContainText('跳过 2 节');
    expect(requests.some(u=>u.includes('knowledgeid=10000003')&&u.includes('num=1'))).toBe(true);
    expect(requests.some(u=>u.includes('/studentstudyAjax?')&&u.includes('chapterId=10000003'))).toBe(true);
    expect(requests.filter(u=>new URL(u).pathname.endsWith('/studentstudy'))).toHaveLength(1);
  }finally{await context.close();}
});
test('Chromium: individual automatic downloads and failure retry only remaining files',async()=>{
  const failure={id:'mapping_1'};
  const {context,manager,worker}=await setup('chromium',failure);
  try{
    await manager.getByRole('checkbox',{name:'1.3 映射',exact:true}).check();await manager.locator('#zip').uncheck();
    await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('部分课件失败',{timeout:45000});
    const first=await worker.evaluate(()=>chrome.downloads.search({}));expect(first.length).toBe(1);expect(path.basename(first[0].filename)).toBe('映射（1）.pptx');
    failure.id=null;await manager.locator('#retry').click();
    await expect(manager.locator('#notice')).toContainText('下载完成',{timeout:45000});
    const final=await worker.evaluate(()=>chrome.downloads.search({orderBy:['-startTime']}));expect(final.length).toBe(2);expect(path.basename(final[0].filename)).toBe('映射（2）.pptx');
  }finally{await context.close();}
});
test('Edge: isolated profile extension loads and completes automatic download',async()=>{
  const {context,manager,worker}=await setup('edge');
  try{
    await manager.getByRole('checkbox',{name:'1.1 集合',exact:true}).check({timeout:10000}); await manager.locator('#zip').uncheck({timeout:10000});
    await manager.locator('#start').click({timeout:10000});
    await expect(manager.locator('#notice')).toContainText('下载完成',{timeout:15000}).catch(async e=>{console.log(await manager.locator('#log').innerText());throw e;});
    const saved=await worker.evaluate(()=>chrome.downloads.search({orderBy:['-startTime'],limit:1}));
    expect(path.basename(saved[0].filename)).toBe('集合.pdf');
    expect(await fs.readFile(saved[0].filename)).toEqual(pdf);
  }finally{await context.close();}
});
test('Login/error cards are failures rather than empty chapters',async()=>{
  const {context,manager,worker}=await setup('chromium',{card:'10000002'});
  try{
    await manager.getByRole('checkbox',{name:'1.2 空章节',exact:true}).check();await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('部分课件失败',{timeout:10000});
    await expect(manager.locator('#summary')).toContainText('跳过 0 节 · 失败 1 项');
    expect(await worker.evaluate(()=>chrome.downloads.search({}))).toHaveLength(0);
  }finally{await context.close();}
});

for (const browserName of ['chromium','edge']) test(`${browserName}: real HTTP server receives session cookie and course origin Referer`,async()=>{
  const received=[];
  let origin;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,origin);
    if(url.pathname.includes('/studentstudy')) {
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Set-Cookie':'course_session=fixture-only; HttpOnly; SameSite=Lax; Path=/'});res.end(url.pathname.endsWith('/studentstudyAjax')?fragment(url.searchParams.get('chapterId')):study(url.searchParams.get('chapterId')));return;
    }
    if(url.pathname.includes('/knowledge/cards')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(card(url.searchParams.get('knowledgeid'),url.searchParams.get('num')));return;}
    if(url.pathname.includes('/ananas/status/')||url.pathname==='/download'){
      received.push({path:url.pathname,cookie:req.headers.cookie,referer:req.headers.referer});
      if(!req.headers.cookie?.includes('course_session=fixture-only')||req.headers.referer!==origin+'/'){res.writeHead(403);res.end('missing authentication or referer');return;}
      if(url.pathname==='/download'){res.writeHead(200,{'Content-Type':'application/pdf'});res.end(pdf);return;}
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'success',download:origin+'/download',filename:'original.pdf'}));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://fixture.chaoxing.com:${server.address().port}`;
  const profile=path.resolve('browser-profiles',`http-${browserName}-${Date.now()}`),downloadDir=path.resolve('test-downloads',`http-${Date.now()}`);
  await fs.mkdir(path.join(profile,'Default'),{recursive:true});await fs.mkdir(downloadDir,{recursive:true});
  await fs.writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:downloadDir,prompt_for_download:false}}));
  let context;
  try{
    context=await chromium.launchPersistentContext(profile,{channel:browserName==='edge'?'msedge':'chromium',headless:true,acceptDownloads:false,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--no-proxy-server','--host-resolver-rules=MAP fixture.chaoxing.com 127.0.0.1']});
    let worker=context.serviceWorkers().find(w=>w.url().endsWith('/background.js'));if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().endsWith('/background.js')});
    const page=await context.newPage();await page.goto(origin+new URL(sourceURL).pathname+new URL(sourceURL).search);
    const cdp=await context.newCDPSession(page);await cdp.send('Browser.setDownloadBehavior',{behavior:'default'});
    const sourceId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.includes('/studentstudy')).id;});
    const manager=await context.newPage();await manager.goto(`chrome-extension://${new URL(worker.url()).hostname}/manager.html?source=${sourceId}`);
    await expect(manager.locator('#selection')).toContainText('共 5');
    await manager.getByRole('checkbox',{name:'1.1 集合',exact:true}).check();await manager.locator('#zip').uncheck();await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('下载完成',{timeout:15000});
    expect(received).toHaveLength(2);expect(received.every(r=>r.cookie.includes('course_session=fixture-only')&&r.referer===origin+'/')).toBe(true);
    const [saved]=await worker.evaluate(()=>chrome.downloads.search({}));expect(path.basename(saved.filename)).toBe('集合.pdf');expect(await fs.readFile(saved.filename)).toEqual(pdf);
    await manager.close();await expect.poll(()=>worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules()).then(r=>r.length)).toBe(0);
  }finally{if(context)await context.close();await new Promise(resolve=>server.close(resolve));}
});
for (const browserName of ['chromium','edge']) test(`${browserName}: cldisk download and PDF hosts complete successfully over HTTPS`,async()=>{
  const {context,manager,worker,requests}=await setup(browserName,{cdn:true});
  try {
    await manager.getByRole('checkbox',{name:'1.1 集合',exact:true}).check();await manager.getByRole('checkbox',{name:'1.4 集合',exact:true}).check();await manager.locator('#zip').uncheck();await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('下载完成',{timeout:15000});
    const saved=await worker.evaluate(()=>chrome.downloads.search({}));expect(saved).toHaveLength(2);expect(saved.map(f=>path.basename(f.filename)).sort()).toEqual(['集合.pdf','集合（2）.pdf'].sort());for(const f of saved) expect(await fs.readFile(f.filename)).toEqual(pdf);
    expect(requests.some(u=>u.startsWith('https://d0.cldisk.com/'))).toBe(true);expect(requests.some(u=>u.startsWith('https://s3.cldisk.com/'))).toBe(true);
    const rules=await worker.evaluate(()=>chrome.declarativeNetRequest.getSessionRules());expect(rules[0].condition.requestDomains).toContain('cldisk.com');expect(rules[0].action.requestHeaders[0].value).toBe('https://mooc1.chaoxing.com/');
  } catch(e) { console.log(await manager.locator('#log').innerText());console.log('CDN requests',requests.filter(u=>u.includes('cldisk')));throw e;
  } finally {await context.close();}
});
for (const browserName of ['chromium','edge']) test(`${browserName}: select one file after scan, preserve choice across rescan and download`,async()=>{
  const {context,manager,worker,requests}=await setup(browserName);
  try {
    await manager.getByRole('checkbox',{name:'1.3 映射',exact:true}).check();await manager.locator('#scan').click();
    await expect(manager.locator('#notice')).toContainText('扫描完成');
    const first=manager.getByRole('checkbox',{name:'1.3 映射 · 第1份 · 原文件0.pptx',exact:true});
    const second=manager.getByRole('checkbox',{name:'1.3 映射 · 第2份 · 原文件1.pptx',exact:true});
    await first.uncheck();await expect(second).toBeChecked();
    const statusRequests = () => requests.filter(url=>url.includes('/ananas/status/')).length;
    const beforeDownload = statusRequests();
    await manager.locator('#media').check();
    await manager.locator('#start').click();
    await expect(manager.locator('#notice')).toContainText('请重新扫描');
    expect(statusRequests()).toBe(beforeDownload);
    await manager.locator('#scan').click();await expect(manager.locator('#notice')).toContainText('扫描完成');
    await expect(first).not.toBeChecked();await expect(second).toBeChecked();
    await manager.locator('#zip').uncheck();await manager.locator('#start').click();await expect(manager.locator('#notice')).toContainText('下载完成');
    const saved=await worker.evaluate(()=>chrome.downloads.search({}));expect(saved).toHaveLength(1);expect(path.basename(saved[0].filename)).toBe('映射（2）.pptx');
    expect(requests.some(u=>u.includes('/ananas/status/mapping_0'))).toBe(false);expect(requests.some(u=>u.includes('/ananas/status/mapping_1'))).toBe(true);
  } finally {await context.close();}
});
test('ZIP contains only chosen files and keeps their original chapter sequence',async()=>{
  const {context,manager,worker}=await setup();
  try {
    await manager.getByRole('checkbox',{name:'1.3 映射',exact:true}).check();await manager.locator('#scan').click();await expect(manager.locator('#notice')).toContainText('扫描完成');
    await manager.getByRole('checkbox',{name:'1.3 映射 · 第1份 · 原文件0.pptx',exact:true}).uncheck();
    await manager.locator('#start').click();await expect(manager.locator('#notice')).toContainText('下载完成');
    const [saved]=await worker.evaluate(()=>chrome.downloads.search({}));const zip=await JSZip.loadAsync(await fs.readFile(saved.filename),{checkCRC32:true});
    expect(Object.keys(zip.files)).toEqual(['映射（2）.pptx']);await expect(manager.locator('#summary')).toContainText('已保存 1 份');
  } finally {await context.close();}
});
test('Per-chapter select all/none controls and no-file selection do not trigger downloads',async()=>{
  const {context,manager,worker}=await setup('edge');
  try {
    const chapter=manager.getByRole('checkbox',{name:'1.3 映射',exact:true});await chapter.check();await manager.locator('#scan').click();await expect(manager.locator('#notice')).toContainText('扫描完成');
    const block=manager.locator('[data-chapter-id="10000003"]');
    await block.getByRole('button',{name:'本节全不选',exact:true}).click();await manager.locator('#start').click();await expect(manager.locator('#notice')).toContainText('请先勾选至少一份课件');
    expect(await worker.evaluate(()=>chrome.downloads.search({}))).toHaveLength(0);
    await chapter.uncheck();await block.getByRole('button',{name:'本节全选',exact:true}).click();await expect(chapter).toBeChecked();
    const files=block.locator('.file-row input');await expect(files.nth(0)).toBeChecked();await expect(files.nth(1)).toBeChecked();
    await block.getByRole('button',{name:'本节全不选',exact:true}).click();await expect(files.nth(0)).not.toBeChecked();await expect(files.nth(1)).not.toBeChecked();
  } finally {await context.close();}
});

