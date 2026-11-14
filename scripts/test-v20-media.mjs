import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {normalizeLocalMediaUrl,collectMediaReferences,migrationPatch,publicIdForFile} from './lib/media-migration-core.mjs';
const tests=[];function test(name,fn){fn();tests.push(name)}
test('Reject external hosts',()=>{assert.equal(normalizeLocalMediaUrl('https://outside.com/upload/photo.png'),null);});
test('Reject parent path traversal',()=>{assert.equal(normalizeLocalMediaUrl('/upload/../secrets.jpg'),null);});
test('Reject encoded traversal',()=>{assert.equal(normalizeLocalMediaUrl('/upload/%2e%2e/secrets.jpg'),null);});
test('Reject Javascript and scheme-relative URLs',()=>{assert.equal(normalizeLocalMediaUrl('//hack.example/photo.jpg'),null);assert.equal(normalizeLocalMediaUrl('javascript:x.jpg'),null)});
test('Normalize original site URL to relative path',()=>{assert.equal(normalizeLocalMediaUrl('https://mihousespa.com/upload/x.png'),'/upload/x.png')});
test('Reject URL query and local secrets',()=>{assert.equal(normalizeLocalMediaUrl('/upload/image.png?token=foo'),null);assert.equal(normalizeLocalMediaUrl('/upload/file.env'),null)});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v20-migration-'));try{
 const publicDir=path.join(dir,'public');const srcDir=path.join(dir,'src');fs.mkdirSync(path.join(publicDir,'upload'),{recursive:true});fs.mkdirSync(srcDir);
 fs.writeFileSync(path.join(publicDir,'upload','photo.png'),'fixture image');fs.writeFileSync(path.join(srcDir,'page.jsx'),`const cover='/upload/photo.png';`);
 const db={articles:[{body:'<img src="https://mihousespa.com/upload/photo.png">'}],mediaMap:{},media:[],revision:10};
 const list=collectMediaReferences({db,srcDir,publicDir});
 test('Scans CMS and React source without duplicate migration entries',()=>{assert.equal(list.length,1);assert.equal(list[0].references>1,true)});
 const id=publicIdForFile(list[0].filepath),asset={url:'https://res.cloudinary.com/example/image/upload/v1/id.png',publicId:id,resourceType:'image'};
 test('Deterministic Cloudinary public ID allows retries',()=>{assert.equal(publicIdForFile(list[0].filepath),id);assert.match(id,/^mi-house\/migrated\/[0-9a-f]{32}$/)});
 const result=migrationPatch(db,'/upload/photo.png',asset);
 test('Creates complete idempotent mapping and increments revision',()=>{assert.equal(result.changed,true);assert.equal(result.data.revision,11);assert.equal(result.data.mediaMap['/upload/photo.png'],asset.url);assert.equal(result.data.mediaMap['https://mihousespa.com/upload/photo.png'],asset.url);assert.equal(result.data.media.length,1)});
 test('Does not mutate CMS snapshot in place',()=>{assert.equal(db.media.length,0);assert.equal(db.revision,10)});
 test('Repeated migration does not create duplicated media',()=>{assert.equal(migrationPatch(result.data,'/upload/photo.png',asset).changed,false)});
 test('Never overrides a concurrent admin mapping',()=>{const conflict=migrationPatch(result.data,'/upload/photo.png',{...asset,url:'https://different.example/x'});assert.equal(conflict.changed,false);assert.equal(conflict.reason,'already-mapped-to-another-url')});
}finally{fs.rmSync(dir,{recursive:true,force:true})}
console.log('V20 Media migration tests:',tests.length+'/'+tests.length,'PASS');tests.forEach(t=>console.log('PASS',t));
