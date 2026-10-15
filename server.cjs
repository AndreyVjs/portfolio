'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'content.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const UPLOAD_DIR = path.join(ROOT, 'assets', 'uploads');
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const MAX_JSON = 12 * 1024 * 1024;
const sessions = new Map();
const loginAttempts = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) throw new Error('data/content.json is missing');

function send(res, code, body, headers = {}) {
  const out = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cache-Control': 'no-store',
    ...(typeof body === 'string' ? { 'Content-Type': 'text/plain; charset=utf-8' } : { 'Content-Type': 'application/json; charset=utf-8' }),
    ...headers
  });
  res.end(out);
}
function readBody(req, limit = MAX_JSON) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0, failed = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        failed = true;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req) {
  const body = await readBody(req);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw Object.assign(new Error('JSON inválido.'), { status: 400 }); }
}
function loadContent() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function saveContent(next) {
  if (!next || typeof next !== 'object' || !next.site || !Array.isArray(next.projects) || !Array.isArray(next.articles)) {
    throw Object.assign(new Error('Estrutura de conteúdo inválida.'), { status: 400 });
  }
  for (const [label, items] of [['projetos', next.projects], ['artigos', next.articles]]) {
    const ids = items.map(x => String(x.id || x.slug || '').trim()).filter(Boolean);
    if (new Set(ids).size !== ids.length) throw Object.assign(new Error('Existem identificadores duplicados em ' + label + '.'), { status: 400 });
  }
  if (next.projects.some(x => x.status !== 'draft' && x.status !== 'hidden' && !String(x.title || '').trim())) {
    throw Object.assign(new Error('Todo projeto publicado precisa de um título.'), { status: 400 });
  }
  if (next.articles.some(x => x.status !== 'draft' && x.status !== 'hidden' && (!String(x.title || '').trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(x.slug || ''))))) {
    throw Object.assign(new Error('Todo artigo publicado precisa de título e slug válido (ex.: meu-artigo).'), { status: 400 });
  }
  const serialized = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 8 * 1024 * 1024) throw Object.assign(new Error('O conteúdo é grande demais.'), { status: 413 });
  const backupDir = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(DATA_FILE, path.join(backupDir, 'content-' + stamp + '.json'));
  const backups = fs.readdirSync(backupDir).filter(x => x.endsWith('.json')).sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - 20))) fs.unlinkSync(path.join(backupDir, old));
  const temp = DATA_FILE + '.tmp';
  fs.writeFileSync(temp, serialized, { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function parseCookies(header = '') {
  const cookies = {};
  for (const p of header.split(';')) {
    const i = p.indexOf('=');
    if (i > 0) cookies[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  }
  return cookies;
}
function sessionFor(req) {
  const token = parseCookies(req.headers.cookie).portfolio_admin;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiry < Date.now()) { sessions.delete(token); return null; }
  session.expiry = Date.now() + 8 * 60 * 60 * 1000;
  return { token, session };
}
function createSession(res) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expiry: Date.now() + 8 * 60 * 60 * 1000 });
  res.setHeader('Set-Cookie', 'portfolio_admin=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800');
}
function clearSession(req, res) {
  const token = parseCookies(req.headers.cookie).portfolio_admin;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'portfolio_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}
function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr.endsWith(':127.0.0.1');
}
function requestAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port || 80) === PORT;
  } catch { return false; }
}
function requireAuth(req, res) {
  if (!isLocalRequest(req)) { send(res, 403, { error: 'O painel só aceita conexões locais.' }); return false; }
  if (!requestAllowed(req)) { send(res, 403, { error: 'Origem não permitida.' }); return false; }
  if (!sessionFor(req)) { send(res, 401, { error: 'Sessão expirada. Entre novamente.' }); return false; }
  return true;
}
function configured() { return fs.existsSync(AUTH_FILE); }
function checkPassword(password) {
  if (!configured()) return false;
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const candidate = crypto.scryptSync(password, Buffer.from(auth.salt, 'hex'), 64);
  const saved = Buffer.from(auth.hash, 'hex');
  return saved.length === candidate.length && crypto.timingSafeEqual(saved, candidate);
}
function publicContent() {
  const content = loadContent();
  content.projects = content.projects.filter(x => x.status !== 'draft' && x.status !== 'hidden');
  content.articles = content.articles.filter(x => x.status !== 'draft' && x.status !== 'hidden');
  if (content.site && Array.isArray(content.site.builds)) content.site.builds = content.site.builds.filter(x => x.status !== 'draft' && x.status !== 'hidden');
  return content;
}
function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (decoded === '/') decoded = '/index.html';
  if (decoded === '/admin') decoded = '/admin.html';
  const full = path.resolve(ROOT, '.' + decoded);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  if (full.startsWith(DATA_DIR + path.sep) || full === AUTH_FILE) return null;
  return full;
}
function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return ({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif','.svg':'image/svg+xml','.pdf':'application/pdf','.ico':'image/x-icon','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'})[ext] || 'application/octet-stream';
}
function sendFile(req, res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Não encontrado.');
  res.writeHead(200, {'Content-Type':contentType(file),'X-Content-Type-Options':'nosniff','X-Frame-Options':'SAMEORIGIN','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':/\.(html|js|css|json)$/.test(file)?'no-cache':'public, max-age=3600'});
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function uploadedExt(buf) {
  if (buf.length >= 8 && buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (buf.length >= 3 && buf[0]===0xff && buf[1]===0xd8 && buf[2]===0xff) return '.jpg';
  if (buf.length >= 12 && buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP') return '.webp';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('ascii',0,6))) return '.gif';
  if (buf.length >= 12 && buf.toString('ascii',4,8)==='ftyp' && /avif|avis/.test(buf.toString('ascii',8,16))) return '.avif';
  return null;
}
async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/content') return send(res, 200, publicContent());
  if (req.method === 'GET' && url.pathname === '/api/admin/status') return send(res, 200, { configured:configured(), authenticated:!!sessionFor(req) });
  if (req.method === 'POST' && url.pathname === '/api/admin/setup') {
    if (!isLocalRequest(req) || !requestAllowed(req)) return send(res,403,{error:'A configuração só pode ser feita localmente.'});
    if (configured()) return send(res,409,{error:'A senha de administrador já foi definida. Entre com sua senha.'});
    const body = await readJson(req), password = String(body.password || '');
    if (password.length < 12) return send(res,400,{error:'Use uma senha com pelo menos 12 caracteres.'});
    const salt = crypto.randomBytes(16), hash = crypto.scryptSync(password, salt, 64);
    fs.writeFileSync(AUTH_FILE, JSON.stringify({salt:salt.toString('hex'),hash:hash.toString('hex'),createdAt:new Date().toISOString()},null,2), {mode:0o600});
    createSession(res); return send(res,200,{ok:true});
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!isLocalRequest(req) || !requestAllowed(req)) return send(res,403,{error:'O painel só aceita conexões locais.'});
    const ip = req.socket.remoteAddress || 'local', attempt = loginAttempts.get(ip) || {count:0,until:0};
    if (attempt.until > Date.now()) return send(res,429,{error:'Muitas tentativas. Aguarde alguns minutos.'});
    const body = await readJson(req);
    if (checkPassword(String(body.password || ''))) { loginAttempts.delete(ip); createSession(res); return send(res,200,{ok:true}); }
    attempt.count++; if (attempt.count >= 6) { attempt.count=0; attempt.until=Date.now()+5*60*1000; }
    loginAttempts.set(ip,attempt); return send(res,401,{error:'Senha incorreta.'});
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') { clearSession(req,res); return send(res,200,{ok:true}); }
  if (url.pathname.startsWith('/api/admin/')) {
    if (!requireAuth(req,res)) return;
    if (req.method === 'GET' && url.pathname === '/api/admin/content') return send(res,200,loadContent());
    if (req.method === 'POST' && url.pathname === '/api/admin/save') {
      const body = await readJson(req); saveContent(body);
      return send(res,200,{ok:true,savedAt:new Date().toISOString()});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/upload') {
      const body = await readJson(req);
      if (typeof body.data !== 'string' || body.data.length > 11*1024*1024) return send(res,413,{error:'A imagem deve ter até 8 MB.'});
      const match = body.data.match(/^data:image\/(?:png|jpeg|webp|gif|avif);base64,([A-Za-z0-9+/=]+)$/);
      if (!match) return send(res,400,{error:'Formato não suportado. Use PNG, JPG, WebP, GIF ou AVIF.'});
      const buffer = Buffer.from(match[1],'base64');
      if (buffer.length > 8*1024*1024) return send(res,413,{error:'A imagem deve ter até 8 MB.'});
      const ext=uploadedExt(buffer);
      if (!ext) return send(res,400,{error:'O arquivo não parece ser uma imagem válida.'});
      const filename=crypto.randomUUID()+ext;
      fs.writeFileSync(path.join(UPLOAD_DIR,filename),buffer,{mode:0o644,flag:'wx'});
      return send(res,200,{ok:true,image:'uploads/'+filename,bytes:buffer.length});
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/export') return send(res,200,fs.readFileSync(DATA_FILE).toString('utf8'),{'Content-Disposition':'attachment; filename="portfolio-content.json"','Content-Type':'application/json; charset=utf-8'});
    return send(res,404,{error:'Rota administrativa não encontrada.'});
  }
  return send(res,404,{error:'Rota API não encontrada.'});
}
const server = http.createServer(async (req,res)=>{
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || HOST));
    if (url.pathname.startsWith('/api/')) return await handleApi(req,res,url);
    if (!['GET','HEAD'].includes(req.method)) return send(res,405,'Método não permitido.');
    const file=safeStaticPath(req.url);
    if (!file) return send(res,400,'Caminho inválido.');
    sendFile(req,res,file);
  } catch (err) {
    console.error('[server]',err.stack || err);
    if (!res.headersSent) send(res,err.status || 500,{error:err.message || 'Erro interno.'}); else res.destroy();
  }
});
server.listen(PORT,HOST,()=>{
 fs.writeFileSync(path.join(DATA_DIR,'server.pid'),String(process.pid)+String.fromCharCode(10),{mode:0o600});
 console.log('Portfolio CMS running at http://'+HOST+':'+PORT);
 console.log('Admin panel: http://'+HOST+':'+PORT+'/admin');
 console.log('First visit will ask you to create an admin password.');
});
server.on('error',err=>{console.error(err);process.exitCode=1;});

server.on('close',()=>{try{fs.unlinkSync(path.join(DATA_DIR,'server.pid'));}catch{}});
process.on('SIGTERM',()=>server.close(()=>{try{fs.unlinkSync(path.join(DATA_DIR,'server.pid'));}catch{};process.exit(0);}));
process.on('SIGINT',()=>server.close(()=>{try{fs.unlinkSync(path.join(DATA_DIR,'server.pid'));}catch{};process.exit(0);}));
