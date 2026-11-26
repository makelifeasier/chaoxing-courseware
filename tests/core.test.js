import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {allowedURL,resourceURL,safeName,uniqueName,jsonAssignment,parseCatalog,parseStudy,parseResources,resolveResource,outputName,chapterURL,assertCoursePage} from '../extension/core.js';
const doc = text => new JSDOM(text).window.document;
const origin='https://mooc1.chaoxing.com';
test('only exact authorized domains and HTTP(S), reject credentials / tricks',()=>{
  assert.equal(allowedURL('/file',origin),origin+'/file');
  for(const u of ['https://chaoxing.com.evil.test/a','https://evilchaoxing.com/a','javascript:alert(1)','file:///C:/a','https://user:pass@mooc1.chaoxing.com/a']) assert.throws(()=>allowedURL(u));
});
test('filenames preserve Chinese and eliminate path traversal, reserved names and trailing spaces',()=>{
  assert.equal(safeName('../集合:*?\\'), '集合');
  assert.equal(safeName('CON.txt'),'_CON.txt');
  assert.equal(safeName('..'),'未命名章节');
  assert.equal(outputName({title:'集合'},'.pptx',0,1),'集合.pptx');
  assert.equal(outputName({title:'集合'},'.pdf',1,2),'集合（2）.pdf');
  const used=new Set(); assert.equal(uniqueName('A.pdf',used),'A.pdf'); assert.equal(uniqueName('a.pdf',used),'a（2）.pdf');
});
test('JSON extraction handles nested braces and escaped quotes without executing scripts',()=>{
  const value={attachments:[{property:{name:'a { \\" b.pdf'}}]};
  assert.deepEqual(jsonAssignment('mArg=""; try { mArg = '+JSON.stringify(value)+'; }'),value);
  assert.equal(jsonAssignment('mArg = {a: alert("bad")};'),null);
});
test('real course catalog shape includes groups, nested sections, numbers, and deduplicates',()=>{
  const parsed=parseCatalog(doc(`<div class="posCatalog_select firstLayer" id="10000001"><span class="posCatalog_title" title="多项式"><em class="posCatalog_sbar">1</em>多项式</span></div><div class="posCatalog_select" id="cur10000002"><span class="posCatalog_name" title="集合" onclick="getTeacherAjax('20000001','30000001','10000002');"><em class="posCatalog_sbar">1.1.1</em>集合</span></div>`));
  assert.equal(parsed.length,2);assert.equal(parsed[0].group,true);assert.equal(parsed[1].title,'集合');assert.equal(parsed[1].id,'10000002');
});
test('multi-card chapters are enumerated starting at zero and chapter ID changes',()=>{
  const urls=parseStudy(doc('<iframe src="/mooc-ans/knowledge/cards?knowledgeid=old&num=0"></iframe><li onclick="changeDisplayContent(1,1,\'x\')"></li><li onclick="changeDisplayContent(2,2,\'x\')"></li>'),origin,'123');
  assert.equal(urls.length,2); assert.deepEqual(urls.map(u=>new URL(u).searchParams.get('num')),['0','1']);
  assert(urls.every(u=>new URL(u).searchParams.get('knowledgeid')==='123'));
});
test('deduplicates iframe and mArg metadata, excludes videos and tests by default',()=>{
  const d=doc(`<script>mArg={"attachments":[{"type":"document","property":{"objectid":"abc12345","name":"集合(6).pdf"}},{"type":"video","property":{"objectid":"video123","name":"视频.mp4"}}]};</script><iframe objectid="abc12345" data='{"name":"集合(6).pdf"}'></iframe>`);
  assert.equal(parseResources(d).length,1); assert.equal(parseResources(d,true).length,2);
  assert.equal(parseResources(doc('<script>mArg={"attachments":[]};</script>')).length,0);
});
test('prefer original office file and match PDF fallback extension',()=>{
  assert.deepEqual(resolveResource({status:'success',download:origin+'/original',pdf:origin+'/pdf'},{extension:'.pptx'},origin),{url:origin+'/original',extension:'.pptx'});
  assert.equal(resolveResource({status:'success',pdf:origin+'/preview'},{extension:'.pptx'},origin).extension,'.pdf');
  assert.throws(()=>resolveResource({status:'error'},{},origin));
  assert.throws(()=>resolveResource({status:'success',download:'https://evil.test/f.pdf'},{extension:'.pdf'},origin));
});
test('normal course HTML mentioning verification in scripts and dormant UI is not rejected',()=>{
  const actualShape = doc(`<iframe src="/mooc-ans/knowledge/cards?knowledgeid=10000002"></iframe><div hidden>请输入验证码</div><script>function closeChapterVerificationCode(){ /* 验证码 请先登录 */ }</script>`);
  assert.doesNotThrow(()=>assertCoursePage(actualShape));
  assert.doesNotThrow(()=>assertCoursePage(doc('<div class="ans-cc">课程正文讨论验证码</div><script>const text="请先登录"</script>')));
});
test('actual login, verification and permission responses remain failures',()=>{
  for(const html of ['<input type="password">','<title>403</title>很抱歉，您没有权限访问这个页面！','<div>请输入验证码后继续</div>','<input id="chapterFaceState" value="1">']) assert.throws(()=>assertCoursePage(doc(html)));
});
test('batch chapters use actual AJAX endpoint with complete parameters and without stale chapter enc',()=>{
  const source={url:origin+'/mycourse/studentstudy?chapterId=111&courseId=20000001&clazzid=30000001&cpi=40000001&enc=old',template:origin+'/mooc-ans/knowledge/cards?num=0&cpi=40000001'};
  const url=new URL(chapterURL(source,'222'));
  assert.equal(url.pathname,'/mooc-ans/mycourse/studentstudyAjax'); assert.equal(url.searchParams.get('chapterId'),'222');assert.equal(url.searchParams.get('courseId'),'20000001');assert.equal(url.searchParams.has('enc'),false);
  assert.throws(()=>chapterURL({url:origin+'/mycourse/studentstudy'},'222'));
});
test('actual cldisk download, PDF and media hosts are accepted only as resources',()=>{
  assert.equal(resourceURL('http://d0.cldisk.com/download/file?token=unchanged'),'https://d0.cldisk.com/download/file?token=unchanged');
  assert.equal(resourceURL('https://s3.cldisk.com/file.pdf'),'https://s3.cldisk.com/file.pdf');
  assert.equal(resourceURL('http://cs.cldisk.com/file.mp4'),'https://cs.cldisk.com/file.mp4');
  assert.throws(()=>allowedURL('https://d0.cldisk.com/file'));
  assert.equal(resolveResource({status:'success',download:'http://d0.cldisk.com/download/file',pdf:'https://s3.cldisk.com/file.pdf'},{extension:'.pdf'},origin).url,'https://d0.cldisk.com/download/file');
});
test('CDN permission checks reject lookalike domains and unsafe protocols; errors exclude signed query',()=>{
  for(const value of ['https://cldisk.com.evil.test/file','https://evilcldisk.com/file','javascript:alert(1)','file:///tmp/a','https://user:pass@d0.cldisk.com/a']) assert.throws(()=>resourceURL(value));
  assert.throws(()=>resourceURL('https://cdn.other.test/f?secret=123'),e=>e.message.includes('cdn.other.test')&&!e.message.includes('secret'));
});

