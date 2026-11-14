/**
 * CMS HTML sanitizer shared by the Visual editor and every CMS-rendered article.
 * Browser DOM parsing is essential: regex replacements cannot safely validate HTML.
 * It deliberately preserves legitimate typography, images, tables and supported
 * video embeds, while excluding active content, event handlers and unsafe URLs.
 * This is defense in depth for authenticated CMS content, not an HTML sandbox.
 */
const FORBIDDEN='script,object,embed,form,base,link,meta,style,svg,math,template,applet,frameset,frame';
const MEDIA=new Set(['IMG','VIDEO','AUDIO','SOURCE','IFRAME']);
const LINK_ATTRS=new Set(['href','src','poster','cite']);
const EMBED_ORIGINS=new Set([
 'www.youtube.com','youtube.com','www.youtube-nocookie.com','youtube-nocookie.com',
 'player.vimeo.com','www.tiktok.com','tiktok.com','www.google.com','google.com'
]);
function safeUrl(value, tag, attribute){
 const raw=String(value||'').trim();
 if(!raw||/[\u0000-\u001f\u007f]/.test(raw))return false;
 if(attribute==='href'&&raw.startsWith('#'))return true;
 if(raw.startsWith('/')&&!raw.startsWith('//'))return true;
 try{
  const u=new URL(raw,'https://mihousespa.com');
  if(tag==='IFRAME'){
   if(u.protocol!=='https:'||!EMBED_ORIGINS.has(u.hostname))return false;
   if(/youtube/.test(u.hostname))return u.pathname.startsWith('/embed/');
   if(u.hostname==='player.vimeo.com')return u.pathname.startsWith('/video/');
   if(/tiktok/.test(u.hostname))return u.pathname.startsWith('/embed/');
   return u.pathname.startsWith('/maps/embed');
  }
  if(attribute==='href')return ['http:','https:','mailto:','tel:'].includes(u.protocol);
  return ['http:','https:'].includes(u.protocol);
 }catch{return false;}
}
export function sanitizeCmsHtml(value,doc=globalThis.document){
 const Parser=doc?.defaultView?.DOMParser||globalThis.DOMParser;
 if(!Parser||!value)return '';
 const dom=new Parser().parseFromString(String(value),'text/html');
 dom.querySelectorAll(FORBIDDEN).forEach(node=>node.remove());
 dom.body.querySelectorAll('*').forEach(el=>{
  const tag=el.tagName;
  if(tag==='IFRAME'){
   if(!safeUrl(el.getAttribute('src'),tag,'src')){el.remove();return;}
   el.setAttribute('loading','lazy');el.setAttribute('referrerpolicy','strict-origin-when-cross-origin');
   el.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');
  }
  for(const attribute of [...el.attributes]){
   const name=attribute.name.toLowerCase(),raw=attribute.value.trim();
   if(name.startsWith('on')||['srcdoc','formaction','contenteditable','autofocus','srcset','imagesrcset','xmlns','xlink:href'].includes(name)){
    el.removeAttribute(attribute.name);continue;
   }
   if(LINK_ATTRS.has(name)&&!safeUrl(raw,tag,name)){
    el.removeAttribute(attribute.name);continue;
   }
   // CSS escape sequences can obfuscate dangerous functions. The editor
   // supports ordinary inline CSS without allowing URL loading through style.
   if(name==='style'&&/(\\|url\s*\(|expression\s*\(|@import|behavior\s*:|@charset|-moz-binding)/i.test(raw)){
    el.removeAttribute(attribute.name);continue;
   }
   if(name==='target'&&raw!=='_blank'&&raw!=='_self')el.removeAttribute(attribute.name);
  }
  if(tag==='A'&&el.getAttribute('target')==='_blank')el.setAttribute('rel','noopener noreferrer');
  if(tag==='VIDEO'){el.setAttribute('controls','');el.setAttribute('preload','none');}
 });
 return dom.body.innerHTML;
}
