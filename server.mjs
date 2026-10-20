// Solar BNST API. Zero dependencies. Requires Node 22+ (node:http, node:crypto, node:sqlite).
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || "./solar-bnst.db";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const MAX_LOAD = 5;
const INDEX = fs.readFileSync(new URL("./public/index.html", import.meta.url));

// ---------- roles (rank decides what each role may do) ----------
const ROLES = {
  visitor:     {rank:-1, label:"MEMBER",     color:"#8A8F98"},
  trial_mod:   {rank:1,  label:"TRIAL MOD",  color:"#7FD1AE"},
  trial_admin: {rank:2,  label:"TRIAL ADMIN",color:"#3BB8A8"},
  moderator:   {rank:3,  label:"MOD",        color:"#4A90E2"},
  admin:       {rank:4,  label:"ADMIN",      color:"#8B5CF6"},
  head_mod:    {rank:5,  label:"HEAD MOD",   color:"#2563EB"},
  head_admin:  {rank:6,  label:"HEAD ADMIN", color:"#DB2777"},
  co_owner:    {rank:7,  label:"CO-OWNER",   color:"#F5B301"},
  owner:       {rank:8,  label:"OWNER",      color:"#E11D48"}
};
const RANK_MANAGE_TX = 3;  // moderator and up: assign, move statuses, see all transactions
const RANK_ADMIN = 4;      // admin and up: staff, revenue, audit, disputes, cancel, GC links
const RANK_OWNER = 8;      // owner only: platform fee and owner-level settings
const rank = u => ROLES[u.role]?.rank ?? 0;
const roleLabel = r => ROLES[r]?.label || "MEMBER";

const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL, mm_eligible INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  bio TEXT NOT NULL DEFAULT '', specialties TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, show_public INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS transactions(
  id TEXT PRIMARY KEY, buyer_name TEXT NOT NULL, buyer_fb TEXT NOT NULL, seller_name TEXT NOT NULL, seller_fb TEXT NOT NULL,
  item TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK(price_cents > 0), currency TEXT NOT NULL,
  description TEXT NOT NULL, extra TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, mm_id INTEGER REFERENCES users(id),
  open_dispute INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, completed_at TEXT);
CREATE TABLE IF NOT EXISTS tx_history(id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL REFERENCES transactions(id),
  from_status TEXT, to_status TEXT NOT NULL, actor_id INTEGER, reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id),
  tx_id TEXT, text TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, action TEXT NOT NULL,
  target TEXT, detail TEXT, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '',
  fb_url TEXT NOT NULL, created_by INTEGER, created_at TEXT NOT NULL);
