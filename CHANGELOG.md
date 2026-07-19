# Flyway changelog

## 2026-07-19 — Administrator user activity and map report selection

- Added a dedicated administrator-only Activity section to user details with action, outcome, and date filters plus paginated history.
- Included outcome, target, timestamp, masked network context, device context, session context, and before/after detail access for user write activity.
- Kept administrator activity views auditable through the existing administrative audit trail.
- Changed report and cluster selection so a primary click or tap opens the compact activity card for the selected report.
- Added privacy-aware reporter attribution and an explicit **View details** action to the compact activity card.
- Kept the compact card synchronized with the selected map report while allowing the full detail modal to close back to that selection.
- Prevented right-click and other secondary mouse actions from selecting map reports while preserving keyboard and touch activation.

This changelog is organized around explicit product build approvals and major deployment milestones. Future entries are added whenever the project owner says **“build it.”**

## 2026-07-19 — Location picker, annual date ranges, audit context, and accessibility

- Added privacy-aware reporter attribution to activity-list entries.
- Enriched administrative audit results with readable actor names and action-specific target summaries while retaining identifiers for troubleshooting.
- Expanded standard map timeframes to six months and one year.
- Added custom start/end date filtering with a maximum one-year span and server-side validation.
- Raised privacy-safe report aggregation and heatmap support from 90 days to 365 days.
- Added a location picker with current location, curated popular migration locations, and synchronized saved locations.
- Added coarse coordinate rounding for saved locations and save/delete activity auditing.
- Added accessible names, pressed/expanded state semantics, live activity-list updates, stronger focus indicators, and labeled custom-date controls.
- Added `migrate_locations_year_ranges.sql`.

## 2026-07-18 — Authentication, attribution privacy, and observed weather

- Made Enter/Return submit sign-in, signup, and account-recovery forms.
- Added authentication progress states and duplicate-submission prevention.
- Simplified public attribution to a single yes/no profile preference.
- Public names are either first name plus last initial or `Flyway member`.
- Applied the same privacy-safe naming to reports and comments.
- Added optional user-reported sky, precipitation, wind, temperature, and visibility.
- Separated reported conditions from the automatically captured regional weather snapshot.
- Added realistic observed weather to the synthetic migration dataset.
- Added `migrate_attribution_observed_weather.sql`.

## 2026-07-17 — Sessions, confirmations, moderation history, and synthetic data

- Added a normal current-session Sign out action while retaining Sign out everywhere.
- Added persistent confirmation state, duplicate protection, self-confirmation prevention, and a disabled Confirmed state.
- Added active and historical moderation status filters with pagination support.
- Added resolved-case information and improved administrative user details.
- Added an admin-only user write-activity audit log with request, session, device, masked network, and before/after context.
- Added synthetic-record labeling and reversible batch deletion.
- Added a two-year, approximately 12,000-record US migration dataset modeled around broad flyway and seasonal patterns.
- Added `migrate_activity_history_synthetic.sql` and `seed_two_year_migration.sql`.

## 2026-07-17 — Administrative directory, species, audit, and marker reliability

- Made marker and cluster activation gesture-aware so taps open details without interfering with pan or pinch gestures.
- Added last-login information to the administrative user directory.
- Added administrative User Detail and profile editing.
- Added safe MFA factor inspection and audited MFA reset with session revocation.
- Added species editing, display order, seasonal dates, and regional relevance metadata.
- Replaced the user-facing `immutable_slug` wording with Internal ID.
- Added detailed audit views with actor, target, request, masked IP, and device context.
- Reconciled legacy display names with structured first and last names.
- Added `migrate_admin_directory_species.sql`.

## 2026-07-17 — Trust, map layers, profile, and moderation iteration

- Added duplicate detection with moderator/admin confirmation before merging.
- Added reporting of sightings, notes, photos, and comments.
- Added account session management, notification preferences, and account-wide session revocation.
- Added flyway map layers and future-layer foundations.
- Added hunting-regulation notices and liability-oriented disclaimers.
- Added automatic weather context to reports.
- Added client-side image compression and server-side EXIF/GPS metadata removal.
- Added protected reporter attribution and improved marker detail behavior.

## 2026-07-17 — Security, MFA, and dedicated administration

- Added authenticated password changes, email recovery, and admin-initiated recovery.
- Added SMTP configuration requirements, reset throttling, and failed-login lockout policy settings.
- Added generic TOTP MFA with QR activation and numeric verification.
- Made administrator TOTP optional and configurable.
- Moved administration from the account modal to a dedicated page.
- Added editable configuration controls, moderation queues, species CRUD, RBAC, and audit views.
- Fixed production black screens, QR rendering, overlapping controls, modal scrolling, map clicks, and passive wheel-listener errors.

## 2026-07-17 — Reports, media, and community participation

- Added report notes, photo uploads, comments, saves, and community confirmations.
- Added image compression and metadata stripping.
- Added content reporting and moderator review tools.
- Added weather snapshots and privacy-safe report attribution.

## 2026-07-17 — Bird catalog, time filters, and worldwide map

- Expanded the map from a limited region to the continental United States and worldwide navigation.
- Added 24-hour, 7-day, 30-day, and 90-day filters.
- Expanded the catalog beyond ducks to geese, cranes, swans, doves, shorebirds, and other migratory birds.
- Added improved map pan, wheel zoom, pinch zoom, clusters, heatmap foundations, and detail modals.
- Added species visibility preferences and administrative catalog controls.

## 2026-07-17 — Live API, authentication, and RBAC

- Connected the application to the live server-side API.
- Added signup, login, logout, authenticated reporting, and account preferences.
- Differentiated anonymous and authenticated experiences.
- Added user, moderator, and administrator roles with server-enforced authorization.
- Kept Supabase access behind the API so client applications never receive database credentials.

## Infrastructure and deployment milestone

- Selected self-hosted Supabase for PostgreSQL, authentication, and object storage.
- Deployed the Flyway API in Docker on port 3001.
- Deployed the web application in Docker on port 3002.
- Configured Cloudflare Tunnel and DNS for `flyway-api.zileslabs.com` and `flyway-app.zileslabs.com`.
- Established GitHub as the source repository and added Docker-based deployment workflows.

## Initial product milestone

- Defined Flyway as a privacy-first migratory-bird activity application for iOS, Android, and web.
- Established randomized activity zones so reports do not expose exact hunting locations, blinds, or routes.
- Created the initial responsive map, reporting workflow, activity cards, and community-confirmation concept.
