import {source as bounded,settings} from '../checkpoint-service/fixture.mjs';
export {settings};
export const source=bounded.replaceAll('kind="byte-source"','kind="stream-source"')
 .replace('value=pdrv.bytes("\\x00\\x80\\xffA")','value=pdrv.bytes(io.request({kind="source-read",source=args.image,maximum=4}))')
 .replace('value=pdrv.bytes("\\xffA")','value=pdrv.bytes(io.request({kind="source-read",source=args.image,maximum=2}))')
 .replace('operations=a({{id="write"','operations=a({{id="scan",title="Scan",binding="scan",arguments={image={kind="stream-source",minimumBytes=0,maximumBytes=2097088}},result={kind="value",type={kind="integer",widthBits=32,signed=false}},risk="read-only",repeatability="safe-to-repeat",locks=a({}),requires=a({}),availability={modes=a({"challenge"}),profiles=a({"serial"})}},{id="write"')
 .replace('{fresh=function','{scan=function(args,io) local pattern="'+Array.from({length:256},(_,i)=>'\\x'+((i*17+31)&255).toString(16).padStart(2,'0')).join('')+'";local n=0;while true do local b=io.request({kind="source-read",source=args.image,maximum=256});if #b==0 then break end;assert(b==pattern:sub(1,#b),"source octets differ");n=n+#b end;return n end,fresh=function');
if(!source.includes('value=pdrv.bytes(io.request'))throw new Error('stream carrier fixture did not change');