`);
// Columns added over time. Each ALTER is ignored if the column already exists.
for (const sql of [
  "ALTER TABLE users ADD COLUMN show_public INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN google_sub TEXT",
  "ALTER TABLE users ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE users ADD COLUMN purpose TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN referrer TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE users ADD COLUMN join_stream INTEGER NOT NULL DEFAULT 0"
]) { try { db.exec(sql); } catch {} }
// Older databases had a CHECK that only allowed owner/admin/staff. Rebuild the table without it.
{
  const t = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (t && /CHECK\s*\(\s*role/i.test(t.sql)) {
    db.exec(`PRAGMA foreign_keys=OFF;
    BEGIN;
    CREATE TABLE users_new(id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
      pass_hash TEXT NOT NULL, role TEXT NOT NULL, mm_eligible INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      bio TEXT NOT NULL DEFAULT '', specialties TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      show_public INTEGER NOT NULL DEFAULT 0, google_sub TEXT, onboarded INTEGER NOT NULL DEFAULT 1,
      purpose TEXT NOT NULL DEFAULT '', referrer TEXT NOT NULL DEFAULT '', join_stream INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users_new(id,username,name,pass_hash,role,mm_eligible,active,bio,specialties,created_at,show_public,google_sub,onboarded,purpose,referrer,join_stream)
      SELECT id,username,name,pass_hash,role,mm_eligible,active,bio,specialties,created_at,COALESCE(show_public,0),google_sub,COALESCE(onboarded,1),COALESCE(purpose,''),COALESCE(referrer,''),COALESCE(join_stream,0) FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;
    COMMIT;
    PRAGMA foreign_keys=ON;`);
  }
}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub)"); } catch {}
try { db.exec("UPDATE users SET role='visitor' WHERE role='staff'"); } catch {}

// ---------- statuses ----------
const S = {PENDING:"Pending Assignment",AWAIT:"Awaiting MM/MW Acceptance",ASSIGNED:"Assigned",GC:"Messenger GC Setup",
  PROG:"In Progress",CONF:"Awaiting Confirmation",DONE:"Completed",DISP:"Disputed",CANCEL:"Cancelled"};
const FINAL = [S.DONE, S.CANCEL];
const T = {
  [S.PENDING]:[S.AWAIT,S.CANCEL], [S.AWAIT]:[S.ASSIGNED,S.PENDING,S.CANCEL],
  [S.ASSIGNED]:[S.GC,S.DISP,S.CANCEL], [S.GC]:[S.PROG,S.DISP,S.CANCEL], [S.PROG]:[S.CONF,S.DISP,S.CANCEL],
  [S.CONF]:[S.DONE,S.PROG,S.DISP], [S.DISP]:[S.PROG,S.CANCEL], [S.DONE]:[], [S.CANCEL]:[]
};
const ADMIN_ONLY_TO = [S.DISP, S.CANCEL, S.DONE, S.PENDING];

// ---------- helpers ----------
class HttpError extends Error { constructor(code,msg){ super(msg); this.code = code; } }
const fail = (code,msg) => { throw new HttpError(code,msg); };
const now = () => new Date().toISOString();
const q = (sql,...p) => db.prepare(sql).all(...p);
const one = (sql,...p) => db.prepare(sql).get(...p);
const run = (sql,...p) => db.prepare(sql).run(...p);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const full = (code,body,headers={}) => ({__full:true,code,body,headers});
function atomic(fn){ db.exec("BEGIN IMMEDIATE"); try{ const r = fn(); db.exec("COMMIT"); return r; } catch(e){ db.exec("ROLLBACK"); throw e; } }
function hashPw(pw){ const salt = crypto.randomBytes(16).toString("hex"); return `scrypt$${salt}$${crypto.scryptSync(pw,salt,64).toString("hex")}`; }
function checkPw(pw,stored){ const [,salt,h] = stored.split("$"); return crypto.timingSafeEqual(crypto.scryptSync(pw,salt,64), Buffer.from(h,"hex")); }
function newTxId(){ const a="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const b=crypto.randomBytes(10); let s=""; for(const x of b) s+=a[x%a.length]; return `STB-${s.slice(0,5)}-${s.slice(5)}`; }

// Failed-login counter: only wrong passwords count; a correct login clears it.
const attempts = new Map();
function lockedOut(key,max,windowMs){
  const e = attempts.get(key); if(!e) return false;
  if(Date.now() - e.start > windowMs){ attempts.delete(key); return false; }
  return e.n >= max;
}
function bumpFail(key,windowMs){
  const t = Date.now(); const e = attempts.get(key) || {n:0,start:t};
  if(t - e.start > windowMs){ e.n = 0; e.start = t; }
  e.n++; attempts.set(key,e);
}
function clearFail(key){ attempts.delete(key); }

const hits = new Map();
function limited(key,max,windowMs){
  const t = Date.now(); const e = hits.get(key) || {n:0,start:t};
  if(t - e.start > windowMs){ e.n = 0; e.start = t; }
  e.n++; hits.set(key,e); return e.n > max;
}
function send(res,code,body,headers={}){
  res.writeHead(code,{"Content-Type":"application/json","X-Content-Type-Options":"nosniff","Cache-Control":"no-store","Referrer-Policy":"no-referrer",...headers});
  res.end(JSON.stringify(body));
}
async function readBody(req){
  if(!String(req.headers["content-type"]||"").includes("application/json")) fail(415,"Send JSON.");
  let s=""; for await(const c of req){ s+=c; if(s.length>65536) fail(413,"Request too large."); }
  try{ return s ? JSON.parse(s) : {}; } catch { fail(400,"Invalid JSON."); }
}
function cookie(req,name){ const m = (req.headers.cookie||"").match(new RegExp("(?:^|; )"+name+"=([^;]+)")); return m ? decodeURIComponent(m[1]) : null; }
function currentUser(req){
  const tok = cookie(req,"sid"); if(!tok) return null;
  return one("SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1", sha(tok), Date.now()) || null;
}
// need(req, minRank): logged-in user whose rank is at least minRank
function need(req,minRank=-1){
  const u = currentUser(req); if(!u) fail(401,"Please log in.");
  if(rank(u) < minRank) fail(403,"Not allowed.");
  return u;
}
const canManageTx = u => rank(u) >= RANK_MANAGE_TX;
// Can actor give this role? Only roles below their own rank, and only the owner can give co-owner.
function canGrant(actor,role){
  if(!ROLES[role] || role === "owner") return false;
  if(actor.role === "owner") return true;
  return ROLES[role].rank < rank(actor);
}
// Can actor change this user at all?
function canManageUser(actor,target){
  if(actor.role === "owner") return true;
  return rank(target) < rank(actor);
}
const pub = u => ({id:u.id,username:u.username,name:u.name,role:u.role,role_label:roleLabel(u.role),
  mm_eligible:!!u.mm_eligible,active:!!u.active,bio:u.bio,specialties:u.specialties,show_public:!!u.show_public,
  onboarded:!!u.onboarded,purpose:u.purpose||"",join_stream:!!u.join_stream,role_color:ROLES[u.role]?.color||"#8A8F98"});
function audit(actorId,action,target,detail){ run("INSERT INTO audit(actor_id,action,target,detail,at) VALUES(?,?,?,?,?)",actorId,action,target||null,detail||null,now()); }
function notifyUser(uid,text,txId){ run("INSERT INTO notifications(user_id,tx_id,text,at) VALUES(?,?,?,?)",uid,txId||null,text,now()); }
function notifyManagers(text,txId){
  for(const a of q("SELECT id,role FROM users WHERE active=1")) if(rank(a) >= RANK_MANAGE_TX) notifyUser(a.id,text,txId);
}

const FB = /^https:\/\/(www\.|m\.)?(facebook\.com|fb\.com)\/[A-Za-z0-9.\-_]{1,100}\/?(\?[^\s]{0,200})?$/i;
const GC_URL = /^https:\/\/(www\.|m\.)?(facebook\.com|messenger\.com|m\.me)\/[^\s]{1,300}$/i;
const str = (v,max) => String(v ?? "").trim().slice(0,max);

function moveTx(tx,to,actorId,reason,patch={}){
  if(!(T[tx.status]||[]).includes(to)) fail(409,`Cannot move from "${tx.status}" to "${to}".`);
  let open = tx.open_dispute;
  if(to === S.DISP) open = 1;
  if(tx.status === S.DISP && to !== S.DISP) open = 0;
  if(to === S.DONE && open) fail(409,"Cannot complete while a dispute is open.");
  const mm = patch.mm_id !== undefined ? patch.mm_id : tx.mm_id;
  const completed = to === S.DONE ? now() : tx.completed_at;
  run("UPDATE transactions SET status=?,mm_id=?,open_dispute=?,completed_at=? WHERE id=?",to,mm,open,completed,tx.id);
  run("INSERT INTO tx_history(tx_id,from_status,to_status,actor_id,reason,at) VALUES(?,?,?,?,?,?)",tx.id,tx.status,to,actorId,reason||"",now());
  if(mm) notifyUser(mm,`${tx.id}: ${to}`,tx.id);
  return one("SELECT * FROM transactions WHERE id=?",tx.id);
}
const getTx = id => one("SELECT * FROM transactions WHERE id=?",id) || fail(404,"Transaction not found.");
const validUsername = u => /^[a-zA-Z0-9_]{3,24}$/.test(u);

// ---------- routes ----------
const routes = [];
const R = (m,p,h) => routes.push({m,p:new RegExp("^"+p+"$"),h});

R("GET","/api/status",async ()=>({setup_required: !one("SELECT id FROM users LIMIT 1")}));

R("POST","/api/setup",async req=>{
  const b = await readBody(req);
  const h = one("SELECT value FROM settings WHERE key='setup_hash'");
  if(!h) fail(404,"Setup is already complete.");
  if(sha(str(b.code,20).toUpperCase()) !== h.value) fail(403,"Invalid setup code.");
  const username = str(b.username,24), name = str(b.name,60), pw = String(b.password||"");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(!name) fail(400,"Name is required.");
  if(pw.length < 12) fail(400,"Password must be at least 12 characters.");
  atomic(()=>{
    run("INSERT INTO users(username,name,pass_hash,role,created_at) VALUES(?,?,?,?,?)",username,name,hashPw(pw),"owner",now());
    run("DELETE FROM settings WHERE key='setup_hash'");
  });
  return {ok:true};
});

R("POST","/api/login",async req=>{
  const b = await readBody(req);
  const u = str(b.username,24);
  const lk = "login:"+req.socket.remoteAddress+":"+u.toLowerCase(), WIN = 15*60e3;
  if(lockedOut(lk,5,WIN)) fail(429,"Too many wrong passwords. Try again in 15 minutes.");
  const user = one("SELECT * FROM users WHERE username=? AND active=1",u);
  if(!user || !user.pass_hash.startsWith("scrypt$") || !checkPw(String(b.password||""),user.pass_hash)){
    bumpFail(lk,WIN); fail(401,"Invalid username or password.");
  }
  clearFail(lk);
  const tok = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",sha(tok),user.id,Date.now()+7*864e5);
  return full(200,{ok:true,user:pub(user)},{"Set-Cookie":`sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*86400}${COOKIE_SECURE?"; Secure":""}`});
});

R("POST","/api/logout",async req=>{
  const tok = cookie(req,"sid"); if(tok) run("DELETE FROM sessions WHERE token_hash=?",sha(tok));
  return full(200,{ok:true},{"Set-Cookie":"sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"});
});

R("GET","/api/me",async req=>pub(need(req)));

R("PATCH","/api/me",async req=>{
  const u = need(req); const b = await readBody(req);
  const name = str(b.name,60) || u.name;
  run("UPDATE users SET name=?,bio=?,specialties=?,show_public=? WHERE id=?",name,str(b.bio,500),str(b.specialties,200),b.show_public===true?1:0,u.id);
  return pub(one("SELECT * FROM users WHERE id=?",u.id));
});

R("GET","/api/roles",async req=>{
  const u = need(req,RANK_ADMIN);
  return Object.entries(ROLES).filter(([r])=>canGrant(u,r)).map(([value,v])=>({value,label:v.label,color:v.color}));
});
R("GET","/api/role-hierarchy",async ()=>Object.entries(ROLES).map(([value,v])=>({value,label:v.label,color:v.color,rank:v.rank})).sort((a,b)=>a.rank-b.rank));

// Staff management (admin and up)
R("GET","/api/staff",async req=>{
  need(req,RANK_ADMIN);
  return q("SELECT * FROM users ORDER BY created_at").map(pub);
});

R("POST","/api/staff",async req=>{
  const actor = need(req,RANK_ADMIN); const b = await readBody(req);
  const username = str(b.username,24), name = str(b.name,60), pw = String(b.password||"");
  const role = str(b.role,20) || "visitor";
  if(!canGrant(actor,role)) fail(403,"You cannot give that role.");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(!name) fail(400,"Name is required.");
  if(pw.length < 12) fail(400,"Temporary password must be at least 12 characters.");
  if(one("SELECT id FROM users WHERE username=?",username)) fail(409,"Username already exists.");
  const id = atomic(()=>{
    const r = run("INSERT INTO users(username,name,pass_hash,role,mm_eligible,created_at) VALUES(?,?,?,?,?,?)",username,name,hashPw(pw),role,b.mm_eligible?1:0,now());
    audit(actor.id,"staff.create",String(r.lastInsertRowid),`${username} as ${role}`);
    return r.lastInsertRowid;
  });
  return pub(one("SELECT * FROM users WHERE id=?",id));
});

R("PATCH","/api/staff/(\\d+)",async (req,m)=>{
  const actor = need(req,RANK_ADMIN); const b = await readBody(req);
  const target = one("SELECT * FROM users WHERE id=?",Number(m[1])) || fail(404,"Staff not found.");
  if(!canManageUser(actor,target)) fail(403,"You cannot change this account.");
  if(target.id === actor.id && b.active === false) fail(400,"You cannot deactivate your own account.");
  if(b.role !== undefined && target.id === actor.id && b.role !== target.role) fail(400,"You cannot change your own role.");
  if(b.role !== undefined && !canGrant(actor,b.role)) fail(403,"You cannot give that role.");
  atomic(()=>{
    run("UPDATE users SET role=?,mm_eligible=?,active=? WHERE id=?",
      b.role ?? target.role, b.mm_eligible !== undefined ? (b.mm_eligible?1:0) : target.mm_eligible,
      b.active !== undefined ? (b.active?1:0) : target.active, target.id);
    if(b.active === false) run("DELETE FROM sessions WHERE user_id=?",target.id);
    audit(actor.id,"staff.update",String(target.id),JSON.stringify({role:b.role,mm_eligible:b.mm_eligible,active:b.active}));
  });
  return pub(one("SELECT * FROM users WHERE id=?",target.id));
});

// Saved clients: any signed-in staff can add and edit; admins can delete
R("GET","/api/clients",async req=>{
  need(req);
  return q("SELECT id,name,display_name,fb_url,created_at FROM clients ORDER BY name COLLATE NOCASE");
});
R("POST","/api/clients",async req=>{
  const u = need(req); const b = await readBody(req);
  const name = str(b.name,60), display = str(b.display_name,60), fb = str(b.fb_url,300);
  if(!name) fail(400,"Client name is required.");
  if(!FB.test(fb)) fail(400,"Use an https facebook.com page or profile link.");
  const r = run("INSERT INTO clients(name,display_name,fb_url,created_by,created_at) VALUES(?,?,?,?,?)",name,display,fb,u.id,now());
  return {id:Number(r.lastInsertRowid),name,display_name:display,fb_url:fb};
});
R("PATCH","/api/clients/(\\d+)",async (req,m)=>{
  need(req); const b = await readBody(req);
  const c = one("SELECT * FROM clients WHERE id=?",Number(m[1])) || fail(404,"Client not found.");
  const name = b.name !== undefined ? str(b.name,60) : c.name;
  const display = b.display_name !== undefined ? str(b.display_name,60) : c.display_name;
  const fb = b.fb_url !== undefined ? str(b.fb_url,300) : c.fb_url;
  if(!name) fail(400,"Client name is required.");
  if(!FB.test(fb)) fail(400,"Use an https facebook.com page or profile link.");
  run("UPDATE clients SET name=?,display_name=?,fb_url=? WHERE id=?",name,display,fb,c.id);
  return {id:c.id,name,display_name:display,fb_url:fb};
});
R("DELETE","/api/clients/(\\d+)",async (req,m)=>{
  const u = need(req,RANK_ADMIN);
  run("DELETE FROM clients WHERE id=?",Number(m[1]));
  audit(u.id,"client.delete",m[1],null);
  return {ok:true};
});


R("GET","/api/config",async ()=>({google_client_id: GOOGLE_CLIENT_ID || null}));

async function startSession(res,user){
  const tok = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",sha(tok),user.id,Date.now()+7*864e5);
  return full(200,{ok:true,user:pub(user)},{"Set-Cookie":`sid=${tok}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${7*86400}${COOKIE_SECURE?"; Secure":""}`});
}

R("POST","/api/auth/google",async req=>{
  if(!GOOGLE_CLIENT_ID) fail(404,"Google sign-in is not set up yet.");
  const b = await readBody(req);
  const cred = str(b.credential,4096); if(!cred) fail(400,"Missing Google credential.");
  let t;
  try{
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token="+encodeURIComponent(cred));
    if(!r.ok) fail(401,"Google sign-in failed.");
    t = await r.json();
  } catch(e){ if(e instanceof HttpError) throw e; fail(502,"Could not reach Google. Try again."); }
  if(t.aud !== GOOGLE_CLIENT_ID || !t.sub) fail(401,"Google sign-in failed.");
  let user = one("SELECT * FROM users WHERE google_sub=?",t.sub);
  if(!user){
    const name = str(t.name || t.given_name || "Visitor",60);
    const uname = "g_" + t.sub.slice(-12);
    run("INSERT INTO users(username,name,pass_hash,role,created_at,google_sub,onboarded) VALUES(?,?,?,?,?,?,0)",uname,name,"-","visitor",now(),t.sub);
    user = one("SELECT * FROM users WHERE google_sub=?",t.sub);
  }
  return startSession(null,user);
});

R("POST","/api/visitors",async req=>{
  if(limited("signup:"+req.socket.remoteAddress,10,3600e3)) fail(429,"Too many sign-ups from this network. Try again later.");
  const b = await readBody(req);
  const name = str(b.name,60), username = str(b.username,24), pw = String(b.password||"");
  if(!name) fail(400,"Name is required.");
  if(!validUsername(username)) fail(400,"Username: 3 to 24 letters, numbers, or underscores.");
  if(pw.length < 8) fail(400,"Password must be at least 8 characters.");
  if(one("SELECT id FROM users WHERE username=?",username)) fail(409,"That username is taken.");
  const id = run("INSERT INTO users(username,name,pass_hash,role,created_at,onboarded) VALUES(?,?,?,?,?,0)",username,name,hashPw(pw),"visitor",now()).lastInsertRowid;
  return startSession(null, one("SELECT * FROM users WHERE id=?",Number(id)));
});

R("PATCH","/api/onboarding",async req=>{
  const u = need(req,-1); const b = await readBody(req);
  const purposes = ["buying","selling","middleman","looking","other"];
  const purpose = str(b.purpose,20);
  if(!purposes.includes(purpose)) fail(400,"Please choose why you are here.");
  run("UPDATE users SET onboarded=1,purpose=?,referrer=?,join_stream=? WHERE id=?",purpose,str(b.referrer,120),b.join_stream===true?1:0,u.id);
  return pub(one("SELECT * FROM users WHERE id=?",u.id));
});

// Most requests: how often each person (by Facebook link) appears as buyer or seller. Names only, no links.
R("GET","/api/top-requesters",async ()=>{
  const rows = q("SELECT buyer_name AS n, buyer_fb AS f, created_at AS c FROM transactions UNION ALL SELECT seller_name, seller_fb, created_at FROM transactions");
  const m = new Map();
  for(const r of rows){
    const k = r.f.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/,"").replace(/[?#].*$/,"").replace(/\/+$/,"");
    const e = m.get(k) || {name:r.n, count:0, last:""};
    e.count++;
    if(r.c > e.last){ e.last = r.c; e.name = r.n; }
    m.set(k,e);
  }
  return [...m.values()].sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name)).slice(0,20).map(({name,count})=>({name,count}));
});

// Join GC links (public, configured by admins)
R("GET","/api/gc-links",async ()=>[1,2,3].map(slot=>({slot, url: one("SELECT value FROM settings WHERE key=?","gc_"+slot)?.value || null})));
R("PATCH","/api/gc-links",async req=>{
  const u = need(req,RANK_ADMIN); const b = await readBody(req);
  const slot = Number(b.slot);
  if(![1,2,3].includes(slot)) fail(400,"Slot must be 1, 2, or 3.");
  const url = str(b.url,300);
  if(url && !GC_URL.test(url)) fail(400,"Use an https Facebook or Messenger link.");
  if(url) run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value","gc_"+slot,url);
  else run("DELETE FROM settings WHERE key=?","gc_"+slot);
  audit(u.id,"gc.set",String(slot),url?"set":"cleared");
  return {slot, url: url || null};
});

// Public submission and tracking
R("POST","/api/transactions",async req=>{
  const ip = req.socket.remoteAddress;
  if(limited("submit:"+ip,10,3600e3)) fail(429,"Too many requests. Please try again later.");
  const b = await readBody(req);
  const v = {buyer_name:str(b.buyer_name,60),buyer_fb:str(b.buyer_fb,300),seller_name:str(b.seller_name,60),
    seller_fb:str(b.seller_fb,300),item:str(b.item,120),price:str(b.price,20),currency:str(b.currency,3),
    description:str(b.description,1000),extra:str(b.extra,1000)};
  if(!v.buyer_name) fail(400,"Buyer name is required.");
  if(!FB.test(v.buyer_fb)) fail(400,"Buyer Facebook link must be an https facebook.com profile URL.");
  if(!v.seller_name) fail(400,"Seller name is required.");
  if(!FB.test(v.seller_fb)) fail(400,"Seller Facebook link must be an https facebook.com profile URL.");
  if(!v.item) fail(400,"Item or service is required.");
  if(!/^\d{1,8}(\.\d{1,2})?$/.test(v.price) || Number(v.price) <= 0) fail(400,"Enter a positive price with up to 2 decimals.");
  if(!["PHP","USD","EUR"].includes(v.currency)) fail(400,"Unsupported currency.");
  if(!v.description) fail(400,"Please describe the transaction.");
  if(b.agree !== true) fail(400,"Both parties must agree before submitting.");
  const id = newTxId(), at = now();
  atomic(()=>{
    run(`INSERT INTO transactions(id,buyer_name,buyer_fb,seller_name,seller_fb,item,price_cents,currency,description,extra,status,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,id,v.buyer_name,v.buyer_fb,v.seller_name,v.seller_fb,v.item,
         Math.round(Number(v.price)*100),v.currency,v.description,v.extra,S.PENDING,at);
    run("INSERT INTO tx_history(tx_id,from_status,to_status,actor_id,reason,at) VALUES(?,?,?,?,?,?)",id,"(new)",S.PENDING,null,"Submitted",at);
    notifyManagers(`New request ${id}`,id);
  });
  return {id,status:S.PENDING};
});

