import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT || 3001);
const SUPABASE_URL = process.env.SUPABASE_URL || "http://host.docker.internal:8000";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean));
const limits = new Map();

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
async function configValue(key, fallback) { const rows=await supabase(`/rest/v1/app_config?key=eq.${key}&select=value`); return rows[0]?.value||fallback; }

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
      const result = await authRequest("/token?grant_type=password", { email: input.email, password: input.password });
      return json(res, 200, result, origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
      rateLimit(req, 30);
      const input = await body(req);
      const result = await authRequest("/token?grant_type=refresh_token", { refresh_token: input.refresh_token });
      return json(res, 200, result, origin);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      rateLimit(req, 10);
      const authorization = req.headers.authorization || "";
      if (!authorization.startsWith("Bearer ")) throw Object.assign(new Error("Authentication required"), { status: 401 });
      await authRequest("/logout", undefined, authorization.slice(7));
      return json(res, 204, null, origin);
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const { user } = await currentUser(req);
      await ensureProfile(user);
      const rows = await supabase(`/rest/v1/profiles?id=eq.${user.id}&select=display_name,preferences,role,suspended_until`);
      return json(res, 200, { id: user.id, email: user.email, display_name: rows[0]?.display_name || user.email?.split("@")[0], preferences: validatePreferences(rows[0]?.preferences), role:rows[0]?.role||"user", suspended_until:rows[0]?.suspended_until }, origin);
    }

    if (req.method === "PATCH" && url.pathname === "/api/profile") {
      rateLimit(req, 30);
      const { user } = await activeUser(req);
      const input = await body(req);
      const preferences = validatePreferences(input.preferences);
      await supabase(`/rest/v1/profiles?id=eq.${user.id}`, { method: "PATCH", data: { preferences }, prefer: "return=minimal" });
      return json(res, 200, { preferences }, origin);
    }

    if (req.method === "GET" && url.pathname === "/api/sightings") {
      rateLimit(req, 120);
      const mapConfig=await configValue("map",{default_days:7,max_days:90,max_results:250});
      const requestedDays = Number(url.searchParams.get("days")) || 7;
      const days = [1, 7, 30, 90].includes(requestedDays)&&requestedDays<=Number(mapConfig.max_days||90) ? requestedDays : Number(mapConfig.default_days||7);
      const rows = await supabase("/rest/v1/rpc/nearby_sightings", { method: "POST", token: ANON_KEY, data: { p_limit: Math.min(Number(url.searchParams.get("limit")) || 100, Number(mapConfig.max_results||250),250), p_since: new Date(Date.now() - days * 86400000).toISOString() } });
      return json(res, 200, { sightings: rows }, origin);
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
      const rows = await supabase("/rest/v1/sightings", { method: "POST", data: {
        reporter_id: user.id, species_slug: input.species, flock_size: input.flock_size, behavior: input.behavior,
        exact_latitude: latitude, exact_longitude: longitude, accuracy_meters: Math.min(Math.max(Number(input.accuracy_meters) || 0, 0), 10000),
        notes: typeof input.notes === "string" ? input.notes.trim().slice(0, 1000) || null : null,
      }, prefer: "return=representation" });
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
      const bytes = await binaryBody(req); const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg"; const objectPath = `${photos[1]}/${crypto.randomUUID()}.${ext}`;
      const uploaded = await fetch(`${SUPABASE_URL}/storage/v1/object/sighting-photos/${objectPath}`, { method:"POST", headers:{ apikey:SERVICE_KEY, Authorization:`Bearer ${SERVICE_KEY}`, "Content-Type":mime, "x-upsert":"false" }, body:bytes });
      if (!uploaded.ok) throw Object.assign(new Error("Photo storage failed"), { status: 502 });
      const rows = await supabase("/rest/v1/sighting_media", { method:"POST", data:{ sighting_id:photos[1], uploader_id:user.id, object_path:objectPath, mime_type:mime, byte_size:bytes.length }, prefer:"return=representation" });
      return json(res, 201, { id:rows[0].id, url:`/api/media/${rows[0].id}` }, origin);
    }

    const comments = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/comments$/i);
    if (comments && req.method === "GET") {
      const rows = await supabase(`/rest/v1/sighting_comments?sighting_id=eq.${comments[1]}&select=id,commenter_id,body,created_at&order=created_at.asc&limit=100`);
      const ids = [...new Set(rows.map(row=>row.commenter_id))];
      const profiles = ids.length ? await supabase(`/rest/v1/profiles?id=in.(${ids.join(",")})&select=id,display_name`) : [];
      const names = new Map(profiles.map(p=>[p.id,p.display_name]));
      return json(res, 200, { comments: rows.map(({commenter_id,...row})=>({...row,display_name:names.get(commenter_id)||"Hunter"})) }, origin);
    }
    if (comments && req.method === "POST") {
      rateLimit(req, 20); const moderationConfig=await configValue("moderation",{comments_enabled:true});if(moderationConfig.comments_enabled===false)throw Object.assign(new Error("Comments are temporarily disabled"),{status:403});const { user } = await activeUser(req); const input = await body(req); const text = typeof input.body === "string" ? input.body.trim() : "";
      if (!text || text.length > 500) throw Object.assign(new Error("Comment must be between 1 and 500 characters"), { status:400 });
      await supabase("/rest/v1/sighting_comments", { method:"POST", data:{ sighting_id:comments[1], commenter_id:user.id, body:text }, prefer:"return=minimal" });
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

    const confirmation = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/confirm$/i);
    if (req.method === "POST" && confirmation) {
      rateLimit(req, 30);
      const { user } = await activeUser(req);
      await supabase("/rest/v1/confirmations?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: confirmation[1], hunter_id: user.id }, prefer: "resolution=ignore-duplicates,return=minimal" });
      return json(res, 204, null, origin);
    }

    const flag = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/flag$/i);
    if (req.method === "POST" && flag) {
      rateLimit(req, 10);
      const { user } = await activeUser(req);
      const input = await body(req);
      const reason = ["false_report", "unsafe", "spam", "other"].includes(input.reason) ? input.reason : "other";
      await supabase("/rest/v1/flags?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: flag[1], hunter_id: user.id, reason }, prefer: "resolution=ignore-duplicates,return=minimal" });
      const [allFlags,moderationConfig]=await Promise.all([supabase(`/rest/v1/flags?sighting_id=eq.${flag[1]}&select=id`),configValue("moderation",{auto_hide_flag_count:3})]);
      if(allFlags.length>=Number(moderationConfig.auto_hide_flag_count||3))await supabase(`/rest/v1/sightings?id=eq.${flag[1]}`,{method:"PATCH",data:{status:"flagged"},prefer:"return=minimal"});
      return json(res, 204, null, origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/overview") {
      await requireRole(req,["moderator","admin"]);
      const [users,active,flags,speciesRows]=await Promise.all([supabase("/rest/v1/profiles?select=id,role,suspended_until"),supabase("/rest/v1/sightings?status=eq.active&select=id"),supabase("/rest/v1/flags?resolved_at=is.null&select=id"),supabase("/rest/v1/species_catalog?select=slug,enabled")]);
      return json(res,200,{users:users.length,active_sightings:active.length,open_flags:flags.length,enabled_species:speciesRows.filter(row=>row.enabled).length},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/users") {
      await requireRole(req,["admin"]); const rows=await supabase("/rest/v1/profiles?select=id,display_name,role,trust_score,report_count,suspended_until,created_at&order=created_at.desc&limit=200"); return json(res,200,{users:rows},origin);
    }
    const adminUser=url.pathname.match(/^\/api\/admin\/users\/([0-9a-f-]{36})$/i);
    if (req.method === "PATCH" && adminUser) {
      const {user}=await requireRole(req,["admin"]); const input=await body(req); const update={};
      if (["user","moderator","admin"].includes(input.role)) update.role=input.role;
      if (input.suspended_until===null||typeof input.suspended_until==="string") update.suspended_until=input.suspended_until;
      if (!Object.keys(update).length) throw Object.assign(new Error("No valid user changes"),{status:400});
      await supabase(`/rest/v1/profiles?id=eq.${adminUser[1]}`,{method:"PATCH",data:update,prefer:"return=minimal"}); await audit(user.id,"user.update","profile",adminUser[1],update); return json(res,200,{status:"updated"},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/flags") {
      await requireRole(req,["moderator","admin"]); const rows=await supabase("/rest/v1/flags?resolved_at=is.null&select=id,sighting_id,hunter_id,reason,created_at&order=created_at.desc&limit=200"); return json(res,200,{flags:rows},origin);
    }
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
      await supabase("/rest/v1/species_catalog",{method:"POST",data:{slug:input.slug,display_name:String(input.display_name).slice(0,80),category_slug:input.category_slug,enabled:input.enabled!==false,sort_order:Number(input.sort_order)||100},prefer:"return=minimal"}); await audit(user.id,"species.create","species",input.slug,input); return json(res,201,{status:"created"},origin);
    }
    const adminSpecies=url.pathname.match(/^\/api\/admin\/species\/([a-z0-9_]+)$/);
    if (req.method === "PATCH" && adminSpecies) {
      const {user}=await requireRole(req,["admin"]); const input=await body(req); const update={}; if(typeof input.display_name==="string")update.display_name=input.display_name.slice(0,80);if(typeof input.enabled==="boolean")update.enabled=input.enabled;if(typeof input.category_slug==="string")update.category_slug=input.category_slug;if(Number.isFinite(Number(input.sort_order)))update.sort_order=Number(input.sort_order);
      await supabase(`/rest/v1/species_catalog?slug=eq.${adminSpecies[1]}`,{method:"PATCH",data:update,prefer:"return=minimal"});await audit(user.id,"species.update","species",adminSpecies[1],update);return json(res,200,{status:"updated"},origin);
    }

    if (req.method === "GET" && url.pathname === "/api/admin/config") {
      await requireRole(req,["admin"]);const rows=await supabase("/rest/v1/app_config?select=key,value,description,updated_at&order=key.asc");return json(res,200,{config:rows},origin);
    }
    const adminConfig=url.pathname.match(/^\/api\/admin\/config\/([a-z_]+)$/);
    if (req.method === "PATCH" && adminConfig) {
      const {user}=await requireRole(req,["admin"]);if(adminConfig[1]==="privacy")throw Object.assign(new Error("Privacy safety floors cannot be changed in the admin UI"),{status:403});const input=await body(req);if(!input.value||typeof input.value!=="object")throw Object.assign(new Error("Configuration value must be an object"),{status:400});
      await supabase(`/rest/v1/app_config?key=eq.${adminConfig[1]}`,{method:"PATCH",data:{value:input.value,updated_by:user.id,updated_at:new Date().toISOString()},prefer:"return=minimal"});await audit(user.id,"config.update","config",adminConfig[1],input.value);return json(res,200,{status:"updated"},origin);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/audit") {
      await requireRole(req,["admin"]);const rows=await supabase("/rest/v1/admin_audit_log?select=id,actor_id,action,target_type,target_id,details,created_at&order=created_at.desc&limit=200");return json(res,200,{audit:rows},origin);
    }

    return json(res, 404, { error: "Not found" }, origin);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(requestId, error);
    return json(res, error.status || 500, { error: error.status ? error.message : "Internal server error", request_id: requestId }, origin);
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Flyway API listening on ${PORT}`));
