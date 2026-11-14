"""Production-aware browser audit. Requires playwright + Chromium on YOUR machine.
Usage: python scripts/audit-production-browser.py --url https://YOUR-PREVIEW.vercel.app --out ./qa-live
Does not log in, write CMS state or send API mutations. Results are evidence, not a fix.
"""
import argparse, json, re, time, os, hashlib, shutil
from pathlib import Path
from urllib.parse import urljoin, urlsplit
from playwright.sync_api import sync_playwright
p=argparse.ArgumentParser()
p.add_argument('--url',required=True);p.add_argument('--out',default='./qa-live')
p.add_argument('--timeout',type=int,default=30000)
p.add_argument('--fixture-html',default='',help='Test harness only; no network and no production metrics')
p.add_argument('--pages',default='/,/gioi-thieu,/dich-vu,/bang-gia,/dao-tao,/album-anh,/tin-tuc,/admin')
a=p.parse_args()
base=a.url.rstrip('/')
if urlsplit(base).scheme not in ('https','http'):raise SystemExit('Use an http(s) URL')
out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
script=r"""
window.__mhMetrics={lcp:0,cls:0,longTasks:0,inp:0};
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__mhMetrics.lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true})}catch(e){}
try{new PerformanceObserver(l=>{for(const e of l.getEntries()){if(!e.hadRecentInput)window.__mhMetrics.cls+=e.value}}).observe({type:'layout-shift',buffered:true})}catch(e){}
try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__mhMetrics.longTasks+=e.duration}).observe({type:'longtask',buffered:true})}catch(e){}
try{new PerformanceObserver(l=>{for(const e of l.getEntries()){if(e.interactionId>0)window.__mhMetrics.inp=Math.max(window.__mhMetrics.inp,e.duration)}}).observe({type:'event',durationThreshold:16,buffered:true})}catch(e){}
"""
results=[]
with sync_playwright() as play:
 browser=play.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome') or None,args=['--no-sandbox','--disable-dev-shm-usage'])
 for viewport in [{'width':1440,'height':900},{'width':390,'height':844}]:
  for route in (x.strip() for x in a.pages.split(',') if x.strip()):
   page=browser.new_page(viewport=viewport,device_scale_factor=1)
   page.add_init_script(script)
   errors=[];failures=[]
   page.on('pageerror',lambda exc:errors.append(str(exc)[:250]))
   page.on('requestfailed',lambda req:failures.append({'url':req.url[:200],'failure':req.failure}))
   url=base+route if route.startswith('/') else urljoin(base+'/',route)
   rec={'path':route,'viewport':str(viewport['width'])+'x'+str(viewport['height']),'url':url}
   started=time.perf_counter()
   try:
    if a.fixture_html:
     page.goto('about:blank');page.set_content(Path(a.fixture_html).read_text(encoding='utf8'));res=None
    else:res=page.goto(url,wait_until='domcontentloaded',timeout=a.timeout)
    rec['status']=200 if a.fixture_html else (res.status if res else None)
    rec['domInteractiveWallMs']=round((time.perf_counter()-started)*1000)
    page.wait_for_timeout(1800)
    rec.update(page.evaluate("""() => ({
     metrics:window.__mhMetrics||{},
     nav:(performance.getEntriesByType('navigation')[0]||{}).toJSON?.()||{},
     title:document.title,
     h1:[...document.querySelectorAll('h1')].map(x=>x.textContent.trim()).filter(Boolean).slice(0,8),
     pageHeight:document.documentElement.scrollHeight,
     scrollWidth:document.documentElement.scrollWidth,
     viewWidth:document.documentElement.clientWidth,
     headCanonical:document.querySelector('link[rel=canonical]')?.href||'',
     headRobots:document.querySelector('meta[name=robots]')?.content||'',
     scriptSchemas:document.querySelectorAll('script[type="application/ld+json"]').length,
     resourceTotal:performance.getEntriesByType('resource').length,
     totalTransferKb:Math.round(performance.getEntriesByType('resource').reduce((n,x)=>n+(x.transferSize||0),0)/1024),
    })"""))
    # HTML source is distinct from dynamically modified SPA DOM.
    html=Path(a.fixture_html).read_text(encoding='utf8') if a.fixture_html else (res.text() if res else '')
    head=html.split('</head>',1)[0]
    title=re.search(r'<title[^>]*>(.*?)</title>',head,re.I|re.S)
    meta=re.search(r'<meta\s+name=["\']description["\'][^>]*content=["\']([^"\']+)',head,re.I|re.S)
    rec['httpHtmlTitle']=re.sub(r'\s+',' ',title.group(1)).strip() if title else ''
    rec['httpMetaDescription']=meta.group(1).strip() if meta else ''
    rec['httpHasArticleMarkup']='class="news-detail"' in html or 'itemprop="articleBody"' in html
    rec['httpHasJsonLd']='application/ld+json' in head
    name='page-'+hashlib.md5((route+str(viewport['width'])).encode()).hexdigest()[:10]+'.png'
    page.screenshot(path=str(out/name),full_page=False,timeout=10000)
    rec['screenshot']=name
   except Exception as error:rec['error']=str(error)[:400]
   rec['consoleErrors']=errors[:8];rec['failedRequests']=failures[:12]
   results.append(rec);page.close()
 browser.close()
(out/'production-audit.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
lines=['# Mi House production browser audit','',f'Base URL: `{base}`','',
       'This measures a public deployment. LCP/CLS estimates are from lab Chromium; INP requires representative interaction/field data.','',
       '| URL | Viewport | HTTP | LCP lab (ms) | CLS lab | Transfer KB | JS errors | HTML title |','|---|---|---:|---:|---:|---:|---:|---|']
for r in results:
 m=r.get('metrics') or {};lines.append(f"| {r['path']} | {r['viewport']} | {r.get('status','—')} | {round(m.get('lcp',0)) if m else '—'} | {round(m.get('cls',0),3) if m else '—'} | {r.get('totalTransferKb','—')} | {len(r.get('consoleErrors',[]))} | {(r.get('httpHtmlTitle') or 'MISSING').replace('|','/')} |")
lines+=['','Warnings: Duplicate server HTML titles on different article routes can indicate CSR-only metadata; this is **not** proof of indexability.','']
(out/'production-audit.md').write_text('\n'.join(lines),encoding='utf8')
valid=[r for r in results if r.get('status')]
if not valid:raise SystemExit('BLOCKED: no live page loaded. Check network access or deployment URL; report includes errors.')
print('Completed',len(valid),'/',len(results),'route x viewport checks. Report:',out/'production-audit.md')