R("GET","/api/track/(STB-[A-Z2-9]{5}-[A-Z2-9]{5})",async (req,m)=>{
  if(limited("track:"+req.socket.remoteAddress,60,60e3)) fail(429,"Too many requests.");
  const tx = getTx(m[1]);
  const timeline = q("SELECT to_status,at FROM tx_history WHERE tx_id=? ORDER BY id",tx.id).map(h=>({status:h.to_status,at:h.at}));
  return {id:tx.id,status:tx.status,created_at:tx.created_at,timeline};
});

R("GET","/api/transactions/([A-Z0-9-]+)",async (req,m)=>{
  const u = need(req); const tx = getTx(m[1]);
  if(!canManageTx(u) && tx.mm_id !== u.id) fail(403,"Not allowed.");
  const history = q("SELECT from_status,to_status,actor_id,reason,at FROM tx_history WHERE tx_id=? ORDER BY id",tx.id);
  return {...tx, price:tx.price_cents/100, price_cents:undefined, history};
});

R("GET","/api/transactions",async req=>{
  const u = need(req);
  const cols = "id,item,price_cents,currency,status,mm_id,open_dispute,created_at";
  const rows = canManageTx(u) ? q(`SELECT ${cols} FROM transactions ORDER BY created_at DESC`)
    : u.mm_eligible ? q(`SELECT ${cols} FROM transactions WHERE mm_id=? ORDER BY created_at DESC`,u.id) : [];
  return rows.map(r=>({...r,price:r.price_cents/100,price_cents:undefined}));
});

