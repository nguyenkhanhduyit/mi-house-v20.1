/**
 * Safely migrate assets referenced by the LIVE Redis CMS and static React pages.
 * No delete operations exist in this tool. Local files and original URLs stay intact.
 * Default invocation is OFFLINE dry-run using server/data/content.json.
 * Execute must specify preview|production, explicit backup path and confirmation.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {normalizeLocalMediaUrl,collectMediaReferences,publicIdForFile,migrationPatch} from './lib/media-migration-core.mjs';
import {resolveRedisEnvironment} from '../server/redis.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const flag=name=>args.includes('--'+name);
const option=name=>args.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3)||'';
const execute=flag('execute');const target=option('target');
if(execute&&(!['preview','production'].includes(target)||!flag('confirm-'+target)||!option('backup'))){
 console.error('Execute requires --target=preview|production --confirm-<target> --backup=/private/path.json');process.exit(2);
}
const backupFile=option('backup');
if(execute&&fs.existsSync(backupFile)){console.error('Backup file already exists; choose a new path. Never overwrite a CMS backup.');process.exit(2)}
const envFile=option('env-file');if(envFile){const text=fs.readFileSync(path.resolve(envFile),'utf8');for(const line of text.split(/\r?\n/)){const m=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(m&&!process.env[m[1]])process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}}
const seedFile=path.join(root,'server/data/content.json');
const local=JSON.parse(fs.readFileSync(seedFile,'utf8'));
const readConfig=()=>{
 const selected=resolveRedisEnvironment(process.env);
 if(selected.error||!selected.url||!selected.token)throw Error(selected.error||'Missing Upstash Redis REST credentials');
 return {url:selected.url,token:selected.token};
};
async function redisCommand(config,...parts){
 const response=await fetch(config.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify(parts),signal:AbortSignal.timeout(12000)});
 const body=await response.json();if(!response.ok||body.error)throw Error('Upstash returned '+(body.error||response.status));return body.result;
}
const prefix=(process.env.CMS_REDIS_PREFIX||'mi-house')+':'+target;
if(!/^[\w:.-]{1,90}$/.test(prefix))throw Error('Bad CMS_REDIS_PREFIX');
const keyState=prefix+':cms',keyVersion=prefix+':cms-version';
let config;
async function remoteLoad(){const snapshot=await redisCommand(config,'EVAL',"return {redis.call('GET',KEYS[1]),redis.call('GET',KEYS[2]) or '0'}",2,keyState,keyVersion);
 if(!Array.isArray(snapshot)||!snapshot[0])throw Error('CMS key does not exist. No implicit seed or initialization allowed.');
 return {data:JSON.parse(snapshot[0]),version:Number(snapshot[1]||0)};
}
async function remoteSave(prev,data){const ok=await redisCommand(config,'EVAL',"if tostring(redis.call('GET',KEYS[2]) or '0') ~= tostring(ARGV[1]) then return 0 end redis.call('SET',KEYS[1],ARGV[2]);redis.call('INCR',KEYS[2]);return 1",2,keyState,keyVersion,String(prev),JSON.stringify(data));return ok===1;}
let snapshot=execute?null:{data:local,version:0};
if(execute){
 config=readConfig();snapshot=await remoteLoad();
 // A private, one-time point-in-time backup is required before the first write.
 fs.writeFileSync(backupFile,JSON.stringify({target,redisKey:keyState,version:snapshot.version,createdAt:new Date().toISOString(),data:snapshot.data},null,2),{flag:'wx',mode:0o600});
 console.log('Backup saved locally. Do not include the backup in public Git/ZIP.');
}
const discovered=collectMediaReferences({db:snapshot.data,srcDir:path.join(root,'src'),publicDir:path.join(root,'public')});
const limit=Number(option('limit')||0);
if(limit && (!Number.isSafeInteger(limit)||limit<1))throw Error('Invalid --limit');
const candidates=discovered.filter(f=>!snapshot.data.mediaMap?.[f.url]).slice(0,limit||undefined);
const missing=[];const fileBytes=candidates.reduce((s,x)=>s+x.size,0);
console.log(`Mode=${execute?'EXECUTE':'DRY RUN'} target=${target||'offline'} media references=${discovered.length} candidates=${candidates.length} bytes=${fileBytes}`);
if(!execute){
 console.log('Cloudinary upload and Redis writes have NOT occurred.');
 for(const item of candidates.slice(0,12))console.log(' ',item.url,`${item.size} bytes`);
 process.exit(0);
}
const cloud=process.env.CLOUDINARY_CLOUD_NAME,apiKey=process.env.CLOUDINARY_API_KEY,secret=process.env.CLOUDINARY_API_SECRET;
if(!cloud||!apiKey||!secret)throw Error('Missing rotated Cloudinary credentials. No migration executed.');
let done=0,failed=0,skipped=0;
for(const item of candidates){
 try{
  if(!normalizeLocalMediaUrl(item.url))throw Error('Unsafe local path');
  const id=publicIdForFile(item.filepath),timestamp=String(Math.floor(Date.now()/1000));
  const signature=crypto.createHash('sha1').update(`public_id=${id}&timestamp=${timestamp}${secret}`).digest('hex');
  const kind=/\.(?:mp4|webm|mov)$/i.test(item.url)?'video':'image';
  const form=new FormData();form.append('file',new Blob([fs.readFileSync(item.filepath)]),path.basename(item.filepath));
  form.set('public_id',id);form.set('timestamp',timestamp);form.set('api_key',apiKey);form.set('signature',signature);
  const response=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/${kind}/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(180000)});
  const asset=await response.json();
  if(!response.ok||asset.public_id!==id||asset.resource_type!==kind||!String(asset.secure_url||'').startsWith(`https://res.cloudinary.com/${cloud}/${kind}/`))throw Error('Upload verification failed: '+(asset.error?.message||response.status));
  // CAS/rebase: users can continue editing while migration runs. Never replace
  // a newer snapshot or override an existing mediaMap decision.
  for(let attempt=0;attempt<5;attempt++){
   const fresh=await remoteLoad(), patch=migrationPatch(fresh.data,item.url,{url:asset.secure_url,publicId:id,resourceType:kind,width:asset.width,height:asset.height});
   if(!patch.changed){skipped++;break;}
   if(await remoteSave(fresh.version,patch.data)){done++;break;}
   if(attempt===4)throw Error('CMS was modified concurrently too many times');
  }
  if((done+skipped)%10===0)console.log('Migrated='+done+' skipped='+skipped+' / '+candidates.length);
 }catch(error){failed++;console.error('FAILED',item.url,error.message);}
}
console.log(`Migration finished: changed=${done} skipped=${skipped} failed=${failed}. No original Cloudinary/local assets were deleted.`);
process.exitCode=failed?1:0;
