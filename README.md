# Flyway

Flyway is a privacy-first duck activity app for hunters, designed for iOS, Android, and the web. Hunters can share fresh sightings without exposing their blind, route, or exact coordinates.

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