R("POST","/api/transactions/([A-Z0-9-]+)/assign",async (req,m)=>{
  const actor = need(req,RANK_MANAGE_TX); const b = await readBody(req);
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(![S.PENDING,S.AWAIT].includes(tx.status)) fail(409,"This request is not open for assignment.");
    const mm = one("SELECT * FROM users WHERE id=? AND active=1 AND mm_eligible=1",Number(b.mm_id));
    if(!mm) fail(400,"Selected user is not an active, eligible MM/MW.");
    const load = one("SELECT COUNT(*) c FROM transactions WHERE mm_id=? AND status NOT IN (?,?)",mm.id,S.DONE,S.CANCEL).c;
    if(load >= MAX_LOAD) fail(409,"This MM/MW is at their workload limit.");
    const updated = moveTx(tx,S.AWAIT,actor.id,"Assigned",{mm_id:mm.id});
    audit(actor.id,"tx.assign",tx.id,`to ${mm.username}`);
    return {id:updated.id,status:updated.status,mm_id:updated.mm_id};
  });
});

R("POST","/api/transactions/([A-Z0-9-]+)/respond",async (req,m)=>{
  const u = need(req); const b = await readBody(req);
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(tx.mm_id !== u.id) fail(403,"Only the assigned MM/MW can respond.");
    if(tx.status !== S.AWAIT) fail(409,"Nothing to respond to.");
    const updated = b.accept === true
      ? moveTx(tx,S.ASSIGNED,u.id,"Accepted")
      : moveTx(tx,S.PENDING,u.id,"Declined by MM/MW",{mm_id:null});
    return {id:updated.id,status:updated.status};
  });
});

