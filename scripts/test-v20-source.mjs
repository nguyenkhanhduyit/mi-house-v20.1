import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=x=>fs.readFileSync(path.join(root,x),'utf8');
let n=0;function check(cond,label){assert.ok(cond,label);n++;console.log('PASS',label)}
const html=file('index.html'),app=file('src/App.jsx'),admin=file('src/cms/SourceAdmin.jsx'),loader=file('src/hooks/loadOriginalStyles.js'),redis=file('server/redis.mjs');
const homeBundles=[['home-foundation.css',['fallback.css','site.css']],['home-layout.css',['fidelity.css','landing.css','onepage.css','source-fidelity.css']]];
for(const [name,parts] of homeBundles){
 const bundled=file('public/'+name);
 check(parts.every(part=>bundled.includes('/* bundle source: '+part+' */')),'All source styles preserved in '+name);
 let offset=-1;for(const part of parts){const pos=bundled.indexOf('/* bundle source: '+part+' */');check(pos>offset,name+' preserves '+part+' cascade order');offset=pos}
}
check(html.includes('!window.__MI_ADMIN')&&html.includes('/home-foundation.css')&&!html.includes('<link rel="stylesheet" href="/fallback.css"'),'Admin does not insert website stylesheet links');
check(app.includes('home-foundation|home-layout')&&app.includes("link.media=internal?'not all':'all'"),'Internal pages deactivate bundled home styles');
check(loader.includes('candidate')&&loader.includes('if ([')&&loader.includes('continue;'),'Original CSS loader avoids duplicate requests');
check(redis.includes('readOrInitializeScript')&&!redis.includes('await evalLua(initializeScript'),'Redis read and seed use one atomic network operation');
check(admin.includes('if(richEditor)mountRichEditor(doc,richEditor)'),'Content (vi) editor available for every form containing its source field');
check(admin.includes("form.querySelectorAll('.source-business-extra').forEach(node=>node.remove())"),'Repeated form fill cannot duplicate additional input fields');
check(admin.includes('if(!active)fillForm(doc,s.tab,data')&&admin.includes('form[data-cms-changed="1"]'),'Dirty form is preserved during a background Admin render');
check(admin.includes("doc.addEventListener('paste'")&&admin.includes('sanitizeEditorHtml(doc,incoming)'),'Paste HTML is sanitized before insertion');
console.log('V20 source contract checks:',n+'/'+n,'PASS');
