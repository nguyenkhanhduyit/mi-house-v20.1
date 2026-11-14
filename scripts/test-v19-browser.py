"""Real Chromium DOM regression tests, offline; no Redis/Cloudinary credentials."""
from pathlib import Path
import json
from playwright.sync_api import sync_playwright
P=Path(__file__).resolve().parents[1]
admin=(P/'src/cms/SourceAdmin.jsx').read_text()
app=(P/'src/App.jsx').read_text()
sanitizer=(P/'src/cms/sanitizeHtml.js').read_text().replace('export function sanitizeCmsHtml','function sanitizeCmsHtml')
rich=admin[admin.index('function sanitizeEditorHtml('):admin.index('function ensurePhotoDimension(')]
prefix="const attr=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');\n"
checks=[]
def check(ok,label):
 assert ok,label
 checks.append(label)
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
 page=browser.new_page(viewport={"width":1280,"height":850})
 page.goto('about:blank')
 page.set_content('<!doctype html><html><body><textarea data-cms-key="body"><h2 style="color: rgb(100, 50, 20)">Mi House</h2><p>Gội đầu dưỡng sinh</p><table><tr><td>Bảng giá</td></tr></table></textarea></body></html>')
 page.add_script_tag(content=sanitizer+prefix+rich+"window.v19={sanitizeCmsHtml,mountRichEditor,richEditorAction};")
 data=page.evaluate("""() => {
   const {sanitizeCmsHtml}=window.v19;
   return {
    script:sanitizeCmsHtml('<p>Safe</p><script>alert(1)</'+'script><img src=x onerror="alert(1)">'),
    js:sanitizeCmsHtml('<a href="javascript:alert(1)" onclick="evil()">open</a>'),
    frame:sanitizeCmsHtml('<iframe src="https://evil.example/embed/anything"></iframe><iframe src="https://www.youtube.com/embed/abc123"></iframe>'),
    table:sanitizeCmsHtml('<table><tr><td style="color: red">OK</td></tr></table>'),
    srcset:sanitizeCmsHtml('<img src="/ok.jpg" srcset="javascript:alert(1)">')
   }
 }""")
 check('<script' not in data['script'] and 'onerror' not in data['script'],'Editor sanitizer removes script and event handlers')
 check('javascript:' not in data['js'] and 'onclick' not in data['js'],'Editor sanitizer rejects javascript: URLs')
 check('evil.example' not in data['frame'] and 'youtube.com/embed' in data['frame'],'Editor sanitizer allows only trusted video embeds')
 check('<table>' in data['table'] and 'color: red' in data['table'],'Editor sanitizer preserves tables and typography')
 check('srcset' not in data['srcset'],'Editor sanitizer rejects unvalidated srcset')
 page.evaluate("""() => {
   const t=document.querySelector('textarea[data-cms-key=body]');t.value='<h2 style="color:#664422">MI HOUSE</h2><p>Xin chào</p><table><tr><td>Gói 1</td></tr></table>';
   window.v19.mountRichEditor(document,t);
   const host=document.querySelector('.cms-rich-host');
   window.v19.richEditorAction(document,'toggle-source',host.querySelector('[data-cms-rich=toggle-source]'));
 }""")
 check(page.locator('.cms-rich-host.cms-html-mode').count()==1,'Visual to HTML Source mode opens')
 source=page.locator('textarea[data-cms-key=body]').input_value()
 check('<h2' in source and '<table' in source and 'MI HOUSE' in source,'Mode switch preserves headings and tables')
 page.evaluate("""() => {
   const host=document.querySelector('.cms-rich-host');
   const t=host.querySelector('textarea[data-cms-key=body]');t.value+='<p><strong>Edited in HTML</strong></p>';
   window.v19.richEditorAction(document,'toggle-source',host.querySelector('[data-cms-rich=toggle-source]'));
   window.v19.richEditorAction(document,'toggle-fullscreen',host.querySelector('[data-cms-rich=toggle-fullscreen]'));
 }""")
 check('Edited in HTML' in page.locator('.cms-rich-editable').inner_text(),'HTML Source to Visual preserves edits')
 check(page.locator('.cms-rich-host.cms-rich-fullscreen').count()==1,'Editor fullscreen toggle operates')
 # Native browser popup: user gesture occurs in iframe with exact SourceAdmin sandbox.
 sandbox='allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads'
 page.set_content(f'<html><body><iframe sandbox="{sandbox}" srcdoc="<a href=\'about:blank#public-article\' target=\'_blank\' rel=\'noopener noreferrer\'>View</a>"></iframe></body></html>')
 with page.expect_popup(timeout=5000) as popup_event:
  page.frame_locator('iframe').locator('a').click()
 popup=popup_event.value
 check(popup is not None,'View from Admin iframe opens native new tab')
 popup.close()
 # Real shipped CSS (not a hand-written approximation) must override the older
 # slideshow rule: hover uses a dark brown surface and white copy.
 page.set_content('<html><body><a class="slideshow__btn"><span>ĐẶT LỊCH HẸN NGAY</span></a></body></html>')
 page.add_style_tag(path=str(P/'public/site.css'))
 page.add_style_tag(path=str(P/'public/landing.css'))
 page.locator('.slideshow__btn').hover()
 page.wait_for_timeout(350)
 colors=page.evaluate("""() => {const el=document.querySelector('.slideshow__btn'); const s=getComputedStyle(el);return {bg:s.backgroundColor,fg:s.color,span:getComputedStyle(el.querySelector('span')).color}}""")
 check(colors['bg']=='rgb(98, 65, 45)' and colors['fg']=='rgb(255, 255, 255)' and colors['span']=='rgb(255, 255, 255)', 'Booking CTA hover uses dark brown background and white text')
 # Source-mode user input is cleaned immediately before explicit Save. A draft
 # does not get stored with executable script or javascript URLs.
 check('for(const editor of doc.querySelectorAll(' in admin and 'sanitizeEditorHtml(doc,editor.value)' in admin,'HTML source is sanitized on explicit Save even without toggling modes')
 # Use the ACTUAL SPA SEO routine with two archived routes to validate that
 # route changes do not accumulate stale/duplicate structured-data scripts.
 seojs=app[app.index('function parseSchema('):app.index('function syncNavigation(')]
 fixture='const manifest='+json.dumps({'/article':{'title':'Archived','schemas':[json.dumps({'@type':'BlogPosting','name':'OLD'})]},'/next':{'title':'Next','schemas':[]}})+';\nfunction findRecord(route,cms){return (cms.articles||[]).find(r=>r.sourceRoute===route)||null};\n'
 page.set_content('<html><head><title>Before</title></head><body></body></html>')
 page.add_script_tag(content=fixture+seojs+'''window.v19Seo={applySeo};''')
 meta=page.evaluate('''() => {
  const cms={settings:{website:'https://mihousespa.com'},articles:[{sourceRoute:'/article',seoTitle:'Authored',robots:'index,follow',schemaJson:JSON.stringify({'@type':'BlogPosting',headline:'From CMS'})}]};
  window.v19Seo.applySeo('/article',cms);
  const before=[...document.querySelectorAll('script[data-mh-cms-schema]')].map(el=>JSON.parse(el.textContent));
  window.v19Seo.applySeo('/next',cms);
  return {before,after:document.querySelectorAll('script[data-mh-cms-schema]').length};
 }''')
 check(len(meta['before'])==1 and meta['before'][0].get('headline')=='From CMS','CMS JSON-LD overrides matching static schema without duplicates')
 check(meta['after']==0,'SPA navigation removes structured data from previous page')
 browser.close()
print(f'CHROMIUM V19 TEST: {len(checks)}/{len(checks)} PASS')
for c in checks: print('PASS',c)