R("POST","/api/transactions/([A-Z0-9-]+)/transition",async (req,m)=>{
  const u = need(req); const b = await readBody(req);
  const to = str(b.to,40), reason = str(b.reason,300);
  if(!Object.values(S).includes(to)) fail(400,"Unknown status.");
  if([S.ASSIGNED,S.AWAIT].includes(to)) fail(400,"Use assignment and acceptance to set this status.");
  const manage = canManageTx(u);
  if(!manage && (ADMIN_ONLY_TO.includes(to) || !u.mm_eligible)) fail(403,"Not allowed to set that status.");
  if([S.DISP,S.CANCEL].includes(to) && reason.length < 3) fail(400,"A reason is required for this status.");
  return atomic(()=>{
    const tx = getTx(m[1]);
    if(!manage && tx.mm_id !== u.id) fail(403,"Only the assigned MM/MW or a manager can update this.");
    const updated = moveTx(tx,to,u.id,reason);
    if(manage) audit(u.id,"tx.transition",tx.id,`${tx.status} to ${to}`);
    return {id:updated.id,status:updated.status};
  });
});

R("GET","/api/notifications",async req=>{
  const u = need(req);
  const rows = q("SELECT id,tx_id,text,read,at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 100",u.id);
  return {unread:rows.filter(r=>!r.read).length,items:rows.map(r=>({...r,read:!!r.read}))};
});
R("POST","/api/notifications/read-all",async req=>{
  const u = need(req); run("UPDATE notifications SET read=1 WHERE user_id=?",u.id); return {ok:true};
});

