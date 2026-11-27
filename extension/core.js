export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export function allowedURL(value, base) {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || !/(^|\.)chaoxing\.com(?:\.cn)?$/i.test(url.hostname) || url.username || url.password) {
    throw new Error('资源地址不在已授权的超星域名内');
  }
  return url.href;
}
export function resourceURL(value, base) {
  const url = new URL(value, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('资源下载地址的协议或格式不安全');
  if (!/(^|\.)(chaoxing\.com(?:\.cn)?|cldisk\.com)$/i.test(url.hostname)) throw new Error(`资源下载域名未授权：${url.hostname}`);
  // The status API still emits HTTP cldisk links; these servers support HTTPS.
  if (url.protocol === 'http:' && /(^|\.)cldisk\.com$/i.test(url.hostname)) url.protocol = 'https:';
  return url.href;
}
export function safeName(value, fallback = '未命名章节') {
  let name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '').trim().slice(0, 100).replace(/[. ]+$/g, '');
  if (!name) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}
export function extensionOf(name) {
  const match = String(name || '').match(/\.([a-z\d]{1,10})$/i);
  return match ? '.' + match[1].toLowerCase() : '';
}
export function mimeFor(extension) {
  return ({'.pdf':'application/pdf','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.zip':'application/zip','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4','.mp3':'audio/mpeg','.txt':'text/plain'})[extension] || 'application/octet-stream';
}
export function outputName(chapter, extension, index, count) {
  return safeName(chapter.title) + (count > 1 ? `（${index + 1}）` : '') + extension;
}
export function uniqueName(name, used) {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let result = name, n = 2;
  while (used.has(result.toLocaleLowerCase())) result = `${stem}（${n++}）${ext}`;
  used.add(result.toLocaleLowerCase());
  return result;
}
// Parse only a balanced JSON literal. Never execute scripts from the course page.
export function jsonAssignment(text, variable = 'mArg') {
  const re = new RegExp('\\b' + variable + '\\s*=\\s*\\{', 'g');
  for (const hit of text.matchAll(re)) {
    const start = hit.index + hit[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}
export function parseCatalog(doc) {
  const found = new Map();
  for (const row of doc.querySelectorAll('.posCatalog_select')) {
    const label = row.querySelector('.posCatalog_name, .posCatalog_title');
    if (!label) continue;
    const id = (row.id.match(/^(?:cur)?(\d+)$/) || [])[1] || (label.getAttribute('onclick')?.match(/getTeacherAjax\([^,]*,[^,]*,['"](\d+)/) || [])[1];
    if (!id || found.has(id)) continue;
    const number = row.querySelector('.posCatalog_sbar')?.textContent.trim() || '';
    const title = label.getAttribute('title') || label.textContent.replace(number, '').trim();
    const group = row.classList.contains('firstLayer') || (!label.hasAttribute('onclick') && label.classList.contains('posCatalog_title'));
    found.set(id, { id, title, number, group, containerOnly: group && !label.hasAttribute('onclick'), selected: false, state: 'pending', files: [], error: '' });
  }
  return [...found.values()];
}
export function chapterURL(source, chapterId) {
  const page = new URL(allowedURL(source.url));
  const template = source.template ? new URL(allowedURL(source.template,page)) : null;
  const prefix = template?.pathname.match(/^(.*)\/knowledge\/cards$/)?.[1] || '/mooc-ans';
  const endpoint = new URL(prefix + '/mycourse/studentstudyAjax', page.origin);
  const params = page.searchParams;
  const context = source.context || {};
  const courseId = context.courseId || params.get('courseId') || params.get('courseid');
  const clazzid = context.clazzid || params.get('clazzid') || params.get('clazzId');
  const cpi = context.cpi || params.get('cpi') || template?.searchParams.get('cpi');
  if (!courseId || !clazzid || !cpi) throw new Error('课程参数不完整，请刷新原课程页后重新打开扩展');
  for (const [key,value] of Object.entries({courseId,clazzid,chapterId,cpi,verificationcode:'',mooc2:'1',microTopicId:'0',editorPreview:'0',isPreviewVideo:'false',cardIndex:'0'})) endpoint.searchParams.set(key,value);
  return endpoint.href;
}
export function assertCoursePage(doc) {
  // Valid pages contain dormant verification widgets and scripts mentioning 验证码.
  // Detect an actual challenge/error response, never arbitrary words in the full HTML.
  if (doc.querySelector('#chapterFaceState')) throw new Error('此章节需要人脸验证，请回课程页完成验证后重试');
  const hasContent = Boolean(doc.querySelector('iframe[src*="/knowledge/cards"], .ans-cc, iframe[objectid]'));
  if (hasContent) return;
  const clean = doc.body.cloneNode(true);
  for (const node of clean.querySelectorAll('script,style,noscript,template,[hidden],[aria-hidden="true"]')) node.remove();
  const message = clean.textContent.replace(/\s+/g,' ').trim();
  if (doc.querySelector('input[type="password"]') || /登录|login|sign in/i.test(doc.title)) throw new Error('登录已失效，请回课程页重新登录后重试');
  if (/验证码|验证后|人脸识别/.test(message)) throw new Error('此章节需要验证，请回课程页完成验证后重试');
  if (/很抱歉，您没有权限|无权访问|未开放|未解锁|访问过于频繁|请先登录|访问受限/.test(message) || /^\s*(403|401|429)\s*$/.test(doc.title)) throw new Error('课程访问受限或登录失效，请回课程页确认后重试');
}
export function parseStudy(doc, base, chapterId, template) {
  const urls = new Set();
  for (const frame of doc.querySelectorAll('iframe[src]')) {
    if (/\/knowledge\/cards(?:\?|$)/.test(frame.getAttribute('src'))) urls.add(allowedURL(frame.getAttribute('src'), base));
  }
  let first = [...urls][0] || template;
  if (!first) throw new Error('未找到章节卡片，可能已退出登录或章节被锁定');
  const firstURL = new URL(allowedURL(first, base));
  firstURL.searchParams.set('knowledgeid', chapterId);
  firstURL.searchParams.set('num', '0');
  urls.clear();
  urls.add(firstURL.href);
  for (const item of doc.querySelectorAll('[onclick]')) {
    const m = item.getAttribute('onclick').match(/changeDisplayContent\(\s*(\d+)\s*,/);
    if (!m) continue;
    const card = new URL(firstURL);
    card.searchParams.set('num', String(Math.max(0, Number(m[1]) - 1)));
    urls.add(card.href);
  }
  return [...urls];
}
export function parseResources(doc, includeMedia = false) {
  const resources = new Map();
  const add = (p, type = '') => {
    const id = String(p.objectid || p.objectId || '');
    if (!/^[a-z\d_-]{8,128}$/i.test(id)) return;
    const name = p.name || p.filename || '';
    const ext = extensionOf(name) || (/^\.[a-z\d]+$/i.test(p.type || '') ? p.type.toLowerCase() : '');
    const isMedia = /^(video|audio)$/i.test(type) || /^\.(mp4|mp3|m4a|flv|m3u8|wav|webm|mov|avi)$/i.test(ext) || /video|audio/i.test(p.module || '');
    if (!includeMedia && isMedia) return;
    if (!isMedia && !/document|file|download|insertdoc|insertfile|pdf/i.test(type + ' ' + (p.module || '')) && !/^\.(pdf|pptx?|docx?|xlsx?|txt|rtf|csv|zip|rar|7z|jpg|jpeg|png|epub|wps|et|dps)$/i.test(ext)) return;
    const media = isMedia ? (/audio/i.test(type+' '+(p.module || '')) || /^\.(mp3|m4a|aac|wav|ogg|flac)$/.test(ext) ? 'audio' : 'video') : false;
    const prior = resources.get(id);
    resources.set(id, { objectid: id, name: name || prior?.name || '', extension: ext || prior?.extension || '', media: media || prior?.media || false });
  };
  for (const script of doc.querySelectorAll('script')) {
    const data = jsonAssignment(script.textContent);
    for (const attachment of data?.attachments || []) add(attachment.property || attachment, attachment.type || '');
  }
  for (const node of doc.querySelectorAll('iframe[objectid], iframe[data], [data-objectid]')) {
    let data = {};
    try { data = JSON.parse(node.getAttribute('data') || '{}'); } catch { /* tolerate malformed duplicate metadata */ }
    add({ ...data, objectid: node.getAttribute('objectid') || node.getAttribute('data-objectid') || data.objectid, name: data.name || node.getAttribute('name') || '', module: data.module || node.getAttribute('src') || '' }, node.className);
  }
  return [...resources.values()];
}
export function resolveResource(json, resource, base) {
  if (json.status !== 'success') throw new Error('资源状态异常，服务器未返回可下载文件');
  const originalExt = resource.extension || extensionOf(json.filename);
  let url, extension = originalExt;
  if (json.download) url = json.download;
  else if (originalExt === '.pdf' && json.pdf) { url = json.pdf; extension = '.pdf'; }
  else if (resource.media && json.http) url = json.http;
  else if (json.pdf) { url = json.pdf; extension = '.pdf'; }
  else throw new Error('没有可用的原文件或 PDF 下载链接');
  if (!extension) extension = extensionOf(new URL(url, base).pathname) || '.bin';
  return { url: resourceURL(url, base), extension };
}
