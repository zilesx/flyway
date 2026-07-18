begin;
alter table public.profiles add column if not exists first_name text check(char_length(first_name)<=50);
alter table public.profiles add column if not exists last_name text check(char_length(last_name)<=80);
alter table public.profiles add column if not exists bio text check(char_length(bio)<=280);
alter table public.profiles add column if not exists region text check(char_length(region)<=80);
alter table public.profiles add column if not exists distance_units text not null default 'miles' check(distance_units in ('miles','kilometers'));
alter table public.profiles add column if not exists show_attribution boolean not null default true;
alter table public.profiles add column if not exists notification_preferences jsonb not null default '{"comments":true,"confirmations":true,"moderation":true,"security":true}'::jsonb;
alter table public.sightings add column if not exists weather jsonb;
alter table public.sightings add column if not exists reporter_attribution text;

create table if not exists public.content_reports(id uuid primary key default gen_random_uuid(),reporter_id uuid not null references public.profiles(id) on delete cascade,content_type text not null check(content_type in('sighting','comment','photo','note')),content_id uuid not null,reason text not null,details text check(char_length(details)<=500),created_at timestamptz not null default now(),unique(reporter_id,content_type,content_id));
create table if not exists public.duplicate_candidates(id uuid primary key default gen_random_uuid(),sighting_a uuid not null references public.sightings(id) on delete cascade,sighting_b uuid not null references public.sightings(id) on delete cascade,similarity smallint not null check(similarity between 0 and 100),status text not null default 'pending' check(status in('pending','merged','related','separate')),reviewed_by uuid references public.profiles(id),reviewed_at timestamptz,created_at timestamptz not null default now(),unique(sighting_a,sighting_b));
create table if not exists public.notifications(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,type text not null,title text not null,body text not null,href text,read_at timestamptz,created_at timestamptz not null default now());
create table if not exists public.app_sessions(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles(id) on delete cascade,session_id text not null,device text,ip_hash text,last_seen_at timestamptz not null default now(),created_at timestamptz not null default now(),revoked_at timestamptz,unique(user_id,session_id));
create table if not exists public.hunting_regulations(id uuid primary key default gen_random_uuid(),jurisdiction text not null,species_slug text references public.species_catalog(slug),season_label text not null,starts_on date,ends_on date,shooting_hours text,daily_limit text,possession_limit text,permit_note text,source_url text not null,effective_at timestamptz not null,verified_at timestamptz not null,status text not null default 'active' check(status in('draft','active','expired')),created_at timestamptz not null default now());
create index if not exists notifications_user_idx on public.notifications(user_id,created_at desc);
create index if not exists duplicate_candidates_status_idx on public.duplicate_candidates(status,created_at desc);
alter table public.content_reports enable row level security;alter table public.duplicate_candidates enable row level security;alter table public.notifications enable row level security;alter table public.app_sessions enable row level security;alter table public.hunting_regulations enable row level security;
revoke all on public.content_reports,public.duplicate_candidates,public.notifications,public.app_sessions,public.hunting_regulations from anon,authenticated;
commit;

drop function if exists public.activity_heatmap(timestamptz,double precision,integer);
drop function if exists public.nearby_sightings(integer,timestamptz);
create function public.nearby_sightings(p_limit integer default 100,p_since timestamptz default(now()-interval '7 days'))
returns table(id uuid,species text,flock_size public.flock_band,behavior public.sighting_behavior,zone_latitude double precision,zone_longitude double precision,confidence smallint,occurred_at timestamptz,expires_at timestamptz,confirmations bigint,notes text,weather jsonb,reporter_name text)
language sql security definer set search_path=public as $$
 select s.id,s.species_slug,s.flock_size,s.behavior,round((s.exact_latitude+(((('x'||substr(md5(s.id::text||':lat'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.06)::numeric,3)::double precision,round((s.exact_longitude+(((('x'||substr(md5(s.id::text||':lng'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.08)::numeric,3)::double precision,s.confidence,s.occurred_at,s.expires_at,count(c.hunter_id),s.notes,s.weather,coalesce(s.reporter_attribution,'Flyway member')
 from public.sightings s left join public.confirmations c on c.sighting_id=s.id join public.species_catalog sc on sc.slug=s.species_slug and sc.enabled where s.status='active' and s.occurred_at>=greatest(p_since,now()-interval '90 days') group by s.id order by s.occurred_at desc limit least(greatest(p_limit,1),250);
$$;
revoke all on function public.nearby_sightings(integer,timestamptz) from public;grant execute on function public.nearby_sightings(integer,timestamptz) to anon,authenticated;

create function public.activity_heatmap(p_since timestamptz default(now()-interval '7 days'),p_grid_degrees double precision default 4,p_minimum integer default 3)
returns table(cell_latitude double precision,cell_longitude double precision,report_count bigint,dominant_category text,intensity double precision)
language sql security definer set search_path=public as $$
 with safe as(select n.*,sc.category_slug from public.nearby_sightings(250,p_since)n join public.species_catalog sc on sc.slug=n.species),grouped as(select floor(zone_latitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lat,floor(zone_longitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lon,category_slug,count(*) count from safe group by 1,2,3),ranked as(select *,row_number()over(partition by lat,lon order by count desc,category_slug)rn,sum(count)over(partition by lat,lon)total from grouped)select lat,lon,total,category_slug,least(1.0,total::double precision/12.0)from ranked where rn=1 and total>=greatest(p_minimum,3);
$$;
revoke all on function public.activity_heatmap(timestamptz,double precision,integer) from public;grant execute on function public.activity_heatmap(timestamptz,double precision,integer) to anon,authenticated;