// Public directory, leaderboard, and overview: only opted-in MMs, no usernames, no links
R("GET","/api/mms",async ()=>q(`
  SELECT u.id,u.name,u.bio,u.specialties,
    (SELECT COUNT(*) FROM transactions t WHERE t.mm_id=u.id AND t.status NOT IN ('${S.DONE}','${S.CANCEL}')) AS holding,
    (SELECT COUNT(*) FROM transactions t WHERE t.mm_id=u.id AND t.status='${S.DONE}') AS completed
  FROM users u WHERE u.mm_eligible=1 AND u.active=1 AND u.show_public=1 ORDER BY holding DESC, u.name`));

R("GET","/api/leaderboard",async ()=>q(`
  SELECT u.id,u.name,COUNT(t.id) AS completed
  FROM transactions t JOIN users u ON u.id=t.mm_id
  WHERE t.status='${S.DONE}' AND u.show_public=1 GROUP BY u.id ORDER BY completed DESC, u.name LIMIT 50`));

R("GET","/api/overview",async ()=>{
  const fee = Number(one("SELECT value FROM settings WHERE key='fee_percent'")?.value || 0);
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const month_completed = one("SELECT COUNT(*) n FROM transactions WHERE status=? AND completed_at>=?", S.DONE, monthStart).n;
  const by_currency = q("SELECT currency,COUNT(*) n,SUM(price_cents) cents FROM transactions WHERE status=? GROUP BY currency", S.DONE)
    .map(r=>({currency:r.currency,count:r.n,value:r.cents/100,est_fee:Math.round(r.cents*fee/100)/100}));
  const days = [];
  for(let i=29;i>=0;i--){ const d = new Date(); d.setUTCHours(0,0,0,0); d.setUTCDate(d.getUTCDate()-i); days.push(d.toISOString().slice(0,10)); }
  const rows = q("SELECT substr(completed_at,1,10) day,currency,COUNT(*) n,SUM(price_cents) cents FROM transactions WHERE status=? AND completed_at>=? GROUP BY day,currency", S.DONE, days[0]+"T00:00:00.000Z");
  const series = days.map(day=>{
    const r = {day, completions:0, value:{}, fees:{}};
    for(const x of rows.filter(x=>x.day===day)){ r.completions += x.n; r.value[x.currency] = x.cents/100; r.fees[x.currency] = Math.round(x.cents*fee/100)/100; }
    return r;
  });
  return {fee_percent:fee, month_completed, by_currency, series};
});

