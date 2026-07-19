import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3001);
const SUPABASE_URL = process.env.SUPABASE_URL || "http://host.docker.internal:8000";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean));
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL || "https://flyway-app.zileslabs.com";
const limits = new Map();
const loginFailures = new Map();

if (!SERVICE_KEY || !ANON_KEY) throw new Error("Supabase keys are required");

function cors(origin) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    ...(allowed ? { "Access-Control-Allow-Origin": allowed } : {}),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Vary": "Origin",
  };
}

function json(res, status, body, origin) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors(origin) });
  res.end(JSON.stringify(body));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32_000) throw Object.assign(new Error("Request too large"), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

async function binaryBody(req, max = 5_242_880) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error("Image must be 5 MB or smaller"), { status: 413 }); chunks.push(chunk); }
  if (!size) throw Object.assign(new Error("Image is required"), { status: 400 });
  return Buffer.concat(chunks);
}

function rateLimit(req, max = 60) {
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
  const window = Math.floor(Date.now() / 60_000);
  const key = `${ip}:${window}:${req.method}:${new URL(req.url, "http://api").pathname}`;
  const count = (limits.get(key) || 0) + 1;
  limits.set(key, count);
  if (limits.size > 10_000) limits.clear();
  if (count > max) throw Object.assign(new Error("Rate limit exceeded"), { status: 429 });
}

async function supabase(path, { method = "GET", token = SERVICE_KEY, data, prefer } = {}) {
  const response = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: token,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(result?.message || result?.msg || "Database request failed"), { status: response.status });
  return result;
}

async function currentUser(req) {
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required"), { status: 401 });
  const token = authorization.slice(7);
  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) throw Object.assign(new Error("Invalid or expired session"), { status: 401 });
  return { user: await response.json(), token };
}

async function authRequest(path, data, token) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token || ANON_KEY}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(result?.msg || result?.message || result?.error_description || "Authentication failed"), { status: response.status });
  return result;
}

async function authAdmin(path, { method = "GET", data } = {}) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(result?.msg || result?.message || "Authentication administration failed"), { status: response.status });
  return result;
}

