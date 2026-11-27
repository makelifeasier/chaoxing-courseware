import {allowedURL, resourceURL, safeName, outputName, uniqueName, parseCatalog, parseStudy, parseResources, resolveResource, chapterURL, assertCoursePage, mimeFor, sleep, MAX_FILE_BYTES} from './core.js';

const $ = id => document.getElementById(id);
const model = { chapters: [], source: null, busy: false, cancelled: false, controller: null, records: [], failedIds: new Set(), used: new Set(), archive: null, archiveBytes: 0, archivePart: 0, saved: 0, discovered: 0, skipped: 0, errors: 0, scanErrors: new Set(), saveErrors: new Set(), objectURLs: new Map() };
const ZIP_LIMIT = 200 * 1024 * 1024;
const parseHTML = html => new DOMParser().parseFromString(html, 'text/html');
const statusLabels = {pending:'待扫描',working:'扫描中',empty:'无课件 · 跳过',ready:'有课件',done:'已下载',error:'失败',stopped:'已停止'};

function log(message, error = false) {
  const time = new Date().toLocaleTimeString('zh-CN', {hour12:false});
  model.records.push({time, message, error});
  const li = document.createElement('li'); li.textContent = `${time}  ${message}`;
  if (error) li.className = 'error';
  $('log').append(li); $('log').scrollTop = $('log').scrollHeight;
  $('report').disabled = false;
}
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function visibleChapters() {
  const term = $('search').value.trim().toLowerCase();
  return model.chapters.filter(c => `${c.number} ${c.title}`.toLowerCase().includes(term));
}
function chooseFile(chapter, file, selected) {
  chapter.fileChoices ||= new Map();
  chapter.fileChoices.set(file.objectid, selected); file.selected = selected;
  if (chapter.state === 'done') chapter.state = 'ready';
  if (selected) chapter.selected = true;
}
function chosenFiles(chapter) { return chapter.files.filter(file=>file.selected !== false); }
function needsMediaRescan(chapter, includeMedia) {
  return !chapter.containerOnly && chapter.mediaSetting !== undefined && chapter.mediaSetting !== includeMedia;
}
const mediaRescanHint = '音视频设置已更改。请重新扫描相关课节，确认清单后再下载。';
function checkpoint() {
  if (!model.key || !model.loaded) return;
  try {
    const chapters = model.chapters.map(c=>({
      id:c.id, selected:c.selected, files:c.files, mediaSetting:c.mediaSetting,
      choices:[...(c.fileChoices || [])], scanError:c.scanError
    }));
    const settings = Object.fromEntries(['zip','number','media'].map(id=>[id,$(id).checked]));
    localStorage.setItem(model.key,JSON.stringify({chapters,settings,pending:model.pending}));
  } catch {
    notice('无法保存本地进度，请保持任务面板打开。',true);
  }
}
function fileKey(c,file) { return c.id+'/'+file.objectid; }
function retryable(c) { return c.scanError || chosenFiles(c).some(file=>file.result==='failed'); }
async function restore() {
  const saved = JSON.parse(localStorage.getItem(model.key) || 'null');
  if (!saved) return false;
  const progress = new Map(saved.chapters.map(c=>[c.id,c]));
  const pending = saved.pending;
  const [item] = pending ? await chrome.downloads.search({id:pending.id}) : [];
  model.pending = item?.state === 'in_progress' ? pending : null;
  for (const c of model.chapters) {
    const prior = progress.get(c.id);
    if (!prior) continue;
    const {selected,files,mediaSetting,scanError,choices} = prior;
    Object.assign(c,{selected,files,mediaSetting,scanError,fileChoices:new Map(choices)});
    for (const file of files) {
      if (item?.state==='complete' && pending.keys.includes(fileKey(c,file))) file.result='saved';
    }
    c.state = scanError ? 'error' : files.length ? 'ready' : mediaSetting===undefined ? 'pending' : 'empty';
    c.error = scanError || '';
  }
  for (const [id,value] of Object.entries(saved.settings)) $(id).checked=value;
  return true;
}
function render() {
  const fragment = document.createDocumentFragment();
  for (const c of visibleChapters()) {
    const block = document.createElement('div'); block.className = 'chapter-block'; block.dataset.chapterId = c.id;
    const row = document.createElement('label'); row.className = 'chapter' + (c.group ? ' group' : '');
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = c.selected; input.disabled = model.busy; input.setAttribute('aria-label', `${c.number} ${c.title}`);
    input.addEventListener('change', () => {
      c.selected = input.checked;
      if (c.group) for (const child of model.chapters) if (child.number.startsWith(c.number + '.')) child.selected = input.checked;
      render();
    });
    const title = document.createElement('span'); title.className = 'title';
    const num = document.createElement('span'); num.className = 'num'; num.textContent = c.number;
    title.append(num, document.createTextNode(c.title));
    const badge = document.createElement('span'); badge.className = 'badge ' + c.state;
    badge.textContent = c.state === 'ready' ? `已选 ${chosenFiles(c).length}/${c.files.length} 份` : statusLabels[c.state];
    if (c.error) row.title = c.error;
    row.append(input, title, badge); block.append(row);
    if (c.files.length) {
      const files = document.createElement('div'); files.className = 'file-list'; files.setAttribute('aria-label', `${c.number} ${c.title}的课件`);
      const tools = document.createElement('div'); tools.className = 'file-tools';
      const count = document.createElement('span'); count.textContent = `${chosenFiles(c).length}/${c.files.length} 份已勾选`;
      tools.append(count);
      for (const [text, selected] of [['本节全选',true],['本节全不选',false]]) {
        const button = document.createElement('button'); button.className = 'quiet'; button.textContent = text; button.disabled = model.busy;
        button.addEventListener('click',()=>{for (const file of c.files) chooseFile(c,file,selected); render();}); tools.append(button);
      }
      files.append(tools);
      c.files.forEach((file,index)=>{
        const label = document.createElement('label'); label.className = 'file-row';
        const check = document.createElement('input'); check.type = 'checkbox'; check.checked = file.selected !== false; check.disabled = model.busy;
        const originalName = file.name || `课件 ${index+1}`;
        check.setAttribute('aria-label',`${c.number} ${c.title} · 第${index+1}份 · ${originalName}`);
        check.addEventListener('change',()=>{chooseFile(c,file,check.checked); render();});
        const description = document.createElement('span'); description.className = 'file-description';
        const name = document.createElement('span'); name.textContent = `${index+1}. ${originalName}`;
        const target = document.createElement('small');
        const namedChapter = {...c,title:($('number').checked && c.number ? c.number+' ' : '')+c.title};
        target.textContent = '保存为：'+outputName(namedChapter,file.extension || '',index,c.files.length);
        description.append(name,target);
        if (file.result) {
          const result = document.createElement('small');
          result.textContent = file.result==='saved' ? '已保存' : '失败 · '+file.error;
          description.append(result);
        }
        label.append(check,description); files.append(label);
      });
      block.append(files);
    }
    fragment.append(block);
  }
  if (!fragment.childNodes.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = model.chapters.length ? '没有匹配的章节' : '未读取到目录，请先打开课程章节页面'; fragment.append(p); }
  $('chapters').replaceChildren(fragment);
  const selected = model.chapters.filter(c=>c.selected).length;
  const selectedFiles = model.chapters.filter(c=>c.selected).reduce((sum,c)=>sum+chosenFiles(c).length,0);
  $('selection').textContent = `共 ${model.chapters.length} 个目录项，已选 ${selected} 项 · ${selectedFiles} 份已识别课件`;
  const visible = visibleChapters();
  $('all').checked = visible.length > 0 && visible.every(c=>c.selected);
  $('all').indeterminate = visible.some(c=>c.selected) && !visible.every(c=>c.selected);
  for (const id of ['start','scan']) $(id).disabled = model.busy || selected === 0;
  for (const id of ['reload','all','invert','has-files','zip','number','media']) $(id).disabled = model.busy;
  $('stop').disabled = !model.busy || model.cancelled;
  $('retry').disabled = model.busy || !model.chapters.some(retryable);
  $('clear-saved').disabled = model.busy || Boolean(model.pending) || !model.chapters.some(c=>c.selected && chosenFiles(c).some(file=>file.result==='saved'));
  $('report').disabled = model.busy || model.records.length === 0;
  checkpoint();
}
function checkStopped() { if (model.cancelled) throw new DOMException('任务已停止', 'AbortError'); }
function updateProgress(current, total) {
  const percent = total ? Math.round(current / total * 100) : 0;
  $('progress').value = percent; $('percent').textContent = percent + '%';
  $('summary').textContent = `课节 ${current}/${total} · 已保存 ${model.saved} 份 · 跳过 ${model.skipped} 节 · 失败 ${model.errors} 项`;
}