// Revenue, settings, audit
R("GET","/api/revenue",async req=>{
  need(req,RANK_ADMIN);
  const fee = Number(one("SELECT value FROM settings WHERE key='fee_percent'")?.value || 0);
  const byCurrency = q(`SELECT currency,COUNT(*) AS count,SUM(price_cents) AS cents FROM transactions WHERE status='${S.DONE}' GROUP BY currency`)
    .map(r=>({currency:r.currency,count:r.count,value:r.cents/100,est_fee:Math.round(r.cents*fee/100)/100}));
  const counts = Object.fromEntries(q("SELECT status,COUNT(*) AS n FROM transactions GROUP BY status").map(r=>[r.status,r.n]));
  const monthly = q(`SELECT substr(completed_at,1,7) AS month,COUNT(*) AS count FROM transactions WHERE status='${S.DONE}' GROUP BY month ORDER BY month DESC LIMIT 6`);
  return {fee_percent:fee,by_currency:byCurrency,counts,monthly};
});

R("PATCH","/api/settings",async req=>{
  const u = need(req,RANK_OWNER); const b = await readBody(req);
  const fee = Number(b.fee_percent);
  if(!(fee >= 0 && fee <= 50)) fail(400,"Fee must be between 0 and 50.");
  run("INSERT INTO settings(key,value) VALUES('fee_percent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",String(fee));
  audit(u.id,"settings.fee",null,String(fee));
  return {fee_percent:fee};
});

