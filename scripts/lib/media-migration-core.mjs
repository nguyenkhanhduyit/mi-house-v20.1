/** Pure, testable tools for a reversible CMS -> Cloudinary migration. No networking. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export const MEDIA_EXTENSION=/\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)$/i;
export function normalizeLocalMediaUrl(raw){
 if(typeof raw!=='string')return null;
 let value=raw.trim();
 try{if(/^https?:\/\//i.test(value)){const u=new URL(value);if(!['mihousespa.com','www.mihousespa.com'].includes(u.hostname))return null;value=u.pathname;}}catch{return null;}
 if(!value.startsWith('/')||value.startsWith('//')||/[?#]/.test(value))return null;
 try{value=decodeURIComponent(value)}catch{return null;}
 if(value.includes('\\')||value.split('/').some(x=>x==='..'||x==='.')||!MEDIA_EXTENSION.test(value))return null;
 return value;
}
export function collectMediaReferences({db,srcDir,publicDir}){
 const paths=new Map();
 function record(value){const normalized=normalizeLocalMediaUrl(value);if(!normalized)return;
  const filepath=path.resolve(publicDir,'.'+normalized);
  if(!filepath.startsWith(path.resolve(publicDir)+path.sep))return;
  let stats;try{stats=fs.statSync(filepath)}catch{return;}
  if(!stats.isFile()||!stats.size)return;
  const previous=paths.get(normalized);paths.set(normalized,{url:normalized,filepath,size:stats.size,references:(previous?.references||0)+1});
 }
 function walk(node){
  if(typeof node==='string'){
   record(node);
   // HTML body and CSS url() content can contain multiple local paths.
   for(const m of node.matchAll(/(?:https?:\/\/(?:www\.)?mihousespa\.com)?\/(?:upload|thumbs|assets|uploads)\/[^\s"'<>?#)]+?\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)/gi))record(m[0]);
  } else if(Array.isArray(node))node.forEach(walk);
  else if(node&&typeof node==='object')Object.values(node).forEach(walk);
 }
 for(const key of ['settings','overrides','blocks','articles','services','training','albumCategories','albumItems','sections','collections','prices','navigation','pageMeta'])walk(db[key]);
 if(srcDir&&fs.existsSync(srcDir)){
  const scan=folder=>{for(const item of fs.readdirSync(folder,{withFileTypes:true})){
   const full=path.join(folder,item.name);
   if(item.isDirectory())scan(full);
   else if(/\.(?:jsx?|json|css)$/i.test(item.name)){
    const source=fs.readFileSync(full,'utf8');
    for(const m of source.matchAll(/(?:https?:\/\/(?:www\.)?mihousespa\.com)?\/(?:upload|thumbs|assets|uploads)\/[^\s"'<>?#)` )]+?\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|mov)/gi))record(m[0]);
   }
  }};
  scan(srcDir);
 }
 return [...paths.values()].sort((a,b)=>a.url.localeCompare(b.url));
}
export function publicIdForFile(filepath){const buffer=fs.readFileSync(filepath);return 'mi-house/migrated/'+crypto.createHash('sha256').update(buffer).digest('hex').slice(0,32);}
export function migrationPatch(db,url,asset){
 const current=db.mediaMap?.[url];if(current&&current!==asset.url)return {changed:false,reason:'already-mapped-to-another-url'};
 if(current===asset.url)return {changed:false,reason:'already-mapped'};
 const updated=structuredClone(db);updated.mediaMap||={};updated.media||=[];
 updated.mediaMap[url]=asset.url;
 for(const origin of ['https://mihousespa.com','http://mihousespa.com','https://www.mihousespa.com'])updated.mediaMap[origin+url]=asset.url;
 if(!updated.media.some(x=>x.publicId===asset.publicId&&x.resourceType===asset.resourceType))updated.media.push({id:crypto.randomUUID(),name:path.posix.basename(url),url:asset.url,publicId:asset.publicId,resourceType:asset.resourceType,sourceUrl:url,width:asset.width||null,height:asset.height||null,createdAt:new Date().toISOString(),migration:'v20'});
 updated.revision=Number(updated.revision||0)+1;
 return {changed:true,data:updated};
}
