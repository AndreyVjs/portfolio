'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const {get,put,list,del}=require('@vercel/blob');
const SEED_DATA=require('../data/content.json');
const CONTENT='portfolio-cms/content.json', UPLOADS='portfolio-cms/uploads/', BACKUPS='portfolio-cms/backups/';
const COOKIE='portfolio_admin', LIMIT=4*1024*1024, MAX_IMAGE=2.8*1024*1024;
const attempts=new Map();

function reply(res,status,obj,headers={}){
 res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
 for(const [k,v]of Object.entries(headers))res.setHeader(k,v);res.end(JSON.stringify(obj));
}
function plain(res,status,body,headers={}){res.statusCode=status;res.setHeader('X-Content-Type-Options','nosniff');for(const[k,v]of Object.entries(headers))res.setHeader(k,v);res.end(body);}
function missing(){
 const m=[];
 if(!process.env.PORTFOLIO_ADMIN_PASSWORD||process.env.PORTFOLIO_ADMIN_PASSWORD.length<12)m.push('PORTFOLIO_ADMIN_PASSWORD (mínimo 12 caracteres)');
 if(!process.env.PORTFOLIO_SESSION_SECRET||process.env.PORTFOLIO_SESSION_SECRET.length<32)m.push('PORTFOLIO_SESSION_SECRET (mínimo 32 caracteres)');
 if(!process.env.BLOB_READ_WRITE_TOKEN&&!(process.env.BLOB_STORE_ID&&process.env.VERCEL_OIDC_TOKEN))m.push('Vercel Blob privado conectado ao projeto');
 return m;
}
function hosted(){return !!(process.env.VERCEL||process.env.VERCEL_ENV);}
function originOK(req){const o=req.headers.origin;if(!o)return req.method==='GET'||req.method==='HEAD';try{const u=new URL(o);const h=String(req.headers['x-forwarded-host']||req.headers.host||'').toLowerCase();return u.host.toLowerCase()===h&&(u.protocol==='https:'||(!hosted()&&u.protocol==='http:'));}catch{return false;}}
function cookies(raw=''){const o={};for(const p of raw.split(';')){const i=p.indexOf('=');if(i>0)o[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim());}return o;}
function signature(payload){return crypto.createHmac('sha256',process.env.PORTFOLIO_SESSION_SECRET).update(payload).digest('base64url');}
function isLogged(req){
 const t=cookies(req.headers.cookie).portfolio_admin;if(!t||!process.env.PORTFOLIO_SESSION_SECRET)return false;
 const i=t.lastIndexOf('.');if(i<1)return false;const p=t.slice(0,i),a=Buffer.from(t.slice(i+1)),b=Buffer.from(signature(p));
 if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return false;
 try{return JSON.parse(Buffer.from(p,'base64url').toString()).exp>Date.now();}catch{return false;}
}
function setSession(res){const p=Buffer.from(JSON.stringify({exp:Date.now()+8*60*60*1000,n:crypto.randomBytes(24).toString('hex')})).toString('base64url');res.setHeader('Set-Cookie',COOKIE+'='+encodeURIComponent(p+'.'+signature(p))+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800'+(hosted()?'; Secure':''));}
function clearSession(res){res.setHeader('Set-Cookie',COOKIE+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(hosted()?'; Secure':''));}
async function readBody(req){
 if(req.body!==undefined&&req.body!==null){if(Buffer.isBuffer(req.body))return JSON.parse(req.body.toString());if(typeof req.body==='string')return JSON.parse(req.body);if(typeof req.body==='object')return req.body;}
 const parts=[];let n=0;for await(const c of req){n+=c.length;if(n>LIMIT)throw Object.assign(new Error('Corpo da solicitação muito grande.'),{status:413});parts.push(c);}
 try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw Object.assign(new Error('JSON inválido.'),{status:400});}
}
function seed(){return JSON.parse(JSON.stringify(SEED_DATA));}
async function blobJSON(pathname){const b=await get(pathname,{access:'private',useCache:false});return !b||b.statusCode!==200||!b.stream?null:JSON.parse(await new Response(b.stream).text());}
async function content(){
 if(missing().includes('Vercel Blob privado conectado ao projeto'))return seed();
 let c=await blobJSON(CONTENT);
 if(!c){c=seed();await put(CONTENT,JSON.stringify(c),{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json; charset=utf-8'});}
 else {
  // Incorporate newly seeded projects without overwriting any existing CMS content.
  const known=new Set(c.projects.map(p=>String(p.id||'')));
  const additions=SEED_DATA.projects.filter(p=>!known.has(String(p.id||''))&&['curso-platform','votara'].includes(String(p.id||'')));
  if(additions.length){c.projects.push(...additions);await save(c);}
 }
 return c;
}
function validate(c){
 if(!c||typeof c!=='object'||!c.site||!Array.isArray(c.projects)||!Array.isArray(c.articles))throw Object.assign(new Error('Estrutura de conteúdo inválida.'),{status:400});
 for(const [name,items]of[['projetos',c.projects],['artigos',c.articles]]){const ids=items.map(x=>String(name==='artigos'?x.slug:(x.id||x.slug)||'').trim()).filter(Boolean);if(new Set(ids).size!==ids.length)throw Object.assign(new Error('Há identificadores duplicados em '+name+'.'),{status:400});}
 if(c.projects.some(x=>x.status!=='draft'&&x.status!=='hidden'&&!String(x.title||'').trim()))throw Object.assign(new Error('Todo projeto publicado precisa de título.'),{status:400});
 if(c.articles.some(x=>x.status!=='draft'&&x.status!=='hidden'&&(!String(x.title||'').trim()||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(x.slug||'')))))throw Object.assign(new Error('Todo artigo publicado precisa de título e slug válido.'),{status:400});
 if(Buffer.byteLength(JSON.stringify(c))>3.5*1024*1024)throw Object.assign(new Error('O conteúdo ultrapassa o limite de tamanho.'),{status:413});
}
function published(c){const o=JSON.parse(JSON.stringify(c));o.projects=o.projects.filter(x=>x.status!=='draft'&&x.status!=='hidden');o.articles=o.articles.filter(x=>x.status!=='draft'&&x.status!=='hidden');if(Array.isArray(o.site.builds))o.site.builds=o.site.builds.filter(x=>x.status!=='draft'&&x.status!=='hidden');return o;}
function extension(b){if(b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return['.png','image/png'];if(b.length>=3&&b[0]===255&&b[1]===216&&b[2]===255)return['.jpg','image/jpeg'];if(b.length>=12&&b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP')return['.webp','image/webp'];if(b.length>=6&&/^GIF8[79]a$/.test(b.toString('ascii',0,6)))return['.gif','image/gif'];if(b.length>=12&&b.toString('ascii',4,8)==='ftyp'&&/avif|avis/.test(b.toString('ascii',8,16)))return['.avif','image/avif'];return null;}
async function save(c){
 validate(c);const old=await blobJSON(CONTENT);
 if(old){const stamp=new Date().toISOString().replace(/[:.]/g,'-');await put(BACKUPS+'content-'+stamp+'.json',JSON.stringify(old),{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:'application/json'});const {blobs}=await list({prefix:BACKUPS,limit:1000});const stale=blobs.filter(x=>x.pathname.startsWith(BACKUPS)).sort((a,b)=>a.pathname.localeCompare(b.pathname)).slice(0,Math.max(0,blobs.length-20));if(stale.length)await del(stale.map(x=>x.pathname));}
 await put(CONTENT,JSON.stringify(c),{access:'private',addRandomSuffix:false,allowOverwrite:true,contentType:'application/json; charset=utf-8'});
}
async function handler(req,res){
 const url=new URL(req.url,'https://portfolio.invalid'),p=url.pathname;
 if(p==='/api/file'&&req.method==='GET'){
  const name=url.searchParams.get('pathname')||'';
  if(!name.startsWith(UPLOADS)||name.includes('..')||!/\.(png|jpe?g|webp|gif|avif)$/i.test(name))return plain(res,404,'Not found');
  const b=await get(name,{access:'private'});if(!b||b.statusCode!==200||!b.stream)return plain(res,404,'Not found');
  const bytes=Buffer.from(await new Response(b.stream).arrayBuffer());return plain(res,200,bytes,{'Content-Type':b.blob.contentType||'application/octet-stream','Cache-Control':'public, max-age=3600'});
 }
 if(p==='/api/content'&&req.method==='GET')return reply(res,200,published(await content()));
 if(p==='/api/admin/status'&&req.method==='GET')return reply(res,200,{hosted:true,configured:missing().length===0,authenticated:isLogged(req),missing:missing()});
 if(!p.startsWith('/api/admin/'))return reply(res,404,{error:'Rota não encontrada.'});
 if(!originOK(req))return reply(res,403,{error:'Origem não permitida.'});
 const miss=missing();if(miss.length)return reply(res,503,{error:'Configure no Vercel: '+miss.join('; ')+'.'});
 if(p==='/api/admin/setup'&&req.method==='POST')return reply(res,403,{error:'No Vercel, defina PORTFOLIO_ADMIN_PASSWORD nas variáveis de ambiente.'});
 if(p==='/api/admin/login'&&req.method==='POST'){
  const ip=String(req.headers['x-forwarded-for']||'unknown').split(',')[0].trim(),a=attempts.get(ip)||{n:0,until:0};if(a.until>Date.now())return reply(res,429,{error:'Muitas tentativas. Aguarde alguns minutos.'});
  const body=await readBody(req),x=Buffer.from(String(body.password||'')),y=Buffer.from(process.env.PORTFOLIO_ADMIN_PASSWORD);
  if(x.length===y.length&&crypto.timingSafeEqual(x,y)){attempts.delete(ip);setSession(res);return reply(res,200,{ok:true});}
  a.n++;if(a.n>=6){a.n=0;a.until=Date.now()+5*60*1000;}attempts.set(ip,a);return reply(res,401,{error:'Senha incorreta.'});
 }
 if(p==='/api/admin/logout'&&req.method==='POST'){clearSession(res);return reply(res,200,{ok:true});}
 if(!isLogged(req))return reply(res,401,{error:'Sessão expirada. Entre novamente.'});
 if(p==='/api/admin/content'&&req.method==='GET')return reply(res,200,await content());
 if(p==='/api/admin/save'&&req.method==='POST'){await save(await readBody(req));return reply(res,200,{ok:true,savedAt:new Date().toISOString()});}
 if(p==='/api/admin/upload'&&req.method==='POST'){
  const body=await readBody(req);if(typeof body.data!=='string'||body.data.length>4*1024*1024)return reply(res,413,{error:'No Vercel, limite a imagem a 2,8 MB; compacte arquivos maiores.'});
  const m=body.data.match(/^data:image\/(?:png|jpeg|webp|gif|avif);base64,([A-Za-z0-9+/=]+)$/);if(!m)return reply(res,400,{error:'Formato não suportado.'});
  const bytes=Buffer.from(m[1],'base64');if(bytes.length>MAX_IMAGE)return reply(res,413,{error:'No Vercel, limite a imagem a 2,8 MB.'});
  const ext=extension(bytes);if(!ext)return reply(res,400,{error:'O arquivo não parece uma imagem válida.'});
  const pathname=UPLOADS+crypto.randomUUID()+ext[0];await put(pathname,bytes,{access:'private',addRandomSuffix:false,allowOverwrite:false,contentType:ext[1]});
  return reply(res,200,{ok:true,image:'/api/file?pathname='+encodeURIComponent(pathname),bytes:bytes.length});
 }
 if(p==='/api/admin/export'&&req.method==='GET')return reply(res,200,await content(),{'Content-Disposition':'attachment; filename="portfolio-content.json"'});
 return reply(res,404,{error:'Rota administrativa não encontrada.'});
}
module.exports=async function(req,res){
 try{if(req.method==='OPTIONS'){res.statusCode=204;return res.end();}return await handler(req,res);}
 catch(e){console.error('[portfolio-api]',e&&e.stack||e);if(!res.headersSent)return reply(res,e.status||500,{error:e.status?e.message:'Erro interno da API. Confira os logs no Vercel.'});res.end();}
};
module.exports.config={api:{bodyParser:{sizeLimit:'4mb'}}};
