-- Adds broader migratory-bird species and historical time-window queries.
-- Safe to run once against an existing Flyway database.

begin;

alter type public.duck_species rename to bird_species;
alter type public.bird_species add value if not exists 'canada_goose';
alter type public.bird_species add value if not exists 'snow_goose';
alter type public.bird_species add value if not exists 'white_fronted_goose';
alter type public.bird_species add value if not exists 'sandhill_crane';
alter type public.bird_species add value if not exists 'tundra_swan';

drop function if exists public.nearby_sightings(integer);

create function public.nearby_sightings(
  p_limit integer default 100,
  p_since timestamptz default (now() - interval '7 days')
)
returns table (
  id uuid, species public.bird_species, flock_size public.flock_band,
  behavior public.sighting_behavior, zone_latitude double precision,
  zone_longitude double precision, confidence smallint, occurred_at timestamptz,
  expires_at timestamptz, confirmations bigint
)
language sql
security definer
set search_path = public
as $$
  select s.id, s.species, s.flock_size, s.behavior,
    round((s.exact_latitude + (((('x' || substr(md5(s.id::text || ':lat'), 1, 8))::bit(32)::bigint % 1000) / 1000.0) - .5) * .06)::numeric, 3)::double precision,
    round((s.exact_longitude + (((('x' || substr(md5(s.id::text || ':lng'), 1, 8))::bit(32)::bigint % 1000) / 1000.0) - .5) * .08)::numeric, 3)::double precision,
    s.confidence, s.occurred_at, s.expires_at, count(c.hunter_id)
  from public.sightings s
  left join public.confirmations c on c.sighting_id = s.id
  where s.status = 'active'
    and s.occurred_at >= greatest(p_since, now() - interval '90 days')
  group by s.id
  order by s.occurred_at desc
  limit least(greatest(p_limit, 1), 250);
$$;

revoke all on function public.nearby_sightings(integer, timestamptz) from public;
grant execute on function public.nearby_sightings(integer, timestamptz) to anon, authenticated;

commit;