async function ensureProfile(user) {
  await supabase("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    data: { id: user.id, display_name: user.user_metadata?.display_name || user.email?.split("@")[0] || "Hunter" },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

async function activeUser(req) {
  const { user, token } = await currentUser(req); await ensureProfile(user);
  const rows = await supabase(`/rest/v1/profiles?id=eq.${user.id}&select=role,suspended_until`);
  if (rows[0]?.suspended_until && new Date(rows[0].suspended_until) > new Date()) throw Object.assign(new Error("Account is temporarily suspended"), { status: 403 });
  return { user, token, role: rows[0]?.role || "user" };
}

async function requireRole(req, allowed) {
  const actor = await activeUser(req);
  if (!allowed.includes(actor.role)) throw Object.assign(new Error("Insufficient permissions"), { status: 403 });
  return actor;
}

async function audit(actorId, action, targetType, targetId, details = {}) {
  await supabase("/rest/v1/admin_audit_log", { method:"POST", data:{ actor_id:actorId, action, target_type:targetType, target_id:String(targetId || ""), details }, prefer:"return=minimal" });
}
function requestContext(req){const raw=String(req.headers["cf-connecting-ip"]||req.socket.remoteAddress||"");const ip_prefix=raw.includes(":")?raw.split(":").slice(0,4).join(":")+"::":raw.split(".").slice(0,3).join(".")+".0/24";return{ip_prefix,user_agent:String(req.headers["user-agent"]||"").slice(0,300),request_id:String(req.headers["cf-ray"]||crypto.randomUUID()).slice(0,80)}}
async function auditRequest(req,actorId,action,targetType,targetId,details={}){await audit(actorId,action,targetType,targetId,{...details,request_context:requestContext(req)})}
async function userActivity(req,userId,action,targetType,targetId,outcome="success",before=null,after=null){try{await supabase("/rest/v1/user_activity_log",{method:"POST",data:{user_id:userId,action,target_type:targetType,target_id:String(targetId||""),outcome,before_state:before,after_state:after,request_context:requestContext(req),session_id:jwtPayload((req.headers.authorization||"").replace(/^Bearer /,""))?.session_id||null},prefer:"return=minimal"})}catch(error){console.error("user-activity",error.message)}}
async function configValue(key, fallback) { const rows=await supabase(`/rest/v1/app_config?key=eq.${key}&select=value`); return rows[0]?.value||fallback; }
function normalizedEmail(value){return String(value||"").trim().toLowerCase();}
function ipHash(req){return crypto.createHash("sha256").update(String(req.headers["cf-connecting-ip"]||req.socket.remoteAddress||"unknown")+":"+(process.env.SECURITY_HASH_SALT||"flyway")).digest("hex");}
async function securityEvent(req,event_type,outcome,user_id=null,details={}){try{await supabase("/rest/v1/security_events",{method:"POST",data:{user_id,event_type,outcome,ip_hash:ipHash(req),details},prefer:"return=minimal"});}catch(error){console.error("security-event",error.message);}}
function safeEmailKey(email){return crypto.createHash("sha256").update(normalizedEmail(email)).digest("hex");}
async function sendRecovery(email){return authRequest(`/recover?redirect_to=${encodeURIComponent(`${PUBLIC_APP_URL}/auth/reset-password`)}`,{email});}
function jwtPayload(token){try{return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString())}catch{return{}}}
function publicName(profile){if(profile?.show_attribution===false)return"Flyway member";const first=String(profile?.first_name||"").trim();const last=String(profile?.last_name||"").trim();return first?`${first}${last?` ${last[0].toUpperCase()}.`:""}`:"Flyway member"}
function observedWeather(input){if(!input||typeof input!=="object"||Array.isArray(input))return null;const allowed={sky:["clear","partly_cloudy","overcast","fog"],precipitation:["none","drizzle","rain","snow","sleet"],wind:["calm","light","moderate","strong"],wind_direction:["N","NE","E","SE","S","SW","W","NW"],visibility:["good","moderate","poor"]};const result={};for(const[key,values]of Object.entries(allowed)){if(input[key]&&values.includes(input[key]))result[key]=input[key]}const temperature=Number(input.temperature);if(Number.isFinite(temperature)&&temperature>=-100&&temperature<=150)result.temperature=temperature;if(["F","C"].includes(input.temperature_unit))result.temperature_unit=input.temperature_unit;return Object.keys(result).length?result:null}
function requestedRange(url,defaultDays=7){const endRaw=url.searchParams.get("end"),startRaw=url.searchParams.get("start");const end=endRaw?new Date(endRaw):new Date();const days=Math.min(365,Math.max(1,Number(url.searchParams.get("days"))||defaultDays));const start=startRaw?new Date(startRaw):new Date(end.getTime()-days*86400000);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start>end||end.getTime()>Date.now()+300000)throw Object.assign(new Error("Invalid date range"),{status:400});if(end.getTime()-start.getTime()>365*86400000)throw Object.assign(new Error("Date range cannot exceed one year"),{status:400});return{start,end}}
async function rememberSession(req,result){const token=result?.access_token,user=result?.user;if(!token||!user?.id)return;const sid=jwtPayload(token).session_id||crypto.createHash("sha256").update(token).digest("hex").slice(0,36);const ua=String(req.headers["user-agent"]||"Unknown device").slice(0,180);await supabase("/rest/v1/app_sessions?on_conflict=user_id,session_id",{method:"POST",data:{user_id:user.id,session_id:sid,device:ua,ip_hash:ipHash(req),last_seen_at:new Date().toISOString(),revoked_at:null},prefer:"resolution=merge-duplicates,return=minimal"});}
async function weatherSnapshot(latitude,longitude){try{const lat=Math.round(latitude*4)/4,lon=Math.round(longitude*4)/4;const response=await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m&daily=sunrise,sunset&timezone=auto&forecast_days=1`);if(!response.ok)return null;const w=await response.json();return{captured_at:w.current?.time,temperature:w.current?.temperature_2m,temperature_unit:w.current_units?.temperature_2m,wind_speed:w.current?.wind_speed_10m,wind_unit:w.current_units?.wind_speed_10m,wind_direction:w.current?.wind_direction_10m,precipitation:w.current?.precipitation,cloud_cover:w.current?.cloud_cover,pressure_msl:w.current?.pressure_msl,sunrise:w.daily?.sunrise?.[0],sunset:w.daily?.sunset?.[0],source:"Open-Meteo",location_precision:"regional"};}catch{return null}}
function scrubImage(bytes,mime){if(mime==="image/jpeg"&&bytes[0]===0xff&&bytes[1]===0xd8){const out=[bytes.subarray(0,2)];let i=2;while(i+4<=bytes.length){if(bytes[i]!==0xff){out.push(bytes.subarray(i));break}const marker=bytes[i+1];if(marker===0xda){out.push(bytes.subarray(i));break}const len=bytes.readUInt16BE(i+2);if(len<2||i+2+len>bytes.length)break;if(![0xe1,0xe2,0xed,0xfe].includes(marker))out.push(bytes.subarray(i,i+2+len));i+=2+len}return Buffer.concat(out)}if(mime==="image/png"&&bytes.subarray(1,4).toString()==="PNG"){const out=[bytes.subarray(0,8)],blocked=new Set(["eXIf","tEXt","zTXt","iTXt","tIME"]);let i=8;while(i+12<=bytes.length){const length=bytes.readUInt32BE(i),end=i+12+length;if(end>bytes.length)break;const type=bytes.subarray(i+4,i+8).toString();if(!blocked.has(type))out.push(bytes.subarray(i,end));i=end;if(type==="IEND")break}return Buffer.concat(out)}if(mime==="image/webp"&&bytes.subarray(0,4).toString()==="RIFF"&&bytes.subarray(8,12).toString()==="WEBP"){const chunks=[];let i=12;while(i+8<=bytes.length){const type=bytes.subarray(i,i+4).toString(),size=bytes.readUInt32LE(i+4),end=i+8+size+(size%2);if(end>bytes.length)break;if(!["EXIF","XMP ","ICCP"].includes(type))chunks.push(bytes.subarray(i,end));i=end}const payload=Buffer.concat([Buffer.from("WEBP"),...chunks]),head=Buffer.alloc(8);head.write("RIFF");head.writeUInt32LE(payload.length,4);return Buffer.concat([head,payload])}return bytes;}
async function notify(userId,type,title,bodyText,href=null){if(!userId)return;await supabase("/rest/v1/notifications",{method:"POST",data:{user_id:userId,type,title,body:bodyText,href},prefer:"return=minimal"});}

const species = new Set(["mallard", "teal", "gadwall", "pintail", "wood_duck", "diver", "mixed", "other", "canada_goose", "snow_goose", "white_fronted_goose", "sandhill_crane", "tundra_swan"]);
const flockSizes = new Set(["1-10", "10-25", "25-50", "50+"]);
const behaviors = new Set(["feeding", "circling", "flying_over", "resting", "moving_in"]);

function validateSighting(input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!flockSizes.has(input.flock_size) || !behaviors.has(input.behavior)) throw Object.assign(new Error("Invalid sighting details"), { status: 400 });
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw Object.assign(new Error("Invalid coordinates"), { status: 400 });
  return { latitude, longitude };
}

const preferenceGroups = ["ducks", "geese", "cranes", "doves", "shorebirds", "upland", "other"];
const defaultPreferences = { visible_groups: preferenceGroups, default_days: 7, start_view: "us", auto_open_card: true };
function validatePreferences(input = {}) {
  const groups = Array.isArray(input.visible_groups) ? input.visible_groups.filter(v => preferenceGroups.includes(v)) : defaultPreferences.visible_groups;
  return {
    visible_groups: [...new Set(groups)],
    default_days: [1, 7, 30, 90].includes(Number(input.default_days)) ? Number(input.default_days) : 7,
    start_view: ["us", "world", "my_area"].includes(input.start_view) ? input.start_view : "us",
    auto_open_card: input.auto_open_card !== false,
  };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === "OPTIONS") { res.writeHead(origin && ALLOWED_ORIGINS.has(origin) ? 204 : 403, cors(origin)); return res.end(); }
  if (origin && !ALLOWED_ORIGINS.has(origin)) return json(res, 403, { error: "Origin not allowed" }, origin);

  try {
    const url = new URL(req.url, "http://api");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" }, origin);

    if (req.method === "POST" && url.pathname === "/api/auth/signup") {
      rateLimit(req, 5);
      const input = await body(req);
      if (!input.email || typeof input.password !== "string" || input.password.length < 8) throw Object.assign(new Error("A valid email and 8-character password are required"), { status: 400 });
      const result = await authRequest("/signup", { email: input.email, password: input.password, data: { display_name: input.display_name || "Hunter" } });
      return json(res, 201, result, origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      rateLimit(req, 10);
      const input = await body(req);
      const email=normalizedEmail(input.email),key=`${safeEmailKey(email)}:${ipHash(req)}`;const state=loginFailures.get(key)||{count:0,lockedUntil:0};
      if(state.lockedUntil>Date.now()){await securityEvent(req,"login","locked",null,{email_hash:safeEmailKey(email)});throw Object.assign(new Error("Sign-in temporarily unavailable. Try again later or reset your password."),{status:429});}
      try{const result = await authRequest("/token?grant_type=password", { email, password: input.password });loginFailures.delete(key);await rememberSession(req,result);await securityEvent(req,"login","success",result.user?.id);return json(res, 200, result, origin);}
      catch(error){state.count++;if(state.count>=8)state.lockedUntil=Date.now()+15*60_000;loginFailures.set(key,state);await securityEvent(req,"login","failure",null,{email_hash:safeEmailKey(email),attempts:state.count});throw Object.assign(new Error("Invalid email or password"),{status:error.status===429?429:400});}
    }

    if (req.method === "POST" && url.pathname === "/api/auth/recover") {
      rateLimit(req, 4);const input=await body(req);const email=normalizedEmail(input.email);
      if(email&&email.includes("@")){try{await sendRecovery(email);await securityEvent(req,"password_recovery","requested",null,{email_hash:safeEmailKey(email)});}catch(error){await securityEvent(req,"password_recovery","delivery_failed",null,{email_hash:safeEmailKey(email)});console.error("recovery-delivery",error.message);}}
      return json(res,202,{message:"If an account exists, a recovery link has been sent."},origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/password") {
      rateLimit(req,5);const {user,token}=await currentUser(req);const input=await body(req);const next=String(input.password||"");
      if(next.length<12||!/[a-z]/i.test(next)||!/[0-9]/.test(next))throw Object.assign(new Error("Use at least 12 characters with letters and numbers"),{status:400});
      const response=await fetch(`${SUPABASE_URL}/auth/v1/user`,{method:"PUT",headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({password:next})});const result=await response.json();
      if(!response.ok)throw Object.assign(new Error(result?.message||"Password change failed"),{status:response.status});await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}/logout`,{method:"POST",headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});await securityEvent(req,"password_change","success",user.id);return json(res,200,{message:"Password updated. Other sessions were signed out."},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/auth/mfa") {
      const {user,token}=await currentUser(req);const response=await fetch(`${SUPABASE_URL}/auth/v1/user/factors`,{headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`}});const factors=response.ok?await response.json():[];const policy=await configValue("security",{mfa_policy:"optional",admin_totp_required:false,moderator_totp_required:false});return json(res,200,{user_id:user.id,factors,policy},origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/mfa/enroll") {
      rateLimit(req,5);const {user,token}=await currentUser(req);const response=await fetch(`${SUPABASE_URL}/auth/v1/factors`,{method:"POST",headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({factor_type:"totp",friendly_name:"Flyway authenticator"})});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result?.message||"MFA enrollment failed"),{status:response.status});await securityEvent(req,"mfa_enroll","started",user.id);return json(res,201,result,origin);
    }

    const mfaChallenge=url.pathname.match(/^\/api\/auth\/mfa\/([0-9a-f-]{36})\/challenge$/i);
    if(req.method==="POST"&&mfaChallenge){rateLimit(req,8);const {token}=await currentUser(req);const response=await fetch(`${SUPABASE_URL}/auth/v1/factors/${mfaChallenge[1]}/challenge`,{method:"POST",headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:"{}"});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result?.message||"MFA challenge failed"),{status:response.status});return json(res,200,result,origin);}
    const mfaVerify=url.pathname.match(/^\/api\/auth\/mfa\/([0-9a-f-]{36})\/verify$/i);
    if(req.method==="POST"&&mfaVerify){rateLimit(req,8);const {user,token}=await currentUser(req);const input=await body(req);const response=await fetch(`${SUPABASE_URL}/auth/v1/factors/${mfaVerify[1]}/verify`,{method:"POST",headers:{apikey:ANON_KEY,Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({challenge_id:input.challenge_id,code:String(input.code||"")})});const result=await response.json();if(!response.ok)throw Object.assign(new Error(result?.message||"Invalid verification code"),{status:response.status});await securityEvent(req,"mfa_verify","success",user.id);return json(res,200,result,origin);}

    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
      rateLimit(req, 30);
      const input = await body(req);
      const result = await authRequest("/token?grant_type=refresh_token", { refresh_token: input.refresh_token });await rememberSession(req,result);
      return json(res, 200, result, origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      rateLimit(req, 10);
      const authorization = req.headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required"), { status: 401 });
      const actor=await currentUser(req);await authRequest("/logout", undefined, authorization.slice(7));await userActivity(req,actor.user.id,"session.signout","session",jwtPayload(authorization.slice(7)).session_id);
      return json(res, 204, null, origin);
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const { user } = await currentUser(req);
      await ensureProfile(user);
      const rows = await supabase(`/rest/v1/profiles?id=eq.${user.id}&select=display_name,first_name,last_name,bio,region,distance_units,show_attribution,notification_preferences,preferences,role,suspended_until`);const p=rows[0]||{};
      const legacyName=String(p.display_name||"").trim().split(/\s+/);return json(res, 200, { id:user.id,email:user.email,display_name:p.display_name||user.email?.split("@")[0],first_name:p.first_name||legacyName[0]||"",last_name:p.last_name||legacyName.slice(1).join(" ")||"",bio:p.bio||"",region:p.region||"",distance_units:p.distance_units||"miles",show_attribution:p.show_attribution!==false,notification_preferences:p.notification_preferences||{},preferences:validatePreferences(p.preferences),role:p.role||"user",suspended_until:p.suspended_until }, origin);
    }

    if (req.method === "PATCH" && url.pathname === "/api/profile") {
      rateLimit(req, 30);
      const { user } = await activeUser(req);
      const input = await body(req);
      const update={};if(input.preferences)update.preferences=validatePreferences(input.preferences);if(typeof input.display_name==="string")update.display_name=input.display_name.trim().slice(0,80)||"Flyway member";if(typeof input.first_name==="string")update.first_name=input.first_name.trim().slice(0,50)||null;if(typeof input.last_name==="string")update.last_name=input.last_name.trim().slice(0,80)||null;if(typeof input.bio==="string")update.bio=input.bio.trim().slice(0,280)||null;if(typeof input.region==="string")update.region=input.region.trim().slice(0,80)||null;if(["miles","kilometers"].includes(input.distance_units))update.distance_units=input.distance_units;if(typeof input.show_attribution==="boolean")update.show_attribution=input.show_attribution;if(input.notification_preferences&&typeof input.notification_preferences==="object")update.notification_preferences=input.notification_preferences;if(!Object.keys(update).length)throw Object.assign(new Error("No valid profile changes"),{status:400});
      const before=await supabase(`/rest/v1/profiles?id=eq.${user.id}&select=display_name,first_name,last_name,bio,region,distance_units,show_attribution,notification_preferences,preferences`);await supabase(`/rest/v1/profiles?id=eq.${user.id}`, { method:"PATCH",data:update,prefer:"return=minimal" });await userActivity(req,user.id,"profile.update","profile",user.id,"success",before[0]||null,update);return json(res,200,{...update},origin);
    }

    if(req.method==="GET"&&url.pathname==="/api/account/sessions"){const{user,token}=await currentUser(req);const sid=jwtPayload(token).session_id;const rows=await supabase(`/rest/v1/app_sessions?user_id=eq.${user.id}&revoked_at=is.null&select=id,session_id,device,last_seen_at,created_at&order=last_seen_at.desc`);return json(res,200,{sessions:rows.map(row=>({...row,current:row.session_id===sid}))},origin)}
    if(req.method==="POST"&&url.pathname==="/api/account/signout-all"){rateLimit(req,3);const{user}=await currentUser(req);await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}/logout`,{method:"POST",headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});await supabase(`/rest/v1/app_sessions?user_id=eq.${user.id}&revoked_at=is.null`,{method:"PATCH",data:{revoked_at:new Date().toISOString()},prefer:"return=minimal"});await securityEvent(req,"signout_all","success",user.id);return json(res,200,{message:"All sessions signed out"},origin)}
    if(req.method==="GET"&&url.pathname==="/api/notifications"){const{user}=await activeUser(req);const rows=await supabase(`/rest/v1/notifications?user_id=eq.${user.id}&select=*&order=created_at.desc&limit=100`);return json(res,200,{notifications:rows},origin)}
    if(req.method==="POST"&&url.pathname==="/api/notifications/read-all"){const{user}=await activeUser(req);await supabase(`/rest/v1/notifications?user_id=eq.${user.id}&read_at=is.null`,{method:"PATCH",data:{read_at:new Date().toISOString()},prefer:"return=minimal"});return json(res,204,null,origin)}
    if(req.method==="GET"&&url.pathname==="/api/locations/popular"){return json(res,200,{locations:[{id:"platte",label:"Central Platte River, Nebraska",latitude:40.82,longitude:-98.55,zoom:8,flyway:"Central"},{id:"sacramento",label:"Sacramento Valley, California",latitude:39.4,longitude:-121.8,zoom:7,flyway:"Pacific"},{id:"prairie",label:"Prairie Pothole Region",latitude:47.1,longitude:-99.2,zoom:6,flyway:"Central"},{id:"upper-mississippi",label:"Upper Mississippi River",latitude:43.3,longitude:-91.2,zoom:7,flyway:"Mississippi"},{id:"chesapeake",label:"Chesapeake Bay",latitude:38.6,longitude:-76.2,zoom:7,flyway:"Atlantic"},{id:"gulf",label:"Louisiana Gulf Coast",latitude:29.6,longitude:-91.2,zoom:7,flyway:"Mississippi"}]},origin)}
    if(req.method==="GET"&&url.pathname==="/api/locations/saved"){const{user}=await activeUser(req);const rows=await supabase(`/rest/v1/saved_locations?user_id=eq.${user.id}&select=id,label,latitude,longitude,zoom,sort_order,is_default&order=sort_order.asc,label.asc`);return json(res,200,{locations:rows},origin)}
    if(req.method==="POST"&&url.pathname==="/api/locations/saved"){rateLimit(req,20);const{user}=await activeUser(req);const input=await body(req),lat=Math.round(Number(input.latitude)*100)/100,lon=Math.round(Number(input.longitude)*100)/100;if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<-85||lat>85||lon<-180||lon>180)throw Object.assign(new Error("Invalid saved location"),{status:400});const rows=await supabase("/rest/v1/saved_locations",{method:"POST",data:{user_id:user.id,label:String(input.label||"Saved view").trim().slice(0,80),latitude:lat,longitude:lon,zoom:Math.min(15,Math.max(2,Number(input.zoom)||7))},prefer:"return=representation"});await userActivity(req,user.id,"location.save","saved_location",rows[0].id);return json(res,201,{location:rows[0]},origin)}
    const savedLocation=url.pathname.match(/^\/api\/locations\/saved\/([0-9a-f-]{36})$/i);if(req.method==="DELETE"&&savedLocation){const{user}=await activeUser(req);await supabase(`/rest/v1/saved_locations?id=eq.${savedLocation[1]}&user_id=eq.${user.id}`,{method:"DELETE",prefer:"return=minimal"});await userActivity(req,user.id,"location.delete","saved_location",savedLocation[1]);return json(res,204,null,origin)}
    if(req.method==="GET"&&url.pathname==="/api/regulations"){const jurisdiction=String(url.searchParams.get("jurisdiction")||"").slice(0,80);const speciesSlug=String(url.searchParams.get("species")||"").slice(0,80);const filters=["status=eq.active",jurisdiction?`jurisdiction=eq.${encodeURIComponent(jurisdiction)}`:"",speciesSlug?`species_slug=eq.${encodeURIComponent(speciesSlug)}`:""].filter(Boolean).join("&");const rows=await supabase(`/rest/v1/hunting_regulations?${filters}&select=*&order=effective_at.desc&limit=50`);return json(res,200,{regulations:rows,disclaimer:"Informational only. Verify current federal, state, tribal, refuge, local, and property-specific rules with the responsible wildlife agency."},origin)}

    if (req.method === "GET" && url.pathname === "/api/sightings") {
      rateLimit(req, 120);
      const mapConfig=await configValue("map",{default_days:7,max_days:90,max_results:250});
      const range=requestedRange(url,Number(mapConfig.default_days||7));const rows = await supabase("/rest/v1/rpc/nearby_sightings", { method: "POST", token: ANON_KEY, data: { p_limit: Math.min(Number(url.searchParams.get("limit")) || 500,1000), p_since:range.start.toISOString() } });return json(res, 200, { sightings:rows.filter(row=>new Date(row.occurred_at)<=range.end),range:{start:range.start,end:range.end} }, origin);
    }

    if(req.method==="GET"&&url.pathname==="/api/map/heatmap"){
      rateLimit(req,120);const mapConfig=await configValue("map_layers",{minimum_heat_reports:3,grid_degrees:4});const range=requestedRange(url,7);const rows=await supabase("/rest/v1/rpc/activity_heatmap",{method:"POST",token:ANON_KEY,data:{p_since:range.start.toISOString(),p_grid_degrees:Math.max(2,Number(mapConfig.grid_degrees)||4),p_minimum:Math.max(3,Number(mapConfig.minimum_heat_reports)||3)}});return json(res,200,{cells:rows,range},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/catalog") {
      const [categories, catalog] = await Promise.all([supabase("/rest/v1/bird_categories?enabled=eq.true&select=slug,display_name,sort_order&order=sort_order.asc"),supabase("/rest/v1/species_catalog?enabled=eq.true&select=slug,display_name,category_slug,sort_order&order=sort_order.asc")]);
      return json(res,200,{categories,species:catalog},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      const rows=await supabase("/rest/v1/app_config?key=in.(reporting,moderation,map)&select=key,value");
      return json(res,200,{config:Object.fromEntries(rows.map(row=>[row.key,row.value]))},origin);
    }

    if (req.method === "POST" && url.pathname === "/api/sightings") {
      rateLimit(req, 10);
      const reportingConfig=await configValue("reporting",{enabled:true});if(reportingConfig.enabled===false)throw Object.assign(new Error("Reporting is temporarily disabled"),{status:503});
      const { user } = await activeUser(req);
      const input = await body(req);
      const { latitude, longitude } = validateSighting(input);
      const catalog = await supabase(`/rest/v1/species_catalog?slug=eq.${encodeURIComponent(input.species)}&enabled=eq.true&select=slug`);
      if (!catalog.length) throw Object.assign(new Error("Bird type is not currently available"), { status:400 });
      const [profileRows,weather]=await Promise.all([supabase(`/rest/v1/profiles?id=eq.${user.id}&select=first_name,last_name,show_attribution`),weatherSnapshot(latitude,longitude)]);const attribution=publicName(profileRows[0]);
      const rows = await supabase("/rest/v1/sightings", { method: "POST", data: {
        reporter_id: user.id, species_slug: input.species, flock_size: input.flock_size, behavior: input.behavior,
        exact_latitude: latitude, exact_longitude: longitude, accuracy_meters: Math.min(Math.max(Number(input.accuracy_meters) || 0, 0), 10000),
        notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) || null : null,weather,observed_weather:observedWeather(input.observed_weather),reporter_attribution:attribution,
      }, prefer: "return=representation" });
      const nearby=await supabase(`/rest/v1/sightings?id=neq.${rows[0].id}&species_slug=eq.${encodeURIComponent(input.species)}&status=eq.active&occurred_at=gte.${encodeURIComponent(new Date(Date.now()-3*3600000).toISOString())}&exact_latitude=gte.${latitude-.18}&exact_latitude=lte.${latitude+.18}&exact_longitude=gte.${longitude-.22}&exact_longitude=lte.${longitude+.22}&select=id,exact_latitude,exact_longitude&limit=5`);for(const other of nearby){const similarity=Math.max(60,Math.round(100-Math.hypot((other.exact_latitude-latitude)*69,(other.exact_longitude-longitude)*55)*4));const pair=[rows[0].id,other.id].sort();await supabase("/rest/v1/duplicate_candidates?on_conflict=sighting_a,sighting_b",{method:"POST",data:{sighting_a:pair[0],sighting_b:pair[1],similarity},prefer:"resolution=ignore-duplicates,return=minimal"});await supabase("/rest/v1/moderation_cases",{method:"POST",data:{content_type:"sighting",content_id:rows[0].id,reason:`possible_duplicate:${other.id}`},prefer:"return=minimal"});}
      return json(res, 201, { id: rows[0].id, expires_at: rows[0].expires_at }, origin);
    }

    const photos = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/photos$/i);
    if (photos && req.method === "GET") {
      const rows = await supabase(`/rest/v1/sighting_media?sighting_id=eq.${photos[1]}&select=id,mime_type,created_at&order=created_at.asc`);
      return json(res, 200, { photos: rows.map(row => ({ ...row, url: `/api/media/${row.id}` })) }, origin);
    }
    if (photos && req.method === "POST") {
      rateLimit(req, 8); const { user } = await activeUser(req);
      const mime = String(req.headers["content-type"] || "").split(";")[0];
      if (!["image/jpeg","image/png","image/webp"].includes(mime)) throw Object.assign(new Error("Use a JPEG, PNG, or WebP image"), { status: 415 });
      const owned = await supabase(`/rest/v1/sightings?id=eq.${photos[1]}&reporter_id=eq.${user.id}&select=id`);
      if (!owned.length) throw Object.assign(new Error("Only the reporting hunter can add photos"), { status: 403 });
      const original = await binaryBody(req);const bytes=scrubImage(original,mime); const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"; const objectPath = `${photos[1]}/${crypto.randomUUID()}.${ext}`;
      const uploaded = await fetch(`${SUPABASE_URL}/storage/v1/object/sighting-photos/${objectPath}`, { method:"POST", headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, "Content-Type":mime, "x-upsert":"false" }, body:bytes });
      if (!uploaded.ok) throw Object.assign(new Error("Photo storage failed"), { status: 502 });
      const rows = await supabase("/rest/v1/sighting_media", { method:"POST", data:{ sighting_id:photos[1], uploader_id:user.id, object_path:objectPath, mime_type:mime, byte_size:bytes.length }, prefer:"return=representation" });
      return json(res, 201, { id:rows[0].id, url:`/api/media/${rows[0].id}` }, origin);
    }

    const comments = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/comments$/i);
    if (comments && req.method === "GET") {
      const rows = await supabase(`/rest/v1/sighting_comments?sighting_id=eq.${comments[1]}&select=id,commenter_id,body,created_at&order=created_at.asc&limit=100`);
      const ids = [...new Set(rows.map(row=>row.commenter_id))];
      const profiles = ids.length ? await supabase(`/rest/v1/profiles?id=in.(${ids.join(",")})&select=id,first_name,last_name,show_attribution`) : [];
      const names = new Map(profiles.map(p=>[p.id,publicName(p)]));
      return json(res, 200, { comments: rows.map(({commenter_id,...row})=>({...row,display_name:names.get(commenter_id)||"Flyway member"})) }, origin);
    }
    if (comments && req.method === "POST") {
      rateLimit(req, 20); const moderationConfig=await configValue("moderation",{comments_enabled:true});if(moderationConfig.comments_enabled===false)throw Object.assign(new Error("Comments are temporarily disabled"),{status:403});const { user } = await activeUser(req); const input = await body(req); const text = typeof input.body === "string" ? input.body.trim() : "";
      if (!text || text.length > 500) throw Object.assign(new Error("Comment must be between 1 and 500 characters"), { status:400 });
      await supabase("/rest/v1/sighting_comments", { method:"POST", data:{ sighting_id:comments[1], commenter_id:user.id, body:text }, prefer:"return=minimal" });const owners=await supabase(`/rest/v1/sightings?id=eq.${comments[1]}&select=reporter_id`);if(owners[0]?.reporter_id!==user.id)await notify(owners[0]?.reporter_id,"comment","New comment on your report",text.slice(0,120),`/?sighting=${comments[1]}`);
      return json(res, 201, { status:"created" }, origin);
    }

    const media = url.pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
    if (media && req.method === "GET") {
      const rows = await supabase(`/rest/v1/sighting_media?id=eq.${media[1]}&select=object_path,mime_type`);
      if (!rows.length) throw Object.assign(new Error("Photo not found"), { status:404 });
      const image = await fetch(`${SUPABASE_URL}/storage/v1/object/sighting-photos/${rows[0].object_path}`, { headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}` } });
      if (!image.ok) throw Object.assign(new Error("Photo not found"), { status:404 });
      res.writeHead(200, { "Content-Type":rows[0].mime_type, "Cache-Control":"public, max-age=3600", ...cors(origin) }); return res.end(Buffer.from(await image.arrayBuffer()));
    }

    const confirmationState=url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/confirmation-state$/i);
    if(req.method==="GET"&&confirmationState){const{user}=await activeUser(req);const [confirmationRows,sightingRows]=await Promise.all([supabase(`/rest/v1/confirmations?sighting_id=eq.${confirmationState[1]}&hunter_id=eq.${user.id}&select=confirmed_at`),supabase(`/rest/v1/sightings?id=eq.${confirmationState[1]}&select=reporter_id`)]);if(!sightingRows.length)throw Object.assign(new Error("Sighting not found"),{status:404});return json(res,200,{confirmed:confirmationRows.length>0,own_report:sightingRows[0].reporter_id===user.id,confirmed_at:confirmationRows[0]?.confirmed_at||null},origin)}
    const confirmation = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/confirm$/i);
    if (req.method === "POST" && confirmation) {
      rateLimit(req, 30);
      const { user } = await activeUser(req);
      const owners=await supabase(`/rest/v1/sightings?id=eq.${confirmation[1]}&select=reporter_id`);if(!owners.length)throw Object.assign(new Error("Sighting not found"),{status:404});if(owners[0].reporter_id===user.id)throw Object.assign(new Error("You cannot confirm your own report"),{status:409});const existing=await supabase(`/rest/v1/confirmations?sighting_id=eq.${confirmation[1]}&hunter_id=eq.${user.id}&select=confirmed_at`);if(existing.length)return json(res,200,{confirmed:true,already_confirmed:true},origin);await supabase("/rest/v1/confirmations?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: confirmation[1], hunter_id: user.id }, prefer: "resolution=ignore-duplicates,return=minimal" });await notify(owners[0].reporter_id,"confirmation","Activity confirmed","Another member confirmed your bird activity.",`/?sighting=${confirmation[1]}`);await userActivity(req,user.id,"sighting.confirm","sighting",confirmation[1]);
      return json(res, 200, {confirmed:true}, origin);
    }

    const flag = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/flag$/i);
    if (req.method === "POST" && flag) {
      rateLimit(req, 10);
      const { user } = await activeUser(req);
      const input = await body(req);
      const reason = ["false_report", "unsafe", "spam", "other"].includes(input.reason) ? input.reason : "other";
      await supabase("/rest/v1/flags?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: flag[1], hunter_id: user.id, reason }, prefer: "resolution=ignore-duplicates,return=minimal" });
      const [allFlags,moderationConfig]=await Promise.all([supabase(`/rest/v1/flags?sighting_id=eq.${flag[1]}&select=id`),configValue("moderation",{auto_hide_flag_count:3})]);
      const openCases=await supabase(`/rest/v1/moderation_cases?content_type=eq.sighting&content_id=eq.${flag[1]}&status=in.(open,assigned,escalated)&select=id`);if(!openCases.length)await supabase("/rest/v1/moderation_cases",{method:"POST",data:{content_type:"sighting",content_id:flag[1],reason},prefer:"return=minimal"});if(allFlags.length>=Number(moderationConfig.auto_hide_flag_count||3))await supabase(`/rest/v1/sightings?id=eq.${flag[1]}`,{method:"PATCH",data:{status:"flagged"},prefer:"return=minimal"});
      return json(res, 204, null, origin);
    }

    if(req.method==="POST"&&url.pathname==="/api/flags"){
      rateLimit(req,12);const{user}=await activeUser(req);const input=await body(req);const contentType=String(input.content_type||"");const contentId=String(input.content_id||"");if(!["sighting","comment","photo","note"].includes(contentType)||!/[0-9a-f-]{36}/i.test(contentId))throw Object.assign(new Error("Invalid content report"),{status:400});const reason=["false_report","unsafe","spam","harassment","privacy","other"].includes(input.reason)?input.reason:"other";await supabase("/rest/v1/content_reports?on_conflict=reporter_id,content_type,content_id",{method:"POST",data:{reporter_id:user.id,content_type:contentType,content_id:contentId,reason,details:String(input.details||"").slice(0,500)||null},prefer:"resolution=ignore-duplicates,return=minimal"});const existing=await supabase(`/rest/v1/moderation_cases?content_type=eq.${contentType}&content_id=eq.${contentId}&status=in.(open,assigned,escalated)&select=id`);if(!existing.length)await supabase("/rest/v1/moderation_cases",{method:"POST",data:{content_type:contentType,content_id:contentId,reason},prefer:"return=minimal"});return json(res,202,{message:"Submitted for review"},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      await requireRole(req,["moderator","admin"]);
      const [users,active,flags,speciesRows]=await Promise.all([supabase("/rest/v1/profiles?select=id,role,suspended_until"),supabase("/rest/v1/sightings?status=eq.active&select=id"),supabase("/rest/v1/flags?resolved_at=is.null&select=id"),supabase("/rest/v1/species_catalog?select=slug,enabled")]);
      return json(res,200,{users:users.length,active_sightings:active.length,open_flags:flags.length,enabled_species:speciesRows.filter(row=>row.enabled).length},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      await requireRole(req,["admin"]); const [rows,auth]=await Promise.all([supabase("/rest/v1/profiles?select=id,display_name,first_name,last_name,role,trust_score,report_count,suspended_until,created_at&order=created_at.desc&limit=200"),authAdmin("/users?page=1&per_page=1000")]);const authById=new Map((auth.users||[]).map(item=>[item.id,item]));return json(res,200,{users:rows.map(row=>({...row,email:authById.get(row.id)?.email||null,last_sign_in_at:authById.get(row.id)?.last_sign_in_at||null,mfa_factor_count:(authById.get(row.id)?.factors||[]).length}))},origin);
    }
    const adminUserDetail=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/detail$/i);
    if(req.method==="GET"&&adminUserDetail){await requireRole(req,["admin"]);const id=adminUserDetail[1];const [profiles,authUser,sightings,comments,sessions,events]=await Promise.all([supabase(`/rest/v1/profiles?id=eq.${id}&select=*`),authAdmin(`/users/${id}`),supabase(`/rest/v1/sightings?reporter_id=eq.${id}&select=id`),supabase(`/rest/v1/sighting_comments?commenter_id=eq.${id}&select=id`),supabase(`/rest/v1/app_sessions?user_id=eq.${id}&select=id,device,last_seen_at,created_at,revoked_at&order=last_seen_at.desc&limit=20`),supabase(`/rest/v1/security_events?user_id=eq.${id}&select=id,event_type,outcome,details,created_at&order=created_at.desc&limit=30`)]);if(!profiles.length)throw Object.assign(new Error("User not found"),{status:404});const factors=(authUser.factors||[]).map(({id,factor_type,status,created_at,updated_at,friendly_name})=>({id,factor_type,status,created_at,updated_at,friendly_name}));return json(res,200,{profile:profiles[0],auth:{id:authUser.id,email:authUser.email,created_at:authUser.created_at,last_sign_in_at:authUser.last_sign_in_at,email_confirmed_at:authUser.email_confirmed_at,factors},counts:{reports:sightings.length,comments:comments.length},sessions,security_events:events},origin)}
    const adminUserActivity=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/activity$/i);
    if(req.method==="GET"&&adminUserActivity){const{user}=await requireRole(req,["admin"]);const page=Math.max(1,Number(url.searchParams.get("page"))||1),limit=50,offset=(page-1)*limit;const action=String(url.searchParams.get("action")||"").trim().slice(0,80),outcome=String(url.searchParams.get("outcome")||"").trim().slice(0,40),from=String(url.searchParams.get("from")||""),to=String(url.searchParams.get("to")||"");const filters=[`user_id=eq.${adminUserActivity[1]}`];if(action)filters.push(`action=eq.${encodeURIComponent(action)}`);if(outcome)filters.push(`outcome=eq.${encodeURIComponent(outcome)}`);if(/^\d{4}-\d{2}-\d{2}$/.test(from))filters.push(`created_at=gte.${encodeURIComponent(from+"T00:00:00Z")}`);if(/^\d{4}-\d{2}-\d{2}$/.test(to))filters.push(`created_at=lt.${encodeURIComponent(new Date(new Date(to+"T00:00:00Z").getTime()+86400000).toISOString())}`);const rows=await supabase(`/rest/v1/user_activity_log?${filters.join("&")}&select=id,user_id,action,target_type,target_id,outcome,before_state,after_state,request_context,session_id,created_at&order=created_at.desc&offset=${offset}&limit=${limit+1}`);await auditRequest(req,user.id,"user_activity.view","profile",adminUserActivity[1],{page,action:action||null,outcome:outcome||null,from:from||null,to:to||null});return json(res,200,{events:rows.slice(0,limit),page,has_more:rows.length>limit},origin)}
    const adminUser=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/i);
    if (req.method === "PATCH" && adminUser) {
      const {user}=await requireRole(req,["admin"]); const input=await body(req); const update={};
      if (["user","moderator","admin"].includes(input.role)) update.role=input.role;if(typeof input.display_name==="string")update.display_name=input.display_name.trim().slice(0,80)||"Flyway member";if(typeof input.first_name==="string")update.first_name=input.first_name.trim().slice(0,50)||null;if(typeof input.last_name==="string")update.last_name=input.last_name.trim().slice(0,80)||null;if(typeof input.bio==="string")update.bio=input.bio.trim().slice(0,280)||null;if(typeof input.region==="string")update.region=input.region.trim().slice(0,80)||null;if(["miles","kilometers"].includes(input.distance_units))update.distance_units=input.distance_units;if(typeof input.show_attribution==="boolean")update.show_attribution=input.show_attribution;if(input.notification_preferences&&typeof input.notification_preferences==="object")update.notification_preferences=input.notification_preferences;
      if (input.suspended_until===null||typeof input.suspended_until==="string") update.suspended_until=input.suspended_until;
      if (!Object.keys(update).length) throw Object.assign(new Error("No valid user changes"),{status:400});
      await supabase(`/rest/v1/profiles?id=eq.${adminUser[1]}`,{method:"PATCH",data:update,prefer:"return=minimal"}); await auditRequest(req,user.id,"user.update","profile",adminUser[1],update); return json(res,200,{status:"updated"},origin);
    }
    const adminMfaReset=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/mfa-reset$/i);
    if(req.method==="POST"&&adminMfaReset){rateLimit(req,4);const{user}=await requireRole(req,["admin"]);const input=await body(req);const reason=String(input.reason||"").trim();if(reason.length<4)throw Object.assign(new Error("A reason is required"),{status:400});const target=await authAdmin(`/users/${adminMfaReset[1]}`);const factors=target.factors||[];for(const factor of factors)await authAdmin(`/users/${adminMfaReset[1]}/factors/${factor.id}`,{method:"DELETE"});await authAdmin(`/users/${adminMfaReset[1]}/logout`,{method:"POST"});await auditRequest(req,user.id,"user.mfa_reset","profile",adminMfaReset[1],{reason,factors_removed:factors.length});await securityEvent(req,"admin_mfa_reset","success",adminMfaReset[1],{actor_id:user.id});return json(res,200,{message:"MFA factors removed and sessions revoked",factors_removed:factors.length},origin)}
    const adminRecover=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})\/recover$/i);
    if(req.method==="POST"&&adminRecover){rateLimit(req,4);const {user}=await requireRole(req,["admin"]);const input=await body(req);if(String(input.reason||"").trim().length<4)throw Object.assign(new Error("A reason is required"),{status:400});const authUser=await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${adminRecover[1]}`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});if(!authUser.ok)throw Object.assign(new Error("User not found"),{status:404});const target=await authUser.json();await sendRecovery(target.email);if(input.revoke_sessions)await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${adminRecover[1]}/logout`,{method:"POST",headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`}});await audit(user.id,"user.recovery_requested","profile",adminRecover[1],{reason:String(input.reason).slice(0,240),revoke_sessions:!!input.revoke_sessions});await securityEvent(req,"admin_password_recovery","requested",adminRecover[1],{actor_id:user.id});return json(res,202,{message:"Recovery email requested"},origin);}

    if (req.method === "GET" && url.pathname === "/api/admin/flags") {
      await requireRole(req,["moderator","admin"]); const rows=await supabase("/rest/v1/flags?resolved_at=is.null&select=id,sighting_id,hunter_id,reason,created_at&order=created_at.desc&limit=200"); return json(res,200,{flags:rows},origin);
    }
    if(req.method==="GET"&&url.pathname==="/api/admin/moderation"){
      await requireRole(req,["moderator","admin"]);const status=url.searchParams.get("status")||"active",page=Math.max(1,Number(url.searchParams.get("page"))||1),limit=50,offset=(page-1)*limit;const allowed=["active","all","open","assigned","escalated","approved","removed","duplicate","needs_info"];if(!allowed.includes(status))throw Object.assign(new Error("Invalid queue"),{status:400});const filter=status==="active"?"status=in.(open,assigned,escalated,needs_info)":status==="all"?"":`status=eq.${status}`;const rows=await supabase(`/rest/v1/moderation_cases?${filter?filter+"&":""}select=*&order=created_at.desc&offset=${offset}&limit=${limit+1}`);return json(res,200,{cases:rows.slice(0,limit),page,has_more:rows.length>limit},origin);
    }
    if(req.method==="GET"&&url.pathname==="/api/admin/duplicates"){await requireRole(req,["moderator","admin"]);const rows=await supabase("/rest/v1/duplicate_candidates?status=eq.pending&select=*&order=similarity.desc,created_at.asc&limit=100");return json(res,200,{duplicates:rows},origin)}
    const duplicate=url.pathname.match(/^\/api\/admin\/duplicates\/([0-9a-f-]{36})$/i);if(req.method==="PATCH"&&duplicate){const{user}=await requireRole(req,["moderator","admin"]);const input=await body(req);if(!["merged","related","separate"].includes(input.status))throw Object.assign(new Error("Invalid duplicate decision"),{status:400});const rows=await supabase(`/rest/v1/duplicate_candidates?id=eq.${duplicate[1]}&select=*`);if(!rows.length)throw Object.assign(new Error("Duplicate candidate not found"),{status:404});await supabase(`/rest/v1/duplicate_candidates?id=eq.${duplicate[1]}`,{method:"PATCH",data:{status:input.status,reviewed_by:user.id,reviewed_at:new Date().toISOString()},prefer:"return=minimal"});if(input.status==="merged")await supabase(`/rest/v1/sightings?id=eq.${rows[0].sighting_b}`,{method:"PATCH",data:{status:"removed"},prefer:"return=minimal"});await audit(user.id,"duplicate.review","duplicate",duplicate[1],{status:input.status});return json(res,200,{status:"updated"},origin)}
    const moderationCase=url.pathname.match(/^\/api\/admin\/moderation\/([0-9a-f-]{36})$/i);
    if(req.method==="PATCH"&&moderationCase){const {user}=await requireRole(req,["moderator","admin"]);const input=await body(req);const statuses=["assigned","escalated","approved","removed","duplicate","needs_info"];if(!statuses.includes(input.status)||String(input.reason||"").trim().length<3)throw Object.assign(new Error("A valid decision and reason are required"),{status:400});const existing=await supabase(`/rest/v1/moderation_cases?id=eq.${moderationCase[1]}&select=*&limit=1`);if(!existing.length)throw Object.assign(new Error("Case not found"),{status:404});if(Number(input.version)!==existing[0].version)throw Object.assign(new Error("This case was updated by another moderator. Refresh and try again."),{status:409});const update={status:input.status,resolution_reason:String(input.reason).slice(0,240),moderator_note:String(input.note||"").slice(0,1000),assigned_to:input.status==="assigned"?user.id:existing[0].assigned_to,version:existing[0].version+1,updated_at:new Date().toISOString(),...( ["approved","removed","duplicate"].includes(input.status)?{resolved_at:new Date().toISOString(),resolved_by:user.id}:{})};await supabase(`/rest/v1/moderation_cases?id=eq.${moderationCase[1]}`,{method:"PATCH",data:update,prefer:"return=minimal"});if(existing[0].content_type==="sighting"&&["approved","removed"].includes(input.status))await supabase(`/rest/v1/sightings?id=eq.${existing[0].content_id}`,{method:"PATCH",data:{status:input.status==="approved"?"active":"removed"},prefer:"return=minimal"});await audit(user.id,"moderation.resolve",existing[0].content_type,existing[0].content_id,{case_id:moderationCase[1],...update});return json(res,200,{status:"updated",version:update.version},origin);}
    const moderate=url.pathname.match(/^\/api\/admin\/sightings\/([0-9a-f-]{36})$/i);
    if (req.method === "PATCH" && moderate) {
      const {user}=await requireRole(req,["moderator","admin"]); const input=await body(req); if(!["active","flagged","removed"].includes(input.status))throw Object.assign(new Error("Invalid moderation status"),{status:400});
      await supabase(`/rest/v1/sightings?id=eq.${moderate[1]}`,{method:"PATCH",data:{status:input.status},prefer:"return=minimal"});await supabase(`/rest/v1/flags?sighting_id=eq.${moderate[1]}&resolved_at=is.null`,{method:"PATCH",data:{resolved_at:new Date().toISOString(),resolved_by:user.id},prefer:"return=minimal"}); await audit(user.id,"sighting.moderate","sighting",moderate[1],{status:input.status}); return json(res,200,{status:"updated"},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/species") {
      await requireRole(req,["moderator","admin"]); const [categories,catalog]=await Promise.all([supabase("/rest/v1/bird_categories?select=*&order=sort_order.asc"),supabase("/rest/v1/species_catalog?select=*&order=category_slug.asc,sort_order.asc")]); return json(res,200,{categories,species:catalog},origin);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/species") {
      const {user}=await requireRole(req,["admin"]); const input=await body(req); if(!/^[a-z0-9_]+$/.test(input.slug||"")||!input.display_name||!input.category_slug)throw Object.assign(new Error("Valid slug, name, and category are required"),{status:400});
      await supabase("/rest/v1/species_catalog",{method:"POST",data:{slug:input.slug,display_name:String(input.display_name).slice(0,80),category_slug:input.category_slug,enabled:input.enabled!==false,sort_order:Number(input.sort_order)||100},prefer:"return=minimal"}); await auditRequest(req,user.id,"species.create","species",input.slug,input); return json(res,201,{status:"created"},origin);
    }
    const adminSpecies=url.pathname.match(/^\/api\/admin\/species\/([a-z0-9_]+)$/);
    if (req.method === "PATCH" && adminSpecies) {
      const {user}=await requireRole(req,["admin"]); const input=await body(req); const update={}; if(typeof input.display_name==="string")update.display_name=input.display_name.slice(0,80);if(typeof input.scientific_name==="string")update.scientific_name=input.scientific_name.slice(0,120);if(Array.isArray(input.aliases))update.aliases=input.aliases.map(v=>String(v).slice(0,80)).slice(0,20);if(typeof input.description==="string")update.description=input.description.slice(0,1000);if(typeof input.color==="string"&&/^#[0-9a-f]{6}$/i.test(input.color))update.color=input.color;if(typeof input.sensitive==="boolean")update.sensitive=input.sensitive;if(typeof input.visible_in_filters==="boolean")update.visible_in_filters=input.visible_in_filters;if(typeof input.enabled==="boolean")update.enabled=input.enabled;if(input.archived===true)update.archived_at=new Date().toISOString();if(input.archived===false)update.archived_at=null;if(typeof input.category_slug==="string")update.category_slug=input.category_slug;if(Number.isFinite(Number(input.sort_order)))update.sort_order=Number(input.sort_order);for(const key of ["season_start_month","season_start_day","season_end_month","season_end_day"]){if(input[key]===null)update[key]=null;else if(Number.isInteger(Number(input[key])))update[key]=Number(input[key])}if(typeof input.season_region==="string")update.season_region=input.season_region.trim().slice(0,80)||null;
      await supabase(`/rest/v1/species_catalog?slug=eq.${adminSpecies[1]}`,{method:"PATCH",data:update,prefer:"return=minimal"});await auditRequest(req,user.id,"species.update","species",adminSpecies[1],update);return json(res,200,{status:"updated"},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/config") {
      await requireRole(req,["admin"]);const rows=await supabase("/rest/v1/app_config?select=key,value,description,updated_at&order=key.asc");return json(res,200,{config:rows},origin);
    }
    const adminConfig=url.pathname.match(/^\/api\/admin\/config\/([a-z_]+)$/);
    if (req.method === "PATCH" && adminConfig) {
      const {user}=await requireRole(req,["admin"]);if(adminConfig[1]==="privacy")throw Object.assign(new Error("Privacy safety floors cannot be changed in the admin UI"),{status:403});const input=await body(req);if(!input.value||typeof input.value!=="object"||Array.isArray(input.value))throw Object.assign(new Error("Configuration value must be an object"),{status:400});if(adminConfig[1]==="security"&&!['disabled','optional','admin_required','staff_required'].includes(input.value.mfa_policy))throw Object.assign(new Error("Invalid MFA policy"),{status:400});
      await supabase(`/rest/v1/app_config?key=eq.${adminConfig[1]}`,{method:"PATCH",data:{value:input.value,updated_by:user.id,updated_at:new Date().toISOString()},prefer:"return=minimal"});await audit(user.id,"config.update","config",adminConfig[1],input.value);return json(res,200,{status:"updated"},origin);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/audit") {
      await requireRole(req,["admin"]);const rows=await supabase("/rest/v1/admin_audit_log?select=id,actor_id,action,target_type,target_id,details,created_at&order=created_at.desc&limit=200");const actorIds=[...new Set(rows.map(r=>r.actor_id).filter(Boolean))],profiles=actorIds.length?await supabase(`/rest/v1/profiles?id=in.(${actorIds.join(",")})&select=id,display_name,first_name,last_name`):[];const names=new Map(profiles.map(p=>[p.id,p.display_name||[p.first_name,p.last_name].filter(Boolean).join(" ")||"Unknown user"]));const comments=rows.filter(r=>r.target_type==="comment"&&/^[0-9a-f-]{36}$/i.test(r.target_id)).map(r=>r.target_id),commentRows=comments.length?await supabase(`/rest/v1/sighting_comments?id=in.(${comments.join(",")})&select=id,body`):[];const commentText=new Map(commentRows.map(c=>[c.id,c.body]));return json(res,200,{audit:rows.map(row=>({...row,actor_name:names.get(row.actor_id)||"System",target_summary:row.target_type==="comment"?(commentText.get(row.target_id)?.slice(0,160)||"Deleted comment"):row.details?.display_name||row.details?.reason||row.details?.status||null}))},origin);
    }

    return json(res, 404, { error: "Not found" }, origin);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(requestId, error);
    return json(res, error.status || 500, { error: error.status ? error.message : "Internal server error", request_id: requestId }, origin);
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Flyway API listening on ${PORT}`));
