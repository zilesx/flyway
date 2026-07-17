-- Flyway example sightings for Flyway Duck Activity
-- Illustrative demo data, not live observations or hunting recommendations.
-- Coordinates identify broad, publicly known wetland/refuge areas. The app's
-- nearby_sightings() function still applies its deterministic location blur.
--
-- Run after at least one authenticated user/profile exists:
--   docker exec -i supabase-db psql -U postgres -d postgres < seed_us_flyways.sql

begin;

do $$
begin
  if not exists (select 1 from public.profiles) then
    raise exception 'Create at least one Flyway account/profile before loading seed data';
  end if;
end $$;

with reporter as (
  select id from public.profiles order by created_at limit 1
), seed (
  id, species, flock_size, behavior, latitude, longitude,
  confidence, age_minutes, lifetime_hours
) as (
  values
    -- Pacific Flyway: coastal valleys, Great Basin and western staging wetlands
    ('f1000000-0000-4000-8000-000000000001'::uuid,'pintail'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,41.973,-121.565,88,18,8), -- Lower Klamath
    ('f1000000-0000-4000-8000-000000000002'::uuid,'mixed'::public.bird_species,'50+'::public.flock_band,'resting'::public.sighting_behavior,39.460,-122.190,91,34,9), -- Sacramento NWR
    ('f1000000-0000-4000-8000-000000000003'::uuid,'gadwall'::public.bird_species,'25-50'::public.flock_band,'feeding'::public.sighting_behavior,38.178,-121.915,79,52,8), -- Suisun Marsh
    ('f1000000-0000-4000-8000-000000000004'::uuid,'teal'::public.bird_species,'25-50'::public.flock_band,'moving_in'::public.sighting_behavior,36.920,-120.830,82,67,8), -- San Joaquin Valley
    ('f1000000-0000-4000-8000-000000000005'::uuid,'pintail'::public.bird_species,'10-25'::public.flock_band,'resting'::public.sighting_behavior,33.300,-115.620,74,83,7), -- Salton Sea
    ('f1000000-0000-4000-8000-000000000006'::uuid,'diver'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,46.250,-119.250,84,105,9), -- Columbia Basin
    ('f1000000-0000-4000-8000-000000000007'::uuid,'sandhill_crane'::public.bird_species,'50+'::public.flock_band,'circling'::public.sighting_behavior,41.080,-112.120,86,126,8), -- Great Salt Lake
    ('f1000000-0000-4000-8000-000000000008'::uuid,'mallard'::public.bird_species,'10-25'::public.flock_band,'feeding'::public.sighting_behavior,43.210,-116.640,73,145,8), -- Snake River Plain
    ('f1000000-0000-4000-8000-000000000009'::uuid,'mixed'::public.bird_species,'25-50'::public.flock_band,'flying_over'::public.sighting_behavior,47.620,-122.330,77,164,7), -- Puget Sound

    -- Central Flyway: prairie potholes through Plains staging areas to Texas coast
    ('f2000000-0000-4000-8000-000000000001'::uuid,'mallard'::public.bird_species,'25-50'::public.flock_band,'moving_in'::public.sighting_behavior,48.750,-100.060,87,21,9), -- North Dakota potholes
    ('f2000000-0000-4000-8000-000000000002'::uuid,'sandhill_crane'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,40.650,-98.480,90,39,8), -- Rainwater Basin
    ('f2000000-0000-4000-8000-000000000003'::uuid,'pintail'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,38.470,-98.650,85,58,9), -- Cheyenne Bottoms
    ('f2000000-0000-4000-8000-000000000004'::uuid,'gadwall'::public.bird_species,'10-25'::public.flock_band,'feeding'::public.sighting_behavior,37.730,-99.200,76,74,8), -- Quivira region
    ('f2000000-0000-4000-8000-000000000005'::uuid,'mixed'::public.bird_species,'50+'::public.flock_band,'flying_over'::public.sighting_behavior,34.250,-102.350,83,92,8), -- Southern High Plains playas
    ('f2000000-0000-4000-8000-000000000006'::uuid,'white_fronted_goose'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,29.390,-96.120,88,111,9), -- Texas mid-coast
    ('f2000000-0000-4000-8000-000000000007'::uuid,'teal'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,28.780,-96.760,89,132,8), -- Aransas coastal prairie
    ('f2000000-0000-4000-8000-000000000008'::uuid,'mallard'::public.bird_species,'10-25'::public.flock_band,'circling'::public.sighting_behavior,37.640,-105.730,72,151,7), -- San Luis Valley
    ('f2000000-0000-4000-8000-000000000009'::uuid,'mixed'::public.bird_species,'25-50'::public.flock_band,'moving_in'::public.sighting_behavior,33.800,-106.880,81,173,8), -- Middle Rio Grande

    -- Mississippi Flyway: upper Midwest wetlands down major river corridors
    ('f3000000-0000-4000-8000-000000000001'::uuid,'canada_goose'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,47.150,-96.100,92,14,9), -- western Minnesota wetlands
    ('f3000000-0000-4000-8000-000000000002'::uuid,'diver'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,43.610,-88.640,84,31,9), -- Horicon Marsh
    ('f3000000-0000-4000-8000-000000000003'::uuid,'mallard'::public.bird_species,'25-50'::public.flock_band,'moving_in'::public.sighting_behavior,43.850,-91.250,86,48,8), -- Upper Mississippi pools
    ('f3000000-0000-4000-8000-000000000004'::uuid,'gadwall'::public.bird_species,'10-25'::public.flock_band,'feeding'::public.sighting_behavior,40.000,-90.980,75,66,8), -- Illinois River valley
    ('f3000000-0000-4000-8000-000000000005'::uuid,'snow_goose'::public.bird_species,'50+'::public.flock_band,'resting'::public.sighting_behavior,36.940,-90.140,90,81,9), -- Mingo wetlands
    ('f3000000-0000-4000-8000-000000000006'::uuid,'mallard'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,35.120,-91.260,93,99,9), -- Cache/White River
    ('f3000000-0000-4000-8000-000000000007'::uuid,'wood_duck'::public.bird_species,'10-25'::public.flock_band,'moving_in'::public.sighting_behavior,36.370,-89.390,78,118,8), -- Reelfoot Lake
    ('f3000000-0000-4000-8000-000000000008'::uuid,'mixed'::public.bird_species,'25-50'::public.flock_band,'flying_over'::public.sighting_behavior,32.980,-90.970,82,139,8), -- Mississippi Delta
    ('f3000000-0000-4000-8000-000000000009'::uuid,'teal'::public.bird_species,'50+'::public.flock_band,'feeding'::public.sighting_behavior,29.700,-91.150,88,160,8), -- Atchafalaya Basin

    -- Atlantic Flyway: Great Lakes/Northeast staging to Chesapeake and southeast coast
    ('f4000000-0000-4000-8000-000000000001'::uuid,'diver'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,44.560,-73.300,83,24,9), -- Lake Champlain
    ('f4000000-0000-4000-8000-000000000002'::uuid,'mallard'::public.bird_species,'25-50'::public.flock_band,'feeding'::public.sighting_behavior,42.990,-76.730,80,43,8), -- Montezuma wetlands
    ('f4000000-0000-4000-8000-000000000003'::uuid,'tundra_swan'::public.bird_species,'50+'::public.flock_band,'flying_over'::public.sighting_behavior,40.850,-72.550,87,61,8), -- Long Island coast
    ('f4000000-0000-4000-8000-000000000004'::uuid,'snow_goose'::public.bird_species,'50+'::public.flock_band,'resting'::public.sighting_behavior,39.120,-75.450,91,79,9), -- Delaware Bay
    ('f4000000-0000-4000-8000-000000000005'::uuid,'mallard'::public.bird_species,'25-50'::public.flock_band,'feeding'::public.sighting_behavior,38.430,-76.080,89,96,9), -- Chesapeake Bay
    ('f4000000-0000-4000-8000-000000000006'::uuid,'canada_goose'::public.bird_species,'10-25'::public.flock_band,'moving_in'::public.sighting_behavior,35.720,-75.510,77,116,8), -- Pea Island/Outer Banks
    ('f4000000-0000-4000-8000-000000000007'::uuid,'wood_duck'::public.bird_species,'10-25'::public.flock_band,'feeding'::public.sighting_behavior,32.640,-80.430,76,137,8), -- ACE Basin
    ('f4000000-0000-4000-8000-000000000008'::uuid,'teal'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,30.050,-81.450,82,158,8), -- northeast Florida marshes
    ('f4000000-0000-4000-8000-000000000009'::uuid,'diver'::public.bird_species,'25-50'::public.flock_band,'resting'::public.sighting_behavior,28.650,-80.730,80,179,8) -- Merritt Island
)
insert into public.sightings (
  id, reporter_id, species, flock_size, behavior,
  exact_latitude, exact_longitude, accuracy_meters, confidence,
  occurred_at, expires_at, created_at, status
)
select
  seed.id, reporter.id, seed.species, seed.flock_size, seed.behavior,
  seed.latitude, seed.longitude, 2500, seed.confidence,
  now() - make_interval(mins => seed.age_minutes),
  now() - make_interval(mins => seed.age_minutes) + make_interval(hours => seed.lifetime_hours),
  now(), 'active'
from seed cross join reporter
on conflict (id) do update set
  reporter_id = excluded.reporter_id,
  species = excluded.species,
  flock_size = excluded.flock_size,
  behavior = excluded.behavior,
  exact_latitude = excluded.exact_latitude,
  exact_longitude = excluded.exact_longitude,
  accuracy_meters = excluded.accuracy_meters,
  confidence = excluded.confidence,
  occurred_at = excluded.occurred_at,
  expires_at = excluded.expires_at,
  created_at = excluded.created_at,
  status = 'active';

commit;

-- Confirm the 36 active seed records are visible through the public-safe RPC:
select count(*) as active_seed_sightings
from public.sightings
where id::text ~ '^f[1-4]000000-0000-4000-8000-00000000000[1-9]$'
  and status = 'active'
  and expires_at > now();