// The function runs only when opening/refreshing the manager, in the selected course tab.
function inspectCourse() {
  const catalogHtml = [...document.querySelectorAll('.posCatalog_select')].map(e=>e.outerHTML).join('');
  const studyHtml = [...document.querySelectorAll('iframe[src*="/knowledge/cards"], [onclick*="changeDisplayContent"]')].map(e=>e.outerHTML).join('');
  let title = '';
  try {
    const frame = document.querySelector('iframe[src*="/knowledge/cards"]');
    const scripts = [...(frame?.contentDocument?.querySelectorAll('script') || [])];
    for (const script of scripts) {
      const m = script.textContent.match(/"coursename"\s*:\s*("(?:\\.|[^"\\])*")/);
      if (m) { title = JSON.parse(m[1]); break; }
    }
  } catch { /* a cross-origin card is read later via an authorized request */ }
  const context = {courseId:document.querySelector('#curCourseId')?.value || '',clazzid:document.querySelector('#curClazzId')?.value || '',cpi:document.querySelector('#curCpi')?.value || ''};
  return { url: location.href, catalogHtml, studyHtml, title, context };
}
async function init() {
  model.loaded = false;
  model.source = null; model.chapters = []; model.failedIds.clear();
  try {
    const sourceId = Number(new URLSearchParams(location.search).get('source'));
    if (!sourceId) throw new Error('请在学习通课程章节页面点击扩展图标打开本页');
    const [result] = await chrome.scripting.executeScript({target:{tabId:sourceId}, func:inspectCourse});
    const source = result.result;
    allowedURL(source.url);
    model.chapters = parseCatalog(parseHTML(source.catalogHtml));
    if (!model.chapters.length) throw new Error('课程目录尚未载入。请在课程页面等待目录出现，再点击“刷新目录”');
    source.template = parseHTML(source.studyHtml).querySelector('iframe[src]')?.getAttribute('src');
    if (source.template) source.template = allowedURL(source.template, source.url);
    model.source = source;
    $('course').textContent = source.title || '当前课程';
    const tab = await chrome.tabs.getCurrent();
    await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[tab.id + 1], addRules:[{
      id:tab.id + 1, priority:1,
      action:{type:'modifyHeaders',requestHeaders:[{header:'Referer',operation:'set',value:new URL(source.url).origin + '/'}]},
      condition:{initiatorDomains:[chrome.runtime.id],tabIds:[tab.id],requestDomains:['chaoxing.com','chaoxing.com.cn','cldisk.com'],resourceTypes:['xmlhttprequest']}
    }]});
    const page = new URL(source.url);
    const course = source.context.courseId || page.searchParams.get('courseId') || page.searchParams.get('courseid');
    const clazz = source.context.clazzid || page.searchParams.get('clazzid');
    const student = source.context.cpi || page.searchParams.get('cpi');
    model.key = course && clazz && student ? JSON.stringify([page.origin,course,clazz,student]) : null;
    const restored = model.key && await restore();
    model.loaded = true;
    notice(restored ? '已恢复课件清单与保存记录。点击“下载选中课件”继续。' : '勾选课节后点击下载，后续将自动扫描、跳过空章节并保存课件。');
    log(`已读取 ${model.chapters.length} 个目录项。`);
  } catch (e) { notice(e.message, true); log(e.message, true); }
  render();
}

