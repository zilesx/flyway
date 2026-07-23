import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

async function render(path="/"){
  const workerUrl=new URL("../dist/server/index.js",import.meta.url);workerUrl.searchParams.set("test",`${process.pid}-${Date.now()}`);const{default:worker}=await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`,{headers:{accept:"text/html"}}),{ASSETS:{fetch:async()=>new Response("Not found",{status:404})}},{waitUntil(){},passThroughOnException(){}});
}

test("server-renders the Flyway map",async()=>{const response=await render();assert.equal(response.status,200);const html=await response.text();assert.match(html,/<title>Flyway/);assert.match(html,/MIGRATORY ACTIVITY, NOT HUNTING SPOTS/);assert.match(html,/Past 7 days/);assert.match(html,/Report birds/);assert.doesNotMatch(html,/codex-preview|Your site is taking shape/)});

test("ships protected administration and trust features",async()=>{for(const path of ["/admin","/auth/reset-password"]){const response=await render(path);assert.equal(response.status,200)}const[api,migration]=await Promise.all([readFile(new URL("../api/server.mjs",import.meta.url),"utf8"),readFile(new URL("../supabase/migrate_trust_layers_profile.sql",import.meta.url),"utf8")]);assert.match(api,/\/api\/auth\/recover/);assert.match(api,/\/api\/admin\/duplicates/);assert.match(api,/weatherSnapshot/);assert.match(api,/scrubImage/);assert.match(api,/signout-all/);assert.match(migration,/duplicate_candidates/);assert.match(migration,/hunting_regulations/);assert.match(migration,/notifications/)});

test("keeps map overlays legible in light and system themes",async()=>{const css=await readFile(new URL("../app/theme.css",import.meta.url),"utf8");assert.match(css,/\.filter:not\(\.active\)/);assert.match(css,/\.filter\.active\{background:#f4f7f2;color:#142019/);assert.match(css,/\.hotspot span\{color:#fff\}/);assert.match(css,/\.map-attribution/);assert.match(css,/\.heat-legend/)});
