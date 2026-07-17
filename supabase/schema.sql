create extension if not exists pgcrypto;

create type public.bird_species as enum ('mallard', 'teal', 'gadwall', 'pintail', 'wood_duck', 'diver', 'mixed', 'other', 'canada_goose', 'snow_goose', 'white_fronted_goose', 'sandhill_crane', 'tundra_swan');
create type public.sighting_behavior as enum ('feeding', 'circling', 'flying_over', 'resting', 'moving_in');
create type public.flock_band as enum ('1-10', '10-25', '25-50', '50+');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) between 2 and 40),
  trust_score smallint not null default 50 check (trust_score between 0 and 100),
  report_count integer not null default 0,
  confirmed_count integer not null default 0,
  preferences jsonb not null default '{"visible_groups":["ducks","geese","cranes"],"default_days":7,"start_view":"us","auto_open_card":true}'::jsonb check (jsonb_typeof(preferences) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sightings (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  species public.bird_species not null,
  flock_size public.flock_band not null,
  behavior public.sighting_behavior not null,
  exact_latitude double precision not null check (exact_latitude between -90 and 90),
  exact_longitude double precision not null check (exact_longitude between -180 and 180),
  accuracy_meters integer check (accuracy_meters between 0 and 10000),
  confidence smallint not null default 50 check (confidence between 0 and 100),
  occurred_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '6 hours'),
  created_at timestamptz not null default now(),
  status text not null default 'active' check (status in ('active', 'expired', 'flagged', 'removed')),
  constraint sane_report_time check (occurred_at <= created_at + interval '5 minutes'),
  constraint sane_expiry check (expires_at > occurred_at and expires_at <= occurred_at + interval '12 hours')
);

create index sightings_active_idx on public.sightings (expires_at desc) where status = 'active';
create index sightings_reporter_idx on public.sightings (reporter_id, created_at desc);

create table public.confirmations (
  sighting_id uuid not null references public.sightings(id) on delete cascade,
  hunter_id uuid not null references public.profiles(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  primary key (sighting_id, hunter_id)
);

create table public.flags (
  id bigint generated always as identity primary key,
  sighting_id uuid not null references public.sightings(id) on delete cascade,
  hunter_id uuid not null references public.profiles(id) on delete cascade,
  reason text not null check (reason in ('false_report', 'unsafe', 'spam', 'other')),
  created_at timestamptz not null default now(),
  unique (sighting_id, hunter_id)
);

alter table public.profiles enable row level security;
alter table public.sightings enable row level security;
alter table public.confirmations enable row level security;
alter table public.flags enable row level security;

create policy "read own profile" on public.profiles for select using (id = auth.uid());
create policy "update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create policy "insert own sighting" on public.sightings for insert with check (reporter_id = auth.uid());
create policy "read own raw sightings" on public.sightings for select using (reporter_id = auth.uid());
create policy "insert confirmation" on public.confirmations for insert with check (hunter_id = auth.uid());
create policy "read own confirmations" on public.confirmations for select using (hunter_id = auth.uid());
create policy "insert flag" on public.flags for insert with check (hunter_id = auth.uid());

create or replace function public.nearby_sightings(p_limit integer default 100, p_since timestamptz default (now() - interval '7 days'))
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
  where s.status = 'active' and s.occurred_at >= greatest(p_since, now() - interval '90 days')
  group by s.id
  order by s.occurred_at desc
  limit least(greatest(p_limit, 1), 250);
$$;

revoke all on function public.nearby_sightings(integer, timestamptz) from public;
grant execute on function public.nearby_sightings(integer, timestamptz) to anon, authenticated;

-- Raw sightings are intentionally unavailable to anon/authenticated users.
revoke select (exact_latitude, exact_longitude, accuracy_meters) on public.sightings from anon, authenticated;
