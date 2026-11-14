import assert from 'node:assert/strict';
import fs from 'node:fs';
import {getRows,saveRecord} from '../src/cms/businessModel.js';
const fixture=JSON.parse(fs.readFileSync(new URL('../src/cms/initialContent.json',import.meta.url),'utf8'));
const cases=['articles','services','training','albumCategories','albumPhotos','menu','slides','videos'];
let tests=0;
for(const tab of cases){
 const base=structuredClone(fixture),before=getRows(base,tab);
 assert.ok(before.length>0,'Fixture missing '+tab);
 const id=String(before[0].id),original=before.find(r=>String(r.id)===id);
 const toggledFeatured=!(original.featured===true||original.featured===1||original.featured==='1');
 const nextStatus=original.status==='draft'?'published':'draft';
 saveRecord(base,tab,{...original,featured:toggledFeatured,status:nextStatus});
 const after=getRows(base,tab).find(r=>String(r.id)===id);
 assert.equal(after.featured,toggledFeatured,`${tab} featured persisted`);tests++;
 if(nextStatus==='draft')assert.equal(getRows(base,tab).find(r=>String(r.id)===id)?.status,'draft',`${tab} draft remains editable`);
 else assert.equal(after.status,'published',`${tab} publication persisted`);
 tests++;
 assert.equal(getRows(fixture,tab).find(r=>String(r.id)===id).status,original.status,`${tab} original data preserved`);tests++;
 console.log('PASS status switches roundtrip in',tab);
}
console.log(`V21 MODULE STATUS: ${tests}/${tests} checks PASS`);