async function request(url, binary = false) {
  url = binary ? resourceURL(url) : allowedURL(url);
  checkStopped();
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController(); model.controller = controller;
    const timeout = setTimeout(() => controller.abort(), binary ? 180000 : 45000);
    try {
      const response = await fetch(url, {credentials:'include', signal:controller.signal, cache:'no-store'});
      if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
      if (binary) resourceURL(response.url || url);
      else allowedURL(response.url || url);
      if (/passport|\/login(?:[/?]|$)/i.test(response.url)) throw new Error('登录已失效，请在课程页重新登录后重试');
      if (!binary) return await response.text();
      const type = response.headers.get('Content-Type') || '';
      if (/text\/html|application\/json/i.test(type)) throw new Error('下载接口返回了网页或错误信息，请检查登录和资源权限');
      const expected = Number(response.headers.get('Content-Length'));
      if (expected > MAX_FILE_BYTES) throw new Error('单个文件超过 256 MB，请在课程页单独下载');
      const chunks = []; let received = 0;
      if (!response.body) return new Uint8Array(await response.arrayBuffer());
      const reader = response.body.getReader();
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        checkStopped(); received += value.byteLength;
        if (received > MAX_FILE_BYTES) { await reader.cancel(); throw new Error('单个文件超过 256 MB，请在课程页单独下载'); }
        chunks.push(value);
        $('transfer').textContent = `接收课件：${(received / 1048576).toFixed(1)} MB` + (expected ? ` / ${(expected / 1048576).toFixed(1)} MB` : '');
      }
      if (!received) throw new Error('下载文件为空');
      const bytes = new Uint8Array(received); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.length; }
      const prefix = new TextDecoder().decode(bytes.subarray(0,256)).trimStart();
      if (/^(<!doctype\s+html|<html[\s>]|<script[\s>])/i.test(prefix)) throw new Error('服务器返回了登录或错误页面，已阻止保存为课件');
      return bytes;
    } catch (error) {
      if (model.cancelled) checkStopped();
      lastError = error.name === 'AbortError' ? new Error('网络请求超时') : error;
      if (/登录|权限|未授权|不安全|256 MB|网页|错误信息|地址不在/.test(lastError.message)) break;
      if (attempt < 2) await sleep(700 * (attempt + 1));
    } finally { clearTimeout(timeout); if (model.controller === controller) model.controller = null; }
  }
  throw lastError;
}
async function scanChapter(c, includeMedia) {
  c.state = 'working'; c.error = ''; render();
  if (c.containerOnly) {
    c.files = []; c.state = 'empty'; c.mediaSetting = includeMedia;
    log(`${c.number} ${c.title}：目录标题，自动跳过`); render(); return;
  }
  const study = chapterURL(model.source,c.id);
  const doc = parseHTML(await request(study));
  assertCoursePage(doc);
  // A login/error page must never be classified as an empty chapter.
  if (!doc.querySelector('iframe[src*="/knowledge/cards"]')) throw new Error('章节接口未返回课件卡片，请在课程页检查章节是否已开放');
  const cardURLs = parseStudy(doc, study, c.id);
  const found = new Map();
  for (const url of cardURLs) {
    checkStopped();
    const card = parseHTML(await request(url)); assertCoursePage(card);
    if (!card.querySelector('.ans-cc, iframe[objectid]') && ![...card.scripts].some(s=>/mArg\s*=\s*\{/.test(s.textContent))) throw new Error('卡片内容无法识别，已标记为失败而非空章节');
    for (const file of parseResources(card, includeMedia)) found.set(file.objectid,file);
    await sleep(180);
  }
  c.fileChoices ||= new Map();
  const previous = new Map(c.files.map(file=>[file.objectid,file]));
  c.files = [...found.values()].map(file=>{
    const prior = previous.get(file.objectid);
    return {...file,selected:c.fileChoices.get(file.objectid) ?? true,result:prior?.result,error:prior?.error};
  });
  c.scanError = '';
  c.state = c.files.length ? 'ready' : 'empty'; c.mediaSetting = includeMedia;
  log(`${c.number} ${c.title}：${c.files.length ? `识别到 ${c.files.length} 份课件` : '没有课件，自动跳过'}`);
  render();
}

async function saveBlob(blob, filename, keys = []) {
  if (model.busy) checkStopped();
  const url = URL.createObjectURL(blob);
  try {
    const id = await chrome.downloads.download({url,filename,saveAs:false,conflictAction:'uniquify'});
    model.objectURLs.set(id,url);
    if (keys.length) { model.pending = {id,keys}; checkpoint(); }
    // Register then check state to cover downloads that finish before the listener attaches.
    await new Promise((resolve,reject) => {
      let settled = false;
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); chrome.downloads.onChanged.removeListener(listener); if (error) reject(error); else resolve(); };
      const listener = delta => {
        if (delta.id !== id) return;
        if (delta.state?.current === 'complete') finish();
        else if (delta.state?.current === 'interrupted') finish(model.cancelled ? new DOMException('任务已停止','AbortError') : new Error(`浏览器未保存文件：${delta.error?.current || '下载中断'}`));
      };
      const timer = setTimeout(()=>finish(new Error('等待浏览器保存超时，请检查下载记录中的拦截提示')),180000);
      chrome.downloads.onChanged.addListener(listener);
      chrome.downloads.search({id}).then(([item]) => {
        if (item?.state === 'complete') finish();
        else if (item?.state === 'interrupted') finish(new Error(`浏览器未保存文件：${item.error || '下载中断'}`));
      }).catch(finish);
    });
  } finally {
    for (const [id,value] of model.objectURLs) if (value === url) model.objectURLs.delete(id);
    URL.revokeObjectURL(url);
  }
}
async function flushArchive() {
  if (!model.archive || !model.archiveBytes) return;
  checkStopped();
  $('transfer').textContent = '正在生成 ZIP，请稍候…';
  const archive = model.archive;
  const blob = await archive.generateAsync({type:'blob',compression:'DEFLATE',compressionOptions:{level:1}}, meta => {
    checkStopped(); $('transfer').textContent = `正在打包：${meta.percent.toFixed(0)}%`;
  });
  const label = model.supplement ? '补充课件' : '课件';
  const name = `超星课件/${safeName($('course').textContent)}/${safeName($('course').textContent)}_${label}_${String(++model.archivePart).padStart(2,'0')}.zip`;
  await saveBlob(blob,name,model.archiveFiles.map(({chapter,file})=>fileKey(chapter,file)));
  for (const {file} of model.archiveFiles) file.result = 'saved';
  model.pending = null;
  checkpoint();
  model.saved += Object.keys(archive.files).filter(k=>!archive.files[k].dir).length;
  log(`已保存压缩包：${name.split('/').pop()}`);
  model.archive = new JSZip(); model.archiveBytes = 0;
  model.archiveFiles = [];
}
async function downloadChapter(c, options) {
  let failures = 0;
  for (let i = 0; i < c.files.length; i++) {
    checkStopped();
    const resource = c.files[i];
    if (resource.selected === false) continue;
    if (resource.result === 'saved' || (options.retry && resource.result !== 'failed')) continue;
    try {
      $('transfer').textContent = `解析课件：${c.title}（${i+1}/${c.files.length}）`;
      const endpoint = new URL(`/ananas/status/${encodeURIComponent(resource.objectid)}?flag=normal`, model.source.url);
      let info;
      try { info = JSON.parse(await request(endpoint.href)); }
      catch (e) { if (e.name === 'AbortError') throw e; throw new Error('资源接口未返回有效信息，请检查课程登录状态及资源权限'); }
      const resolved = resolveResource(info, resource, model.source.url);
      const data = await request(resolved.url,true);
      const namedChapter = {...c,title:(options.number && c.number ? c.number + ' ' : '') + c.title};
      const filename = uniqueName(outputName(namedChapter,resolved.extension,i,c.files.length),model.used);
      if (options.zip) {
        if (model.archiveBytes && model.archiveBytes + data.byteLength > ZIP_LIMIT) {
          try { await flushArchive(); }
          catch (error) {
            if (error.name === 'AbortError') throw error;
            markArchiveFailed(error);
          }
        }
        model.archive.file(filename,data); model.archiveBytes += data.byteLength;
        model.archiveFiles.push({chapter:c,file:resource});
      } else {
        await saveBlob(new Blob([data],{type:mimeFor(resolved.extension)}),`超星课件/${safeName($('course').textContent)}/${filename}`,[fileKey(c,resource)]);
        resource.result = 'saved'; model.pending = null; model.saved++;
        checkpoint();
      }
      log(`${options.zip ? '已加入打包' : '已保存'}：${filename}`);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      resource.result = 'failed'; resource.error = e.message;
      checkpoint();
      failures++; model.errors++; model.failedIds.add(c.id); model.saveErrors.add(c.id);
      log(`${c.number} ${c.title}，第 ${i+1} 份课件失败：${e.message}`,true);
    }
  }
  c.state = failures ? 'error' : (options.zip ? 'ready' : 'done');
  c.error = failures ? `${failures} 份课件下载失败` : '';
}
function markArchiveFailed(error) {
  for (const {chapter,file} of model.archiveFiles) {
    file.result = 'failed';
    file.error = error.message;
    model.failedIds.add(chapter.id);
    model.errors++;
  }
  model.pending = null;
  model.archive = new JSZip();
  model.archiveFiles = [];
  model.archiveBytes = 0;
  checkpoint();
  log('ZIP 保存失败 · '+error.message,true);
}
async function run(scanOnly = false, retry = false) {
  if (model.busy || !model.loaded || model.reconciling) return;
  if (model.pending) {
    model.reconciling = true;
    const pending = model.pending;
    let item;
    try { [item] = await chrome.downloads.search({id:pending.id}); }
    catch { notice('无法读取上次的下载记录，请重试。',true); return; }
    finally { model.reconciling = false; }
    if (item?.state === 'in_progress') {
      notice('浏览器仍在保存上次的下载。完成后再继续。'); return;
    }
    for (const c of model.chapters) for (const file of c.files) {
      if (item?.state === 'complete' && pending.keys.includes(fileKey(c,file))) file.result = 'saved';
    }
    model.pending = null;
    checkpoint();
  }
  const selected = model.chapters.filter(c=>retry ? retryable(c) : c.selected);
  if (!selected.length) return;
  const options = {zip:$('zip').checked,number:$('number').checked,media:$('media').checked,retry};
  const stale = selected.filter(c=>needsMediaRescan(c,options.media));
  if (!scanOnly && stale.length) {
    for (const c of stale) c.selected = true;
    render();
    notice(mediaRescanHint);
    return;
  }
  if (!scanOnly && selected.every(c=>c.mediaSetting===options.media && c.state!=='pending') && !selected.some(c=>chosenFiles(c).length)) {
    notice('请先勾选至少一份课件；也可以重新扫描其他课节。'); return;
  }
  model.busy = true; model.cancelled = false; model.saved = 0; model.skipped = 0; model.errors = 0;
  model.archive = new JSZip(); model.archiveBytes = 0; model.archivePart = 0; model.archiveFiles = [];
  model.supplement = retry;
  model.used = new Set(); model.failedIds = new Set(); model.scanErrors = new Set(); model.saveErrors = new Set();
  render(); log(`${scanOnly ? '开始扫描' : '开始下载'}：${selected.length} 个目录项${options.zip && !scanOnly ? '，ZIP 打包' : ''}`);
  notice('任务进行中，请保持本页打开。'); let completed = 0;
  const zipChapters = new Set();
  try {
    for (const c of selected) {
      checkStopped();
      try {
        const needsScan = c.mediaSetting === undefined;
        if (scanOnly || needsScan) await scanChapter(c,options.media);
        else c.scanError = '';
        if (!c.files.length) model.skipped++;
        else if (!scanOnly && !chosenFiles(c).length) {model.skipped++; log(`${c.number} ${c.title}：未勾选课件，跳过下载`);}
        else if (!scanOnly) { if (options.zip) zipChapters.add(c); await downloadChapter(c,{...options,retry:retry && !needsScan}); }
      } catch (e) {
        if (e.name === 'AbortError') { c.state = 'stopped'; throw e; }
        c.state = 'error'; c.error = e.message; c.scanError = e.message; model.errors++; model.failedIds.add(c.id); model.scanErrors.add(c.id);
        log(`${c.number} ${c.title}：${e.message}`,true);
      }
      completed++; updateProgress(completed,selected.length); render(); await sleep(350);
    }
    if (!scanOnly && options.zip) {
      try { await flushArchive(); for (const c of zipChapters) if (!model.failedIds.has(c.id)) c.state = 'done'; }
      catch (e) {
        if (e.name !== 'AbortError') markArchiveFailed(e);
        throw e;
      }
    }
    notice(model.errors ? '任务已结束，部分课件失败；可点击“重试失败项”。' : (scanOnly ? '扫描完成，请在课节下勾选需要的课件，再点击“下载选中课件”。' : model.saved ? '下载完成。课件已保存到浏览器默认下载目录。' : '没有需要下载的课件，已跳过。'),model.errors > 0);
    log(`${scanOnly ? '扫描' : '下载'}结束：已保存 ${model.saved} 份，跳过 ${model.skipped} 节，失败 ${model.errors} 项。`);
  } catch (e) {
    if (options.zip && model.archiveBytes) for (const c of zipChapters) if (c.state !== 'done') { model.failedIds.add(c.id); c.state = 'stopped'; }
    if (e.name !== 'AbortError') model.errors++;
    notice(e.name === 'AbortError' ? '任务已停止。已保存的文件保留；当前未保存的 ZIP 内容已放弃，请重新下载需要的章节。' : e.message,true);
    log(e.name === 'AbortError' ? '用户停止了任务。' : e.message,true);
  } finally {
    model.archive = null; model.archiveBytes = 0; model.busy = false; model.controller = null;
    $('transfer').textContent = ''; updateProgress(completed,selected.length); render();
  }
}

