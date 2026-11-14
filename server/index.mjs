import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createPersistence,StorageConflict,StorageUnavailable} from './redis.mjs';
import routeManifest from '../src/routeManifest.json' with {type:'json'};
import { fileURLToPath } from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function loadDotEnv(){if(process.env.VERCEL)return;const p=path.join(ROOT,'.env');if(!fs.existsSync(p))return;for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){const m=line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}}
loadDotEnv();
// Cloudinary also documents CLOUDINARY_URL=cloudinary://KEY:SECRET@CLOUD_NAME.
// Parse exclusively on the server. Never return these values from an API.
function initializeCloudinaryFromUrl(){
 if(!process.env.CLOUDINARY_URL)return;
 try{
  const u=new URL(process.env.CLOUDINARY_URL);
  if(u.protocol!=='cloudinary:'||!u.hostname||!u.username||!u.password)throw Error('bad URL');
  process.env.CLOUDINARY_CLOUD_NAME ||= decodeURIComponent(u.hostname);
  process.env.CLOUDINARY_API_KEY ||= decodeURIComponent(u.username);
  process.env.CLOUDINARY_API_SECRET ||= decodeURIComponent(u.password);
 }catch{console.warn('[CMS] CLOUDINARY_URL không hợp lệ. Kiểm tra .env (không ghi khóa ra log).')}
}
initializeCloudinaryFromUrl();
const PORT=Number(process.env.CMS_PORT||5551),DB=process.env.CMS_DB_PATH?path.resolve(process.env.CMS_DB_PATH):path.join(ROOT,'server/data/content.json'),UPLOAD=process.env.CMS_UPLOAD_PATH?path.resolve(process.env.CMS_UPLOAD_PATH):path.join(ROOT,'public/uploads');
const DEFAULT={version:1,settings:{brand:'Mi House Spa',description:'Gội đầu dưỡng sinh - Massage body - Nail',phone:'0767882407',email:'nguyenquynhdiem1988@gmail.com',website:'https://mihousespa.com',address:'43 đường Quang Trung, phường Gò Vấp, Thành phố Hồ Chí Minh',logo:'',favicon:'',facebook:'https://www.facebook.com/mihousespa/',tiktok:'',contactLink:'https://zalo.me/0767882407',bookingLink:'https://zalo.me/0767882407',slide1Link:'',slide2Link:'',trainingNailTitle:'Đào tạo Nail',trainingNailImage:'',trainingHairTitle:'Đào tạo Gội đầu',trainingHairImage:'',trainingMassageTitle:'Đào tạo Massage',trainingMassageImage:'',maps:'https://maps.app.goo.gl/FGYh7DnPTGSz6qNc8',mapEmbed:'',primary:'#8f624a',background:'#f8f3ed',reducedMotion:false},overrides:{},blocks:{},articles:[],services:[],training:[],albumCategories:[],albumItems:[],sections:{},sectionsInitialized:false,recordGroupsInitialized:false,prices:[],media:[],mediaMap:{},pageMeta:{},navigation:[],collections:{nail:[],space:[],menu:[],videos:[],slides:[]},mediaGarbage:[],collectionsInitialized:false,articlesInitialized:false,revision:0};
const DEFAULT_SEED=(()=>{try{const filename=process.env.CMS_DB_PATH?DB:path.join(ROOT,'server/seed-content.json');return {...structuredClone(DEFAULT),...JSON.parse(fs.readFileSync(filename,'utf8'))}}catch{return structuredClone(DEFAULT)}})();
const storage=createPersistence({dbPath:DB,statsPath:process.env.CMS_STATS_PATH?path.resolve(process.env.CMS_STATS_PATH):path.join(ROOT,'server/data/analytics.json'),seed:DEFAULT_SEED});
const context=new AsyncLocalStorage();
function current(){const c=context.getStore();if(!c)throw Error('Database context unavailable');return c;}
const db=new Proxy({}, {
 get(_target,key){return current().data[key]},
 set(_target,key,value){current().data[key]=value;return true},
 ownKeys(){return Reflect.ownKeys(current().data)},
 getOwnPropertyDescriptor(_target,key){return Object.getOwnPropertyDescriptor(current().data,key)||{configurable:true,enumerable:true,writable:true,value:undefined}},
 has(_target,key){return key in current().data}
});
// One-time migration: original images, slides, videos and eleven published HTML articles
// become normal CMS records. Deleting the last item must NEVER regenerate it.
async function migrateOriginalContent(){
 let dirty=false;
 const seed=JSON.parse(fs.readFileSync(path.join(ROOT,'src/cms/initialContent.json'),'utf8'));
 if(!db.collectionsInitialized){
  db.collections ||= {};
  for(const key of ['nail','space','menu','videos','slides']){
   const current=db.collections[key]||[];
   const existing=new Set(current.map(r=>r.id));
   db.collections[key]=[...seed.collections[key].filter(r=>!existing.has(r.id)),...current];
  }
  db.collectionsInitialized=true;dirty=true;
 }
 if(!db.articlesInitialized){
  const current=db.articles||[];const existing=new Set(current.map(a=>a.slug));
  db.articles=[...seed.articles.filter(a=>!existing.has(a.slug)),...current];
  db.articlesInitialized=true;dirty=true;
 }
 if(!db.sectionsInitialized){
  db.sections={...seed.sections,...(db.sections||{})};
  db.albumCategories=(db.albumCategories?.length?db.albumCategories:seed.albumCategories);
  db.albumItems ||= [];
  db.sectionsInitialized=true;dirty=true;
 }
 if(!db.recordGroupsInitialized){
  const merge=(current,defaults)=>{
   const existing=new Set(current.map(x=>x.sourceRoute||x.slug));
   return [...defaults.filter(x=>!existing.has(x.sourceRoute||x.slug)),...current];
  };
  db.services=merge(db.services||[],seed.services);
  db.training=merge(db.training||[],seed.training);
  // Existing content retains its authored fields. Only fill absent source body.
  db.articles=(db.articles||[]).map(row=>{
    const original=seed.articles.find(x=>x.slug===row.slug);
    return original&&row.body===''&&!row.bodyEdited?{...original,...row,body:original.body}:row;
  });
  db.recordGroupsInitialized=true;dirty=true;
 }
 if(dirty)await save();
}

