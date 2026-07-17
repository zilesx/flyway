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

const species = new Set(["mallard", "teal", "gadwall", "pintail", "wood_duck", "diver", "mixed", "other", "canada_goose", "snow_goose", "white_fronted_goose", "sandhill_crane", "tundra_swan"]);
const flockSizes = new Set(["1-10", "10-25", "25-50", "50+"]);
const behaviors = new Set(["feeding", "circling", "flying_over", "resting", "moving_in"]);

function validateSighting(input) {
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  if (!species.has(input.species) || !flockSizes.has(input.flock_size) || !behaviors.has(input.behavior)) throw Object.assign(new Error("Invalid sighting details"), { status: 400 });
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw Object.assign(new Error("Invalid coordinates"), { status: 400 });
  return { latitude, longitude };
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
      return json(res, 200, { id: user.id, email: user.email, display_name: user.user_metadata?.display_name || user.email?.split("@")[0] }, origin);
    }

    if (req.method === "GET" && url.pathname === "/api/sightings") {
      rateLimit(req, 120);
      const requestedDays = Number(url.searchParams.get("days")) || 7;
      const days = [1, 7, 30, 90].includes(requestedDays) ? requestedDays : 7;
      const rows = await supabase("/rest/v1/rpc/nearby_sightings", { method: "POST", token: ANON_KEY, data: { p_limit: Math.min(Number(url.searchParams.get("limit")) || 100, 250), p_since: new Date(Date.now() - days * 86400000).toISOString() } });
      return json(res, 200, { sightings: rows }, origin);
    }

    if (req.method === "POST" && url.pathname === "/api/sightings") {
      rateLimit(req, 10);
      const { user } = await currentUser(req);
      await ensureProfile(user);
      const input = await body(req);
      const { latitude, longitude } = validateSighting(input);
      const rows = await supabase("/rest/v1/sightings", { method: "POST", data: {
        reporter_id: user.id, species: input.species, flock_size: input.flock_size, behavior: input.behavior,
        exact_latitude: latitude, exact_longitude: longitude, accuracy_meters: Math.min(Math.max(Number(input.accuracy_meters) || 0, 0), 10000),
      }, prefer: "return=representation" });
      return json(res, 201, { id: rows[0].id, expires_at: rows[0].expires_at }, origin);
    }

    const confirmation = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/confirm$/i);
    if (req.method === "POST" && confirmation) {
      rateLimit(req, 30);
      const { user } = await currentUser(req); await ensureProfile(user);
      await supabase("/rest/v1/confirmations?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: confirmation[1], hunter_id: user.id }, prefer: "resolution=ignore-duplicates,return=minimal" });
      return json(res, 204, null, origin);
    }

    const flag = url.pathname.match(/^\/api\/sightings\/([0-9a-f-]{36})\/flag$/i);
    if (req.method === "POST" && flag) {
      rateLimit(req, 10);
      const { user } = await currentUser(req); await ensureProfile(user);
      const input = await body(req);
      const reason = ["false_report", "unsafe", "spam", "other"].includes(input.reason) ? input.reason : "other";
      await supabase("/rest/v1/flags?on_conflict=sighting_id,hunter_id", { method: "POST", data: { sighting_id: flag[1], hunter_id: user.id, reason }, prefer: "resolution=ignore-duplicates,return=minimal" });
      return json(res, 204, null, origin);
    }

    return json(res, 404, { error: "Not found" }, origin);
  } catch (error) {
    const requestId = crypto.randomUUID();
    console.error(requestId, error);
    return json(res, error.status || 500, { error: error.status ? error.message : "Internal server error", request_id: requestId }, origin);
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Flyway API listening on ${PORT}`));
