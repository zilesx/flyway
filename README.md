# FeatherMap

FeatherMap is a privacy-first migratory bird activity app for hunters and bird observers, designed for iOS, Android, and the web. People can share fresh observations without exposing a blind, route, or exact coordinates.

## Current prototype

- Responsive activity map for desktop and mobile
- Broad three-mile activity zones instead of exact pins
- Species, flock size, behavior, freshness, and confidence signals
- Protected reporting flow and community confirmations
- Reports designed to fade as sightings become stale

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Build for deployment with:

```bash
npm run build
```

## Product direction

This repository currently contains the interactive interface prototype. Production use will require persistent storage, user accounts, moderation, abuse controls, and a real map/location provider.

## Privacy model

Exact coordinates must never be returned to other hunters. Reports should be stored privately and transformed into coarse, randomized activity zones before being displayed. Location access logs and raw coordinates should have short retention periods.

## Docker API

Run the API on the same server as Supabase without exposing either service directly:

```bash
docker compose --env-file .env -f docker-compose.api.yml up -d --build
```

The API binds to `127.0.0.1:3001`, reaches Supabase through the Docker host at port `8000`, and is intended to sit behind a Cloudflare Tunnel at `api.yourdomain.com`. The web and mobile apps should call the FeatherMap API only.