async function save(){const c=current();c.version=await storage.save(c.data,c.version);}
function send(res,code,data,headers={}){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(data));}
function sendXml(res,content,type='application/xml; charset=utf-8'){
 res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
 res.end(content);
}
function canonicalOrigin(){
 const candidate=String(db.settings?.website||'https://mihousespa.com').trim();
 try {const u=new URL(candidate);return u.protocol==='https:'?u.origin:'https://mihousespa.com'}catch{return 'https://mihousespa.com'}
}
const xmlEscape=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function publicSitemap(){
 const origin=canonicalOrigin();
 const rows=[...(db.articles||[]).map(row=>({...row,_group:'tin-tuc'})),...(db.services||[]).map(row=>({...row,_group:'dich-vu'})),...(db.training||[]).map(row=>({...row,_group:'dao-tao'}))];
 const isIndexable=row=>!row.deleted&&row.status!=='draft'&&!/\bnoindex\b/i.test(String(row.robots||row.metaRobots||''));
 const published=rows.filter(isIndexable);
 const hidden=new Set(rows.filter(row=>!isIndexable(row)).map(row=>row.sourceRoute).filter(Boolean));
 const paths=new Map();
 for(const path of Object.keys(routeManifest)){
  if(!path.startsWith('/')||path.includes('?')||path==='/lien-he'||path.startsWith('/admin')||hidden.has(path))continue;
  paths.set(path,null);
 }
 for(const item of published){
  const url=item.sourceRoute&&item.sourceRoute.startsWith('/')?item.sourceRoute:item.slug?`/${item._group}/${item.slug}`:'';
  if(!url||url.includes('?')||url.includes('#'))continue;
  const validDate=String(item.updatedAt||item.modifiedAt||item.dateModified||'').slice(0,10);
  paths.set(url,/^\d{4}-\d{2}-\d{2}$/.test(validDate)?validDate:null);
 }
 for(const item of (db.albumCategories||[]).filter(row=>!row.deleted&&row.status!=='draft'&&row.slug)){
  const url=item.id==='nail'?'/nail-hottrend':item.id==='space'?'/khong-gian':'/album/'+item.slug;
  paths.set(url,null);
 }
 const entries=[...paths.entries()].sort(([a],[b])=>a.localeCompare(b));
 return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'+entries.map(([pathname,lastmod])=>`  <url><loc>${xmlEscape(origin+pathname)}</loc>${lastmod?`<lastmod>${lastmod}</lastmod>`:''}</url>`).join('\n')+'\n</urlset>';
}

function cookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
async function authed(req){return storage.hasSession(cookie(req,'mh_admin'));}
function requestAllowed(req){if(req.method==='GET'||req.method==='HEAD')return true;const origin=req.headers.origin;if(origin){try{const u=new URL(origin);const h=(req.headers.host||'').split(':')[0];if(u.hostname!==h&&!(u.hostname==='localhost'&&h==='127.0.0.1')&&!(u.hostname==='127.0.0.1'&&h==='localhost'))return false;}catch{return false}}return req.headers['x-cms-request']==='1';}
async function body(req,max=5*1024*1024){if(req.body!==undefined&&req.body!==null){const bytes=Buffer.isBuffer(req.body)?req.body:typeof req.body==='string'?Buffer.from(req.body):Buffer.from(JSON.stringify(req.body));if(bytes.length>max){const e=new Error('Dữ liệu vượt giới hạn');e.code=413;throw e;}return bytes;}let bytes=0;const chunks=[];for await (const c of req){bytes+=c.length;if(bytes>max){const e=new Error('Tập tin/dữ liệu vượt giới hạn');e.code=413;throw e}chunks.push(c)}return Buffer.concat(chunks)}
async function json(req){const raw=await body(req);return JSON.parse(raw.toString('utf8')||'{}')}
const safeText=(v,max=30000)=>typeof v==='string'?v.slice(0,max):'';
// Constant-time string comparison so the admin username cannot be probed
// by measuring how long the rejection takes.
function timingSafeEqualText(a,b){
 const x=Buffer.from(String(a),'utf8'),y=Buffer.from(String(b),'utf8');
 const len=Math.max(x.length,y.length,1);
 const pad=buf=>{const out=Buffer.alloc(len);buf.copy(out);return out};
 return crypto.timingSafeEqual(pad(x),pad(y))&&x.length===y.length;
}
const safeUrl=(v)=>{if(typeof v!=='string'||v.length>3000)return '';if(v.startsWith('/')&&!v.startsWith('//'))return v;try{const u=new URL(v);return ['https:','http:','tel:','mailto:'].includes(u.protocol)?u.href:''}catch{return ''}};
function safeDb(x){const out=structuredClone(DEFAULT);if(!x||typeof x!=='object')return out;
 if(x.settings&&typeof x.settings==='object')for(const key of Object.keys(out.settings)){const v=x.settings[key];if(typeof out.settings[key]==='boolean')out.settings[key]=Boolean(v);else if(typeof v==='string')out.settings[key]=v.slice(0,2000)}
 if(x.overrides&&typeof x.overrides==='object'){for(const [route,records] of Object.entries(x.overrides).slice(0,150)){if(!/^(?:\/[\w\-/?=&%]*|@navigation|@footer)$/.test(route)||!records||typeof records!=='object')continue;out.overrides[route]={};for(const [key,value] of Object.entries(records).slice(0,900)){if(!/^(?:\d{1,5}|[a-z][a-z0-9-]{0,63})$/.test(key)||!value||typeof value!=='object')continue;out.overrides[route][key]={text:safeText(value.text,20000),src:safeUrl(value.src),href:safeUrl(value.href),hidden:Boolean(value.hidden),alt:safeText(value.alt,300),editText:Boolean(value.editText),editSrc:Boolean(value.editSrc),editHref:Boolean(value.editHref)};}}}
 for(const field of ['blocks','pageMeta','sections'])if(x[field]&&typeof x[field]==='object'&&!Array.isArray(x[field]))out[field]=x[field];
 if(x.collections&&typeof x.collections==='object'){for(const key of ['nail','space','menu','videos','slides'])if(Array.isArray(x.collections[key]))out.collections[key]=x.collections[key].slice(0,500).map(row=>({...row,id:safeText(row.id,90),title:safeText(row.title,300),description:safeText(row.description,20000),image:safeUrl(row.image),full:safeUrl(row.full),video:safeUrl(row.video),href:safeUrl(row.href),alt:safeText(row.alt,500),categoryId:safeText(row.categoryId,90),slug:safeText(row.slug,160),order:Number.isFinite(Number(row.order))?Number(row.order):0,featured:Boolean(row.featured),status:row.status==='draft'?'draft':'published'}));}
 out.media=db.media;out.mediaMap=db.mediaMap;out.mediaGarbage=db.mediaGarbage||[];out.collectionsInitialized=Boolean(db.collectionsInitialized);out.articlesInitialized=Boolean(db.articlesInitialized);out.sectionsInitialized=Boolean(db.sectionsInitialized);out.recordGroupsInitialized=Boolean(db.recordGroupsInitialized);out.revision=Number(db.revision||0);
 for(const field of ['articles','services','training','albumCategories','albumItems','prices','navigation'])if(Array.isArray(x[field]))out[field]=x[field].slice(0,2000);
 out.version=Number(x.version||1);return out;}
