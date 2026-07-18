begin;

-- Security policy is data, but secrets remain deployment environment variables.
insert into public.app_config(key,value,description) values
 ('security','{"mfa_policy":"optional","admin_totp_required":false,"moderator_totp_required":false,"step_up_for_sensitive_actions":true,"password_reset_window_minutes":60,"login_max_failures":8,"lockout_minutes":15}'::jsonb,'Authentication, recovery, lockout, and MFA policy'),
 ('map_layers','{"heatmap_max_zoom":5,"cluster_max_zoom":7,"minimum_heat_reports":3,"grid_degrees":4}'::jsonb,'Privacy-preserving map visualization thresholds'),
 ('notifications','{"security_email":true,"moderation_email":true,"comment_email":false}'::jsonb,'User notification defaults')
on conflict(key) do nothing;

alter table public.species_catalog add column if not exists scientific_name text;
alter table public.species_catalog add column if not exists aliases text[] not null default '{}';
alter table public.species_catalog add column if not exists description text;
alter table public.species_catalog add column if not exists color text not null default '#b9e94a';
alter table public.species_catalog add column if not exists sensitive boolean not null default false;
alter table public.species_catalog add column if not exists visible_in_filters boolean not null default true;
alter table public.species_catalog add column if not exists archived_at timestamptz;

create table if not exists public.security_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  outcome text not null,
  ip_hash text,
  request_id uuid not null default gen_random_uuid(),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists security_events_created_idx on public.security_events(created_at desc);
create index if not exists security_events_user_idx on public.security_events(user_id,created_at desc);

create table if not exists public.moderation_cases (
  id uuid primary key default gen_random_uuid(),
  content_type text not null check(content_type in ('sighting','comment','photo','note')),
  content_id uuid not null,
  status text not null default 'open' check(status in ('open','assigned','escalated','approved','removed','duplicate','needs_info')),
  reason text not null,
  assigned_to uuid references public.profiles(id),
  resolution_reason text,
  moderator_note text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id)
);
create index if not exists moderation_cases_queue_idx on public.moderation_cases(status,created_at desc);

alter table public.security_events enable row level security;
alter table public.moderation_cases enable row level security;
revoke all on public.security_events,public.moderation_cases from anon,authenticated;

commit;

-- Aggregates already-randomized zones. Exact coordinates never leave the database.
create or replace function public.activity_heatmap(p_since timestamptz default(now()-interval '7 days'),p_grid_degrees double precision default 4,p_minimum integer default 3)
returns table(cell_latitude double precision,cell_longitude double precision,report_count bigint,dominant_category text,intensity double precision)
language sql security definer set search_path=public as $$
 with safe as (select n.*,sc.category_slug from public.nearby_sightings(250,p_since) n join public.species_catalog sc on sc.slug=n.species),
 grouped as (select floor(zone_latitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lat,floor(zone_longitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lon,category_slug,count(*) count from safe group by 1,2,3),
 ranked as (select *,row_number() over(partition by lat,lon order by count desc,category_slug) rn,sum(count) over(partition by lat,lon) total from grouped)
 select lat,lon,total,category_slug,least(1.0,total::double precision/12.0) from ranked where rn=1 and total>=greatest(p_minimum,3);
$$;
revoke all on function public.activity_heatmap(timestamptz,double precision,integer) from public;
grant execute on function public.activity_heatmap(timestamptz,double precision,integer) to anon,authenticated;
