/** Keep original CSS contents and cascade order, but reduce critical requests. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[
 ['home-foundation.css',['fallback.css','site.css']],
 ['home-layout.css',['fidelity.css','landing.css','onepage.css','source-fidelity.css']]
];
for(const [name,parts] of files){const css=parts.map(part=>`/* bundle source: ${part} */\n`+fs.readFileSync(path.join(root,'public',part),'utf8')).join('\n');fs.writeFileSync(path.join(root,'public',name),css);console.log(`Generated ${name}: ${parts.length} ordered stylesheets, ${Buffer.byteLength(css)} bytes`)}
