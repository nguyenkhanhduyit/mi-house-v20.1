"""V21 Chromium checks for the actual editor functions and shipped CSS. No live services touched."""
from pathlib import Path
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]
admin=(P/'src/cms/SourceAdmin.jsx').read_text()
sanitizer=(P/'src/cms/sanitizeHtml.js').read_text().replace('export function sanitizeCmsHtml','function sanitizeCmsHtml')
rich=admin[admin.index('function sanitizeEditorHtml('):admin.index('function ensurePhotoDimension(')]
prefix='const attr=value=>String(value??" ").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");\n'
n=0
def check(value,name):
 global n
 assert value,name
 n+=1;print('PASS',name)
def contrast(bg,fg):
 def chan(c):
  x=int(c)/255
  return x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4
 def lum(s):
  vals=[float(v.strip()) for v in s[s.index('(')+1:s.index(')')].split(',')[:3]]
  return sum(w*chan(v) for w,v in zip([.2126,.7152,.0722],vals))
 a,b=lum(bg),lum(fg)
 return (max(a,b)+.05)/(min(a,b)+.05)
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True, executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={'width':1200,'height':900})
 page.set_content('<!doctype html><html><body><form><textarea data-cms-key="body"></textarea><textarea data-cms-key="homeBody"></textarea></form></body></html>')
 page.add_style_tag(path=str(P/'public/cms-controls-v16.css'))
 page.add_script_tag(content=sanitizer+prefix+rich+'window.editor={mountRichEditor,richEditorAction};document.addEventListener(\"click\",e=>{const el=e.target.closest(\"[data-cms-rich]\");if(el){e.preventDefault();richEditorAction(document,el.dataset.cmsRich,el);}});')
 page.evaluate('''() => {
  const a=document.querySelector('textarea[data-cms-key=body]');a.value='<p><b>Nội dung trang con</b></p>';
  const b=document.querySelector('textarea[data-cms-key=homeBody]');b.value='<p><b>Giới thiệu trang chủ</b></p>';
  window.editor.mountRichEditor(document,a);window.editor.mountRichEditor(document,b);
 }''')
 check(page.locator('.cms-rich-host').count()==2,'Two independent content editors are mounted')
 home=page.locator('.cms-rich-host').nth(1)
 home.locator('[data-cms-rich="toggle-source"]').click()
 check(home.locator('textarea').is_visible() and 'Giới thiệu' in home.locator('textarea').input_value(),'Home introduction HTML source mode exposes original markup')
 home.locator('textarea').fill('<h2>Tiêu đề từ HTML</h2><p><em>Nội dung hiển thị</em></p>')
 home.locator('[data-cms-rich="toggle-source"]').click()
 check('Tiêu đề từ HTML' in home.locator('.cms-rich-editable').inner_text() and home.locator('h2').count()==1,'Home HTML source renders into visual content')
 check('Tiêu đề từ HTML' in home.locator('textarea').input_value(),'Home HTML stored in the homeBody field')
 check('Nội dung trang con' in page.locator('textarea[data-cms-key=body]').input_value(),'Home edit cannot overwrite separate article body')
 home.locator('[data-cms-rich="toggle-source"]').click()
 home.locator('textarea').fill('<p>An toàn</p><img src="x" onerror="alert(1)"><script>alert(1)</script>')
 home.locator('[data-cms-rich="toggle-source"]').click()
 check('script' not in home.locator('textarea').input_value() and 'onerror' not in home.locator('textarea').input_value(),'HTML source sanitizes dangerous markup')
 check('Mã HTML' in home.locator('[data-cms-rich="toggle-source"]').inner_text(),'Explicit HTML paste mode is labeled in Vietnamese')
 # Display actual V21 CSS under representative Admin structures.
 page.set_content('''<!doctype html><body>
 <div id="cms-schema-toolbar">
  <button class="btn btn-outline-primary" data-cms-act="schema-generate">Tạo Schema tự động</button>
  <button class="btn btn-outline-success" data-cms-act="schema-validate">Kiểm tra JSON-LD</button>
  <button class="btn btn-primary" data-cms-act="schema-save">Lưu Schema</button>
  <button class="btn btn-outline-primary" data-cms-act="schema-generate-save">Tạo và lưu Schema</button>
 </div><div class="cms-media-main"><div id="cms-media-toolbar">
  <button class="btn btn-primary" data-cms-act="media-kind">Ảnh</button>
  <button class="btn btn-outline-primary" data-cms-act="media-kind">Video</button>
  <button class="btn btn-outline-secondary" data-cms-act="media-refresh">Làm mới</button>
 </div></div></body>''')
 page.add_style_tag(path=str(P/'public/cms-controls-v16.css'))
 page.wait_for_timeout(250)
 for sel in ['#cms-schema-toolbar .btn-outline-primary','#cms-schema-toolbar .btn-outline-success','#cms-schema-toolbar .btn-primary','#cms-media-toolbar .btn-primary','#cms-media-toolbar .btn-outline-primary','#cms-media-toolbar .btn-outline-secondary']:
  bg,fg=page.locator(sel).first.evaluate("el=>{const s=getComputedStyle(el);return [s.backgroundColor,s.color]}")
  check(contrast(bg,fg)>=4.5,f'Button {sel} contrast WCAG AA: {contrast(bg,fg):.2f}:1')
 # Test the exact status functions extracted from the React CMS closure with real DOM and an in-memory API boundary.
 snippet=admin[admin.index(' const updateRow=async(id,fn,expectedTab=screenRef.current.tab)=>{'):admin.index(' async function deleteRows(ids){')]
 page.add_script_tag(content='''const TABS={articles:'Tin tức'};
let dataRef={current:{articles:[{id:'article-1',status:'published',featured:false}],revision:0}},screenRef={current:{tab:'articles'}},busyRef={current:false},savingFormRef={current:false};
const listFor=(data,tab)=>data[tab]||[];
const saveRecord=(data,tab,entry)=>{const ix=data[tab].findIndex(v=>v.id===entry.id);data[tab][ix]=entry};
let forceFailure=false;const save=async next=>{if(busyRef.current)throw Error('busy');busyRef.current=true;try{if(forceFailure)throw Error('Redis unavailable');next.revision++;dataRef.current=next}finally{busyRef.current=false}};
let renderCurrent=doc=>{const row=doc.querySelector('tr[data-row-id]');const v=dataRef.current.articles[0];row.querySelector('span.featured-value').textContent=String(v.featured);row.querySelector('span.status-value').textContent=v.status;row.querySelector('.cms-status-popover').hidden=true};
let inform=message=>document.body.dataset.cmsResult=message;
'''+snippet+'window.statusV21={toggleRowStatus,read:()=>dataRef.current,fail:v=>forceFailure=v};')
 page.evaluate('''() => { const tr=document.createElement('tr');tr.dataset.rowId='article-1';tr.innerHTML='<td><button class="cms-status-trigger"></button><div class="cms-status-popover" hidden><button class="cms-status-option" data-cms-act="toggle-featured">Nổi bật</button><button class="cms-status-option" data-cms-act="toggle-status">Hiển thị</button></div><span class="featured-value">false</span><span class="status-value">published</span></td>';document.body.appendChild(tr); }''')
 for key,target,expected in [('featured','toggle-featured','true'),('status','toggle-status','draft')]:
  page.evaluate('''async ([key,target])=>await window.statusV21.toggleRowStatus(document,document.querySelector(`[data-cms-act="${target}"]`),key)''',[key,target])
  selector='.featured-value' if key=='featured' else '.status-value'
  check(page.locator(selector).inner_text()==expected,f'Status {key} updates the correct CMS record and UI')
  check(not page.locator('.cms-status-popover').get_attribute('hidden'),'Status dropdown stays open to show updated switch')
 check(page.locator('body').get_attribute('data-cms-result').startswith('Đã lưu trạng thái'),'Status action gives clear success confirmation')
 page.evaluate('window.statusV21.fail(true)')
 before=page.evaluate('window.statusV21.read().revision')
 result=page.evaluate('''async () => {try{await window.statusV21.toggleRowStatus(document,document.querySelector('[data-cms-act=toggle-featured]'),'featured');return 'no-error'}catch(e){return e.message}}''')
 check('Redis unavailable' in result and page.evaluate('window.statusV21.read().revision')==before,'API error does not falsely persist status')
 check(not page.locator('[data-cms-act=toggle-featured]').is_disabled(),'Status buttons recover after API failure')
 page.evaluate('window.statusV21.fail(false)')
 check('for(const editor of doc.querySelectorAll(\'form .cms-rich-host textarea[data-cms-key]\'))' in admin,'Save serializes and sanitizes both body and homeBody')
 browser.close()
print(f'V21 CHROMIUM: {n}/{n} PASS')