$('start').addEventListener('click',()=>void run());
$('scan').addEventListener('click',()=>void run(true));
$('retry').addEventListener('click',()=>void run(false,true));
$('clear-saved').addEventListener('click',()=>{
  if (model.chapters.some(c=>c.selected && needsMediaRescan(c,$('media').checked))) {
    notice(mediaRescanHint);
    return;
  }
  for (const c of model.chapters.filter(c=>c.selected)) {
    for (const file of chosenFiles(c)) {
      if (file.result !== 'saved') continue;
      delete file.result;
      delete file.error;
      c.state = 'ready';
    }
  }
  render();
  notice('已清除所选课件的保存记录，可以重新下载。');
});
$('stop').addEventListener('click',()=>{model.cancelled=true; model.controller?.abort(); $('stop').disabled=true; for (const id of model.objectURLs.keys()) void chrome.downloads.cancel(id).catch(()=>{});});
$('reload').addEventListener('click',()=>void init());
$('search').addEventListener('input',render);
for (const id of ['number','zip']) $(id).addEventListener('change',render);
$('media').addEventListener('change',()=>{
  render();
  if (model.chapters.some(c=>c.selected && needsMediaRescan(c,$('media').checked))) notice(mediaRescanHint);
});
$('all').addEventListener('change',()=>{for(const c of visibleChapters()) c.selected=$('all').checked; render();});
$('invert').addEventListener('click',()=>{for(const c of visibleChapters()) c.selected=!c.selected; render();});
$('has-files').addEventListener('click',()=>{for(const c of model.chapters) c.selected=c.files.length>0 && c.mediaSetting===$('media').checked; render();});
$('downloads').addEventListener('click',()=>chrome.tabs.create({url:'chrome://downloads/'}));
$('report').addEventListener('click',async()=>{
  try {
    const text = model.records.map(r=>`${r.time} ${r.error?'[失败] ':''}${r.message}`).join('\r\n');
    await saveBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),'超星课件/任务记录.txt');
  } catch(e) { notice(e.message,true); }
});
window.addEventListener('beforeunload',event=>{if(model.busy){event.preventDefault();event.returnValue='';}});
void init();

