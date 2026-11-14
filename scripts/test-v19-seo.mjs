import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
process.env.ADMIN_USERNAME='admin';process.env.ADMIN_PASSWORD='test-v19-only-secret';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mh-v19-seo-'));
process.env.CMS_DB_PATH=path.join(dir,'content.json');
process.env.CMS_STATS_PATH=path.join(dir,'stats.json');
const {createServer}=await import('../server/index.mjs');
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const headers={'X-CMS-Request':'1'};let cookie='';let passed=0;
async function read(route,opts={}){
 const res=await fetch(url+route,{...opts,headers:{...headers,...(cookie?{Cookie:cookie}:{}),...opts.headers}});
 const text=await res.text();return {res,text,json:()=>JSON.parse(text)};
}
try{
 let r=await read('/api/sitemap.xml');assert.equal(r.res.status,200);assert.match(r.res.headers.get('content-type'),/xml/);passed++;
 assert.match(r.text,/<urlset/);assert(r.text.includes('/gioi-thieu'));assert(!r.text.includes('/admin'));passed++;
 const article='/mi-house-spa-khong-gian-goi-dau-duong-sinh-amp-massage-am-cung-tai-quang-trung-go-vap';
 assert(r.text.includes(article));passed++;
 r=await read('/api/robots.txt');assert.match(r.text,/Disallow: \/admin/);assert.match(r.text,/Sitemap: https:\/\/mihousespa\.com\/sitemap\.xml/);passed++;
 r=await read('/api/admin/login',{method:'POST',body:JSON.stringify({username:'admin',password:'test-v19-only-secret'}),headers:{'Content-Type':'application/json'}});
 assert.equal(r.res.status,200);cookie=r.res.headers.get('set-cookie')?.split(';')[0];passed++;
 r=await read('/api/admin/state');const db=r.json();const articleRow=db.articles.find(row=>row.sourceRoute===article);assert(articleRow);passed++;
 articleRow.status='draft';r=await read('/api/admin/state',{method:'PUT',body:JSON.stringify(db),headers:{'Content-Type':'application/json'}});assert.equal(r.res.status,200);passed++;
 r=await read('/api/sitemap.xml');assert(!r.text.includes(article),'Draft article should immediately leave sitemap');passed++;
 r=await read('/api/robots.txt');assert.equal(r.res.status,200);passed++;
 // A published article with explicit noindex must also leave the sitemap;
 // switching robots settings must not require a fresh deployment.
 const db2=(await read('/api/admin/state')).json();
 const other=db2.articles.find(row=>row.sourceRoute&&row.sourceRoute!==article);
 assert(other);other.robots='noindex,nofollow';
 r=await read('/api/admin/state',{method:'PUT',body:JSON.stringify(db2),headers:{'Content-Type':'application/json'}});assert.equal(r.res.status,200);passed++;
 r=await read('/api/sitemap.xml');assert(!r.text.includes(other.sourceRoute),'Noindex articles must be excluded from sitemap');passed++;
 console.log(`SEO HTTP V19: ${passed}/${passed} PASS`);
}catch(e){console.error('SEO HTTP V19 FAIL:',e);process.exitCode=1}finally{server.close();fs.rmSync(dir,{recursive:true,force:true})}