// A legacy client may still send an array with rows physically removed.
// Convert that omission into a recoverable tombstone instead of losing data.
// Permanent deletion is deliberately a separate authenticated endpoint.
const TRASH_GROUPS=new Set(['articles','services','training','albumCategories','albumItems','albumPhotos','nail','space','menu','slides','videos']);
function reconcileSoftDeletes(next,previous){
 const currentPhotoIds=new Set([...(next.albumItems||[]),...(next.collections?.nail||[]),...(next.collections?.space||[])].map(x=>String(x.id)));
 for(const key of TRASH_GROUPS){
  if(key==='albumPhotos')continue; // virtual view of three physical photo lists
  const isCollection=['nail','space','menu','slides','videos'].includes(key);
  const source=isCollection?previous.collections?.[key]:previous[key];
  const list=isCollection?(next.collections[key]||=[]):(next[key]||=[]);
  if(!Array.isArray(source))continue;
  const known=new Set(list.map(x=>String(x.id)));
  for(const row of source){
   if(!row||!row.id||known.has(String(row.id)))continue;
   if(['nail','space','albumItems'].includes(key)&&currentPhotoIds.has(String(row.id)))continue;
   list.push({...row,previousStatus:row.previousStatus||row.status||'published',status:'draft',deleted:true,deletedAt:row.deletedAt||new Date().toISOString()});
  }
 }
 for(const key of ['articles','services','training','albumCategories','albumItems']){
  for(const row of next[key]||[]){row.status=row.deleted||row.status==='draft'?'draft':'published';row.featured=Boolean(row.featured);}
 }
 for(const key of ['nail','space','menu','slides','videos']){
  for(const row of next.collections?.[key]||[]){row.status=row.deleted||row.status==='draft'?'draft':'published';row.featured=Boolean(row.featured);}
 }
 return next;
}
function rawTrashGroup(data,tab){
 const collections=['nail','space','menu','slides','videos'];
 if(tab==='albumPhotos')return [...(data.collections?.nail||[]),...(data.collections?.space||[]),...(data.albumItems||[])];
 return collections.includes(tab)?data.collections?.[tab]:data[tab];
}
function physicalTrashGroup(data,tab,id){
 if(tab==='albumPhotos')return [data.collections?.nail,data.collections?.space,data.albumItems].find(list=>Array.isArray(list)&&list.some(row=>String(row.id)===String(id)))||null;
 return rawTrashGroup(data,tab);
}
function credentialsReady(){return Boolean(process.env.CLOUDINARY_CLOUD_NAME&&process.env.CLOUDINARY_API_KEY&&process.env.CLOUDINARY_API_SECRET&&process.env.CLOUDINARY_API_SECRET!=='PASTE_SECRET_HERE')}
// List real Cloudinary assets using server-side Admin API cursor pagination.
// Limit scope to this application's folder so unrelated Cloudinary assets stay private.
async function listCloudinaryAssets(kind,cursor='',search=''){
 const cloud=process.env.CLOUDINARY_CLOUD_NAME;
 const key=Buffer.from(`${process.env.CLOUDINARY_API_KEY}:${process.env.CLOUDINARY_API_SECRET}`).toString('base64');
 let url,options={headers:{Authorization:'Basic '+key,Accept:'application/json'},signal:AbortSignal.timeout(15000)};
 if(search){
  // Cloudinary Search API searches the entire folder, not only the currently
  // loaded page. Never concatenate raw user input into a Lucene expression.
  const terms=search.normalize('NFC').split(/\s+/).map(part=>part.replace(/[^\p{L}\p{N}]/gu,'')).filter(Boolean).slice(0,5);
  if(!terms.length)return {kind,scope:'mi-house/',items:[],nextCursor:null};
  const filter=terms.map(part=>`filename:${part.slice(0,35)}*`).join(' AND ');
  const expression=`type:upload AND resource_type:${kind} AND public_id:mi-house/* AND (${filter})`;
  url=new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/search`);
  options={...options,method:'POST',headers:{...options.headers,'Content-Type':'application/json'},body:JSON.stringify({expression,max_results:18,...(cursor?{next_cursor:cursor}:{})})};
 }else{
  url=new URL(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/${kind}/upload`);
  url.searchParams.set('prefix','mi-house/');url.searchParams.set('max_results','18');
  if(cursor)url.searchParams.set('next_cursor',cursor);
 }
 const response=await fetch(url,options);
 const payload=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(`Không thể tải danh sách Cloudinary: ${payload.error?.message||response.status}`);
 return {kind,scope:'mi-house/',items:(payload.resources||[]).filter(x=>String(x.public_id||'').startsWith('mi-house/')&&!db.media.some(m=>m.deleted&&m.publicId===x.public_id&&m.resourceType===kind)).map(asset=>{
  const tracked=(db.media||[]).find(x=>!x.deleted&&x.publicId===asset.public_id&&x.resourceType===kind);
  return {id:tracked?.id||null,managed:!!tracked,name:tracked?.name||String(asset.public_id).split('/').pop(),
   publicId:asset.public_id,resourceType:kind,url:asset.secure_url||tracked?.url||'',
   width:asset.width||null,height:asset.height||null,createdAt:asset.created_at||null};
 }),nextCursor:payload.next_cursor||null};
}
// Browser uploads media directly to Cloudinary. No video is proxied through
// Vercel's small Function request body. The signature is generated on server.
function signedCloudinaryUpload(filename){
 const timestamp=Math.floor(Date.now()/1000),publicId='mi-house/'+timestamp+'-'+crypto.randomBytes(9).toString('hex');
 const signature=crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${process.env.CLOUDINARY_API_SECRET}`).digest('hex');
 return {uploadUrl:`https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/auto/upload`,timestamp,publicId,signature,apiKey:process.env.CLOUDINARY_API_KEY};
}
async function verifyUploadedCloudinary(publicId,kind){
 const cloud=process.env.CLOUDINARY_CLOUD_NAME;
 if(!/^mi-house\/[a-zA-Z0-9_\-]{3,100}$/.test(publicId)||!['image','video'].includes(kind))throw Object.assign(Error('Tài nguyên không nằm trong thư mục được quản lý'),{status:400});
 const endpoint=`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/resources/${kind}/upload/${publicId.split('/').map(encodeURIComponent).join('/')}`;
 const authorization='Basic '+Buffer.from(process.env.CLOUDINARY_API_KEY+':'+process.env.CLOUDINARY_API_SECRET).toString('base64');
 const result=await fetch(endpoint,{headers:{Authorization:authorization},signal:AbortSignal.timeout(15000)});
 if(!result.ok)throw Object.assign(Error('Không xác minh được ảnh/video trên Cloudinary'),{status:422});
 const item=await result.json();
 if(item.public_id!==publicId||item.resource_type!==kind||item.type!=='upload'||!String(item.secure_url||'').startsWith('https://res.cloudinary.com/'))throw Object.assign(Error('Cloudinary trả dữ liệu không hợp lệ'),{status:422});
 return {url:item.secure_url,publicId:item.public_id,resourceType:item.resource_type,width:item.width||null,height:item.height||null};
}
async function uploadCloudinary(data,filename,remoteUrl){const cloud=process.env.CLOUDINARY_CLOUD_NAME,apiKey=process.env.CLOUDINARY_API_KEY,secret=process.env.CLOUDINARY_API_SECRET;
 const timestamp=Math.floor(Date.now()/1000),publicId='mi-house/'+Date.now()+'-'+crypto.randomBytes(5).toString('hex');
 const toSign=`public_id=${publicId}&timestamp=${timestamp}${secret}`;
 const signature=crypto.createHash('sha1').update(toSign).digest('hex');
 const form=new FormData();form.set('timestamp',String(timestamp));form.set('public_id',publicId);form.set('api_key',apiKey);form.set('signature',signature);
 if(remoteUrl)form.set('file',remoteUrl);else form.set('file',new Blob([data],{type:detectMime(filename)}),filename);
 const result=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/auto/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
 const resp=await result.json();if(!result.ok||!resp.secure_url)throw Error(resp.error?.message||'Cloudinary upload failed');return {url:resp.secure_url,publicId:resp.public_id,resourceType:resp.resource_type,width:resp.width,height:resp.height};}
async function destroyCloudinary(item){
 if(!item?.publicId||!credentialsReady()||item.publicId.startsWith('local/'))return;
 const cloud=process.env.CLOUDINARY_CLOUD_NAME, apiKey=process.env.CLOUDINARY_API_KEY,secret=process.env.CLOUDINARY_API_SECRET;
 const timestamp=Math.floor(Date.now()/1000), publicId=item.publicId;
 const signature=crypto.createHash('sha1').update(`invalidate=true&public_id=${publicId}&timestamp=${timestamp}${secret}`).digest('hex');
 const form=new FormData();form.set('public_id',publicId);form.set('timestamp',String(timestamp));form.set('invalidate','true');form.set('api_key',apiKey);form.set('signature',signature);
 const resourceType=item.resourceType==='video'?'video':'image';
 const response=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/${resourceType}/destroy`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
 const obj=await response.json();if(!response.ok||!['ok','not found'].includes(obj.result))throw Error(obj.error?.message||`Cloudinary không xóa được (${obj.result||response.status})`);
}
function mediaUsageCount(value,oldUrl){
 if(typeof value==='string')return value.includes(oldUrl)?1:0;
 if(Array.isArray(value))return value.reduce((count,v)=>count+mediaUsageCount(v,oldUrl),0);
 if(value&&typeof value==='object')return Object.values(value).reduce((count,v)=>count+mediaUsageCount(v,oldUrl),0);
 return 0;
}
function referencesOf(url){
 if(!url)return 0;
 return ['settings','overrides','blocks','articles','services','training','sections','albumCategories','albumItems','prices','collections','pageMeta','navigation','mediaMap'].reduce((n,k)=>n+mediaUsageCount(db[k],url),0);
}
// Every media URL owned by a CMS record (bảng giá, ảnh album, tin tức...).
// Used to delete the Cloudinary asset together with its owning record.
const RECORD_MEDIA_FIELDS=['image','full','video','src','cover','displayImage','homeImage'];
function collectRecordUrls(source){
 const found=new Set();
 const visit=(value,key)=>{
  if(typeof value==='string'){if(RECORD_MEDIA_FIELDS.includes(key)&&value)found.add(value);return}
  if(Array.isArray(value)){for(const v of value)visit(v,key);return}
  if(value&&typeof value==='object'){for(const [k,v] of Object.entries(value))visit(v,k)}
 };
 for(const group of ['articles','services','training','albumCategories','albumItems','prices','collections','sections'])visit(source[group],'image');
 visit(source.settings,'image');
 return found;
}
function swapMediaReferences(oldUrl,newUrl){
 const replace=value=>{
  if(typeof value==='string')return value.includes(oldUrl)?value.split(oldUrl).join(newUrl):value;
  if(Array.isArray(value))return value.map(replace);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));
  return value;
 };
 for(const key of ['settings','overrides','blocks','articles','services','training','sections','albumCategories','albumItems','prices','collections','pageMeta','navigation','mediaMap'])db[key]=replace(db[key]);
}
async function recordMediaGarbage(item){
 if(!item?.publicId)return;
 try{await destroyCloudinary(item)}catch(error){
  db.mediaGarbage ||= [];
  if(!db.mediaGarbage.some(x=>x.publicId===item.publicId))db.mediaGarbage.push({publicId:item.publicId,resourceType:item.resourceType,recordedAt:new Date().toISOString()});
  console.warn('[CMS] Pending old Cloudinary cleanup:',error.message);
 }
}
function validMediaBytes(data,mime){
 if(!data||data.length<12)return false;
 if(mime==='image/png')return data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(mime==='image/jpeg')return data[0]===255&&data[1]===216&&data[2]===255;
 if(mime==='image/gif')return data.subarray(0,4).toString('ascii')==='GIF8';
 if(mime==='image/webp')return data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP';
 if(mime==='image/avif')return data.subarray(4,12).toString('ascii').includes('ftypavif')||data.subarray(4,16).toString('ascii').includes('ftypavis');
 if(mime==='video/webm')return data.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
 if(mime==='video/mp4'||mime==='video/quicktime')return data.subarray(4,8).toString('ascii')==='ftyp';
 return false;
}
function detectMime(name){const ext=path.extname(name).toLowerCase();return {'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'}[ext]||'application/octet-stream';}
// First-party pageview counters. Data are recorded by THIS API, not copied from
// the reference HTML. The private IP leaderboard is available to logged-in admins.
const STATS=process.env.CMS_STATS_PATH?path.resolve(process.env.CMS_STATS_PATH):path.join(ROOT,'server/data/analytics.json');
let stats={days:{}};
try{stats=JSON.parse(fs.readFileSync(STATS,'utf8'))}catch{}
const recentViews=new Map();
const hcmDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function detectBrowser(ua){if(/Edg\//i.test(ua))return 'Microsoft Edge';if(/OPR\//i.test(ua))return 'Opera';if(/Firefox\//i.test(ua))return 'Firefox';if(/Chrome\//i.test(ua))return 'Google Chrome';if(/Safari\//i.test(ua))return 'Safari';return 'Unknown'}
function detectDevice(ua){if(/iPad|Tablet|Android(?!.*Mobile)/i.test(ua))return 'Tablet';if(/Mobile|iPhone|Android/i.test(ua))return 'Mobile';return 'Desktop'}
function visitorIP(req){
 // Do not blindly trust X-Forwarded-For supplied directly by clients.
 const raw=process.env.CMS_TRUST_PROXY==='true'?(req.headers['x-forwarded-for']?.split(',')[0]||req.socket.remoteAddress):req.socket.remoteAddress;
 const ip=String(raw||'Unknown').replace(/^::ffff:/,'').trim();return ip.slice(0,60);
}
async function recordView(req,route){
 if(process.env.CMS_ANALYTICS_ENABLED==='false'||req.headers.dnt==='1')return false;
 const ua=String(req.headers['user-agent']||'').slice(0,300);
 if(/bot|crawl|spider|headless|lighthouse|monitor|preview|prerender/i.test(ua))return false;
 if(!route.startsWith('/')||route.startsWith('/admin')||route.startsWith('/api'))return false;
 const ip=visitorIP(req);if(storage.remote)return storage.recordView({ip,ua,route,day:hcmDay(),browser:detectBrowser(ua),device:detectDevice(ua)});const stamp=Date.now();const key=crypto.createHash('sha256').update(ip+'|'+ua+'|'+route).digest('hex');
 if(stamp-(recentViews.get(key)||0)<30000)return false;
 recentViews.set(key,stamp);
 if(recentViews.size>12000)for(const [k,t] of recentViews)if(stamp-t>300000)recentViews.delete(k);
 const day=hcmDay();const rec=stats.days[day]||{total:0,ips:{},browsers:{},devices:{}};
 rec.total++;rec.ips[ip]=(rec.ips[ip]||0)+1;
 const browser=detectBrowser(ua),device=detectDevice(ua);
 rec.browsers[browser]=(rec.browsers[browser]||0)+1;rec.devices[device]=(rec.devices[device]||0)+1;
 stats.days[day]=rec;
 // Keep recent 13 months. Durable only on a persistent Node filesystem.
 const days=Object.keys(stats.days).sort();if(days.length>400)for(const old of days.slice(0,days.length-400))delete stats.days[old];
 fs.mkdirSync(path.dirname(STATS),{recursive:true});const tmp=STATS+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(stats));fs.renameSync(tmp,STATS);return true;
}
function analyticsSummary(month,year){
 const prefix=`${year}-${String(month).padStart(2,'0')}-`;
 const days=Array.from({length:new Date(year,month,0).getDate()},(_,i)=>({day:i+1,count:0}));
 const ips={},browsers={},devices={};let total=0;
 for(const [date,entry] of Object.entries(stats.days)){
  if(!date.startsWith(prefix))continue;
  const day=Number(date.slice(-2));if(days[day-1])days[day-1].count+=Number(entry.total||0);
  total+=Number(entry.total||0);
  for(const [field,dest] of [['ips',ips],['browsers',browsers],['devices',devices]])for(const [label,count] of Object.entries(entry[field]||{}))dest[label]=(dest[label]||0)+Number(count||0);
 }
 const top=obj=>Object.entries(obj).sort((a,b)=>b[1]-a[1]).map(([label,count])=>({label,count,percent:total?Math.round(count*10000/total)/100:0}));
 return {month,year,total,days,ips:top(ips).slice(0,10),browsers:top(browsers),devices:top(devices),updatedAt:new Date().toISOString(),source:'first-party-cms',retentionDays:400};
}
async function handler(req,res){const u=new URL(req.url,'http://localhost');const pathname=u.pathname;
 try{
 if(pathname==='/api/sitemap.xml'&&req.method==='GET')return sendXml(res,publicSitemap());
 if(pathname==='/api/robots.txt'&&req.method==='GET')return sendXml(res,`User-agent: *\nDisallow: /admin\nSitemap: ${canonicalOrigin()}/sitemap.xml\n`,'text/plain; charset=utf-8');
 if(pathname==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,cloudinaryReady:credentialsReady(),adminConfigured:!!process.env.ADMIN_PASSWORD,adminUsernameConfigured:Boolean(process.env.ADMIN_USERNAME),redisReady:storage.remote});
 if(pathname==='/api/analytics/pageview'&&req.method==='POST'){
  if(!requestAllowed(req))return send(res,403,{error:'Yêu cầu không hợp lệ'});
  const payload=await json(req);const route=safeText(payload.route,240);
  if(!/^\/[\w\-\/]*$/.test(route))return send(res,400,{error:'Đường dẫn không hợp lệ'});
  return send(res,200,{ok:true,recorded:await recordView(req,route)});
 }
 if(pathname==='/api/public'&&req.method==='GET'){
  // Conditional requests avoid transferring the full CMS snapshot each time
  // the SPA regains focus. Redis is still checked for the current revision.
  const etag=`W/"mh-public-${Number(db.revision||0)}"`;
  if(req.headers['if-none-match']===etag){res.writeHead(304,{'ETag':etag,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end();return;}
  const visible=rows=>(rows||[]).filter(row=>row&&!row.deleted&&row.status!=='draft');
  const publicCollections=Object.fromEntries(Object.entries(db.collections||{}).map(([key,rows])=>[key,visible(rows)]));
  const noindex=[...db.articles,...db.services,...db.training].filter(row=>row.deleted||row.status==='draft');
  return send(res,200,{settings:db.settings,sections:db.sections,training:visible(db.training),albumCategories:visible(db.albumCategories),albumItems:visible(db.albumItems),overrides:db.overrides,blocks:db.blocks,articles:visible(db.articles),hiddenSourceRoutes:noindex.map(a=>a.sourceRoute).filter(Boolean),services:visible(db.services),prices:visible(db.prices),mediaMap:db.mediaMap,pageMeta:db.pageMeta,navigation:db.navigation,collections:publicCollections,collectionsInitialized:db.collectionsInitialized,articlesInitialized:db.articlesInitialized,revision:db.revision},{'Cache-Control':'no-store','ETag':etag});
 }
 if(!pathname.startsWith('/api/admin/'))return send(res,404,{error:'Không tìm thấy API'});
 if(!requestAllowed(req))return send(res,403,{error:'Yêu cầu khác nguồn hoặc thiếu xác nhận'});
 if(pathname==='/api/admin/login'&&req.method==='POST'){
  if(!process.env.ADMIN_PASSWORD||/^(?:REPLACE_|CHANGE_|PASTE_)/.test(process.env.ADMIN_PASSWORD))return send(res,503,{error:'Cần cấu hình ADMIN_PASSWORD trong .env trên máy chủ'});
  const key=visitorIP(req);const loginFailures=await storage.getFailure(key);
  if(loginFailures>=8)return send(res,429,{error:'Quá nhiều lần đăng nhập sai, thử lại sau 15 phút'});
  const {username,password}=await json(req);
  // Admin username defaults to "admin" so existing deployments keep working.
  const expectedUser=String(process.env.ADMIN_USERNAME||'admin');
  const givenUser=typeof username==='string'?username:'';
  const userOk=timingSafeEqualText(expectedUser,givenUser);
  const expected=crypto.createHash('sha256').update(String(process.env.ADMIN_PASSWORD)).digest(),given=crypto.createHash('sha256').update(typeof password==='string'?password:'').digest();
  const passOk=crypto.timingSafeEqual(expected,given);
  if(!userOk||!passOk){await storage.addFailure(key);return send(res,401,{error:!userOk&&!passOk?'Tài khoản hoặc mật khẩu không đúng':!userOk?'Tài khoản không đúng':'Mật khẩu không đúng'})}
  await storage.clearFailure(key);const token=crypto.randomBytes(32).toString('hex');await storage.createSession(token);
  return send(res,200,{ok:true,username:expectedUser},{'Set-Cookie':`mh_admin=${token}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=28800${req.socket.encrypted||req.headers['x-forwarded-proto']==='https'?'; Secure':''}`});
 }
 if(!await authed(req))return send(res,401,{error:'Chưa đăng nhập hoặc phiên đã hết hạn'});
 if(pathname==='/api/admin/logout'&&req.method==='POST'){await storage.deleteSession(cookie(req,'mh_admin'));return send(res,200,{ok:true},{'Set-Cookie':'mh_admin=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0'});}
 if(pathname==='/api/admin/session'&&req.method==='GET')return send(res,200,{ok:true,cloudinaryReady:credentialsReady()});
 if(pathname==='/api/admin/analytics'&&req.method==='GET'){
  const now=new Date();const month=Number(u.searchParams.get('month')||new Intl.DateTimeFormat('en-US',{month:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(now));
  const year=Number(u.searchParams.get('year')||new Intl.DateTimeFormat('en-US',{year:'numeric',timeZone:'Asia/Ho_Chi_Minh'}).format(now));
  if(!Number.isInteger(month)||month<1||month>12||!Number.isInteger(year)||year<2020||year>2100)return send(res,400,{error:'Tháng/năm không hợp lệ'});
  return send(res,200,storage.remote?await storage.monthSummary(month,year):analyticsSummary(month,year));
 }
 if(pathname==='/api/admin/media-library'&&req.method==='GET'){
  if(!credentialsReady())return send(res,412,{error:'Chưa cấu hình Cloudinary trên backend. Đang hiển thị các tài nguyên đã lưu trong CMS.'});
  const kind=u.searchParams.get('type')||'image',cursor=u.searchParams.get('cursor')||'',search=u.searchParams.get('search')||'';
  if(!['image','video'].includes(kind)||cursor.length>1000||search.length>80)return send(res,400,{error:'Tham số tìm kiếm hoặc phân trang không hợp lệ'});
  return send(res,200,await listCloudinaryAssets(kind,cursor,search.trim()));
 }
 if(pathname==='/api/admin/trash/purge'&&req.method==='POST'){
  const x=await json(req);if(Number(x.revision)!==Number(db.revision||0))return send(res,409,{error:'Dữ liệu đã được chỉnh sửa, vui lòng tải lại Thùng rác.'});
  const items=Array.isArray(x.items)?x.items:[];
  if(items.length<1||items.length>300)return send(res,400,{error:'Danh sách xóa vĩnh viễn không hợp lệ.'});
  // Validate the ENTIRE batch before modifying state to avoid partial deletes.
  for(const {tab,id} of items){
   if(!TRASH_GROUPS.has(tab)||!id)return send(res,400,{error:'Module hoặc ID không hợp lệ.'});
   const list=physicalTrashGroup(db,tab,id);
   if(!Array.isArray(list)||!list.some(row=>String(row.id)===String(id)&&row.deleted))return send(res,409,{error:'Mục không còn trong Thùng rác.'});
   if(tab==='albumCategories'&&[
    ...(db.albumItems||[]).map(row=>({...row,sourceCategory:row.categoryId})),
    ...(db.collections?.nail||[]).map(row=>({...row,sourceCategory:'nail'})),
    ...(db.collections?.space||[]).map(row=>({...row,sourceCategory:'space'}))
   ].some(row=>String(row.sourceCategory)===String(id)&&!items.some(item=>item.id===row.id&&['albumPhotos','albumItems','nail','space'].includes(item.tab))))return send(res,409,{error:'Danh mục còn hình ảnh liên kết (kể cả trong Thùng rác). Hãy xử lý hình ảnh trước.'});
  }
  for(const {tab,id} of items){const list=physicalTrashGroup(db,tab,id);list.splice(list.findIndex(row=>String(row.id)===String(id)),1)}
  db.revision=Number(db.revision||0)+1;await save();
  return send(res,200,{ok:true,count:items.length,revision:db.revision});
 }
 if(pathname==='/api/admin/state'&&req.method==='GET')return send(res,200,db);
 if(pathname==='/api/admin/state'&&req.method==='PUT'){
  const x=await json(req);
  if(Number(x.revision||0)!==Number(db.revision||0))return send(res,409,{error:'Dữ liệu đã được sửa từ một phiên khác. Hãy tải lại trước khi lưu để tránh ghi đè.'});
  // V18: updating CMS data must never physically delete Cloudinary assets.
  // Soft-deleted records retain every URL; asset destruction is only an
  // explicitly authorized permanent-delete operation with reference checking.
  current().data=reconcileSoftDeletes(safeDb(x),db);db.revision=Number(db.revision||0)+1;await save();
  return send(res,200,{ok:true,revision:db.revision,cloudinaryCleaned:0});
 }
 if(pathname==='/api/admin/media-sign'&&req.method==='POST'){
  if(!credentialsReady())return send(res,412,{error:'Chưa cấu hình Cloudinary'});
  const input=await json(req);const name=path.basename(String(input.filename||'').slice(0,160));
  const mime=detectMime(name),size=Number(input.size);
  if(!['image/png','image/jpeg','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime'].includes(mime))return send(res,415,{error:'Định dạng ảnh/video không hợp lệ'});
  if(!Number.isSafeInteger(size)||size<=0||size>100*1024*1024)return send(res,413,{error:'Giới hạn ảnh/video 100 MB'});
  return send(res,200,signedCloudinaryUpload(name));
 }
 if(pathname==='/api/admin/media-register'&&req.method==='POST'){
  if(!credentialsReady())return send(res,412,{error:'Chưa cấu hình Cloudinary'});
  const input=await json(req),publicId=safeText(input.publicId,160),kind=safeText(input.resourceType,16);
  const media=await verifyUploadedCloudinary(publicId,kind);
  const replaceId=safeText(input.replaceId,100),name=path.basename(safeText(input.filename,140)).replace(/[^\w.\-]/g,'_')||'cloudinary-file';
  if(!replaceId){
   const existing=db.media.find(x=>x.publicId===publicId&&x.resourceType===kind);
   if(existing)return send(res,200,existing);
   const item={id:crypto.randomUUID(),name,createdAt:new Date().toISOString(),...media};db.media.unshift(item);
   await save();return send(res,200,item);
  }
  const index=db.media.findIndex(x=>x.id===replaceId);
  if(index<0)return send(res,404,{error:'Không thấy ảnh/video cần thay thế'});
  const old=structuredClone(db.media[index]);
  if(old.publicId===publicId)return send(res,200,old);
  const replacement={...old,...media,name,updatedAt:new Date().toISOString()};
  swapMediaReferences(old.url,media.url);db.media[index]=replacement;
  await save(); // Always persist new references before touching the old asset.
  await recordMediaGarbage(old);
  if(db.mediaGarbage?.length)await save();
  return send(res,200,{...replacement,cleanupPending:Boolean(db.mediaGarbage?.some(x=>x.publicId===old.publicId))});
 }
 if(pathname==='/api/admin/media'&&req.method==='POST'){
  const filename=path.basename(u.searchParams.get('filename')||'photo.webp').replace(/[^\w.\-]/g,'_').slice(0,140);const mime=detectMime(filename);if(mime==='application/octet-stream')return send(res,415,{error:'Chỉ chấp nhận JPG, PNG, WEBP, GIF, AVIF, MP4, WEBM, MOV'});
  const data=await body(req,30*1024*1024);if(!validMediaBytes(data,mime))return send(res,415,{error:'Nội dung tập tin không phù hợp với định dạng hình ảnh/video đã chọn'});
  if(!credentialsReady())return send(res,412,{error:'Chưa cấu hình Cloudinary. Media không được lưu cục bộ để tránh thất lạc khi deploy.'});
  const media=await uploadCloudinary(data,filename);
  const item={id:crypto.randomUUID(),name:filename,createdAt:new Date().toISOString(),...media};db.media.unshift(item);await save();return send(res,200,item);
 }
 if(pathname==='/api/admin/media/usage'&&req.method==='GET'){
  const item=db.media.find(m=>m.id===u.searchParams.get('id'));
  if(!item)return send(res,404,{error:'Không thấy media'});
  return send(res,200,{id:item.id,usages:referencesOf(item.url)});
 }
 if(pathname.startsWith('/api/admin/media/')&&req.method==='PATCH'){
  const id=decodeURIComponent(pathname.slice('/api/admin/media/'.length));
  const index=db.media.findIndex(m=>m.id===id);
  if(index<0)return send(res,404,{error:'Không thấy media'});
  if(!credentialsReady())return send(res,412,{error:'Cần cấu hình Cloudinary để thay thế media'});
  const filename=path.basename(u.searchParams.get('filename')||'replacement.webp').replace(/[^\w.\-]/g,'_').slice(0,140);
  const mime=detectMime(filename);
  if(mime==='application/octet-stream')return send(res,415,{error:'Định dạng tập tin chưa được hỗ trợ'});
  const bytes=await body(req,30*1024*1024);
  if(!validMediaBytes(bytes,mime))return send(res,415,{error:'Nội dung tập tin không khớp định dạng'});
  const old=structuredClone(db.media[index]);
  const uploaded=await uploadCloudinary(bytes,filename);
  const replacement={...old,...uploaded,name:filename,updatedAt:new Date().toISOString()};
  try{
   swapMediaReferences(old.url,uploaded.url);
   db.media[index]=replacement;
   // Persist references BEFORE deleting the old Cloudinary asset.
   await save();
  }catch(error){
   await recordMediaGarbage(uploaded);
   throw error;
  }
  await recordMediaGarbage(old);
  await save();
  return send(res,200,{...replacement,cleanupPending:db.mediaGarbage.some(m=>m.publicId===old.publicId)});
 }
 if(pathname==='/api/admin/media-cleanup'&&req.method==='POST'){
  const pending=[...(db.mediaGarbage||[])];let succeeded=0;
  for(const item of pending){try{const media=db.media.find(x=>x.publicId===item.publicId);if(media&&referencesOf(media.url)>0){db.mediaGarbage=db.mediaGarbage.filter(x=>x.publicId!==item.publicId);continue;}await destroyCloudinary(item);db.media=db.media.filter(x=>x.publicId!==item.publicId);db.mediaGarbage=db.mediaGarbage.filter(x=>x.publicId!==item.publicId);succeeded++;}catch{}}
  await save();return send(res,200,{ok:true,succeeded,remaining:db.mediaGarbage.length});
 }
 if(pathname.startsWith('/api/admin/media/')&&req.method==='DELETE'){
  const id=decodeURIComponent(pathname.slice('/api/admin/media/'.length));
  const item=db.media.find(m=>m.id===id&&!m.deleted);
  if(!item)return send(res,404,{error:'Không tìm thấy tài nguyên'});
  if(referencesOf(item.url)>0)return send(res,409,{error:'File đang được sử dụng trong CMS. Hãy gỡ tham chiếu trước khi đưa vào Thùng rác.'});
  item.deleted=true;item.deletedAt=new Date().toISOString();
  await save();return send(res,200,{ok:true,trashed:true});
 }
 if(pathname==='/api/admin/media-trash'&&req.method==='GET')return send(res,200,{items:db.media.filter(m=>m.deleted)});
 if(pathname==='/api/admin/media-restore'&&req.method==='POST'){
  const x=await json(req);const media=db.media.find(m=>m.id===x.id&&m.deleted);
  if(!media)return send(res,404,{error:'Không tìm thấy file trong Thùng rác'});
  delete media.deleted;delete media.deletedAt;await save();return send(res,200,{ok:true});
 }
 if(pathname==='/api/admin/media-purge'&&req.method==='POST'){
  const x=await json(req);const media=db.media.find(m=>m.id===x.id&&m.deleted);
  if(!media)return send(res,404,{error:'Không tìm thấy file trong Thùng rác'});
  if(referencesOf(media.url)>0)return send(res,409,{error:'File vẫn đang được dùng trong CMS; không thể xóa vĩnh viễn.'});
  // Explicit permanent delete: on cloud failure retain item in trash for retry.
  await destroyCloudinary(media);
  db.media=db.media.filter(m=>m.id!==media.id);
  for(const [url,mapped] of Object.entries(db.mediaMap))if(mapped===media.url)delete db.mediaMap[url];
  await save();return send(res,200,{ok:true,purged:true});
 }
 if(pathname==='/api/admin/media-import'&&req.method==='POST'){
  if(!credentialsReady())return send(res,412,{error:'Cấu hình CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY và CLOUDINARY_API_SECRET trong .env trước'});
  const input=await json(req);const sourceUrl=safeUrl(input.sourceUrl);if(!/^https?:\/\//.test(sourceUrl))return send(res,400,{error:'URL ảnh/video phải dùng HTTP(S)'});
  const media=await uploadCloudinary(null,'remote',sourceUrl);const item={id:crypto.randomUUID(),name:sourceUrl.split('/').pop()?.slice(0,140)||'imported',sourceUrl,createdAt:new Date().toISOString(),...media};db.media.unshift(item);db.mediaMap[sourceUrl]=media.url;await save();return send(res,200,item);
 }
 return send(res,404,{error:'Không tìm thấy chức năng'});
 }catch(error){console.error('[cms]',error.message);return send(res,error.status|| (error.code===413?413:500),{error:error.code===413?'Dữ liệu vượt kích thước cho phép':(error.status===409||error.status===503?error.message:'Máy chủ gặp lỗi: '+error.message.slice(0,150))})}}
export async function handleRequest(req,res){
 try{
  const loaded=await storage.load();
  return await context.run({data:loaded.data,version:loaded.version},async()=>{
   await migrateOriginalContent();
   if(req.method==='OPTIONS')return send(res,405,{error:'Method not allowed'});
   return handler(req,res);
  });
 }catch(error){console.error('[cms setup]',error.message);return send(res,error.status||500,{error:error.status===503?error.message:'Không thể khởi tạo API CMS'});}
}
export function createServer(){return http.createServer((req,res)=>{void handleRequest(req,res)})}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){createServer().listen(PORT,'127.0.0.1',()=>console.log(`[CMS] API http://127.0.0.1:${PORT} | storage: ${storage.remote?'Upstash Redis':'local JSON'} | Cloudinary ${credentialsReady()?'ready':'chưa cấu hình'}`));}