R("GET","/api/audit",async req=>{
  need(req,RANK_ADMIN);
  return q("SELECT a.id,u.username AS actor,a.action,a.target,a.detail,a.at FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200");
});

// ---------- startup ----------
if(!one("SELECT id FROM users LIMIT 1")){
  const code = crypto.randomBytes(6).toString("hex").toUpperCase().match(/.{4}/g).join("-");
  run("INSERT OR REPLACE INTO settings(key,value) VALUES('setup_hash',?)",sha(code));
  console.log(`First run. Owner setup code (shown once): ${code}`);
}

async function handle(req,res){
  const url = new URL(req.url,"http://localhost");
  if(!url.pathname.startsWith("/api/")){
    if(req.method !== "GET") return send(res,405,{error:"Method not allowed."});
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":"default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; frame-src https://accounts.google.com; connect-src 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'","X-Frame-Options":"DENY","X-Content-Type-Options":"nosniff","Cache-Control":"no-cache"});
    return res.end(INDEX);
  }
  const route = routes.find(r=>r.m===req.method && r.p.test(url.pathname));
  if(!route) return send(res,404,{error:"Not found."});
  const m = route.p.exec(url.pathname);
  const out = await route.h(req,m,url);
  if(out && out.__full) return send(res,out.code,out.body,out.headers);
  return send(res,200,out ?? {ok:true});
}

http.createServer((req,res)=>{
  handle(req,res).catch(e=>{
    if(e instanceof HttpError) return send(res,e.code,{error:e.message});
    console.error(e); send(res,500,{error:"Server error."});
  });
}).listen(PORT,()=>console.log(`Solar BNST API listening on http://localhost:${PORT}`));
