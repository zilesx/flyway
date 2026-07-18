begin;

alter table public.profiles add column if not exists role text not null default 'user' check (role in ('user','moderator','admin'));
alter table public.profiles add column if not exists suspended_until timestamptz;
alter table public.flags add column if not exists resolved_at timestamptz;
alter table public.flags add column if not exists resolved_by uuid references public.profiles(id);
update public.profiles set preferences=jsonb_set(coalesce(preferences,'{}'::jsonb),'{visible_groups}','["ducks","geese","cranes","doves","shorebirds","upland","other"]'::jsonb,true);

create table if not exists public.bird_categories (
  slug text primary key check (slug ~ '^[a-z0-9_]+$'),
  display_name text not null,
  enabled boolean not null default true,
  sort_order integer not null default 100
);

create table if not exists public.species_catalog (
  slug text primary key check (slug ~ '^[a-z0-9_]+$'),
  display_name text not null,
  category_slug text not null references public.bird_categories(slug),
  enabled boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.bird_categories(slug,display_name,sort_order) values
 ('ducks','Ducks',10),('geese','Geese & Swans',20),('cranes','Cranes',30),
 ('doves','Doves & Pigeons',40),('shorebirds','Shorebirds',50),
 ('upland','Migratory Upland Birds',60),('other','Other Migratory Birds',90)
on conflict(slug) do update set display_name=excluded.display_name,sort_order=excluded.sort_order;

insert into public.species_catalog(slug,display_name,category_slug,sort_order) values
 ('mallard','Mallard','ducks',10),('teal','Teal','ducks',20),('gadwall','Gadwall','ducks',30),
 ('pintail','Northern Pintail','ducks',40),('wood_duck','Wood Duck','ducks',50),('diver','Diving Duck','ducks',60),('mixed','Mixed Ducks','ducks',90),
 ('canada_goose','Canada Goose','geese',10),('snow_goose','Snow Goose','geese',20),('white_fronted_goose','White-fronted Goose','geese',30),('tundra_swan','Tundra Swan','geese',40),
 ('sandhill_crane','Sandhill Crane','cranes',10),
 ('mourning_dove','Mourning Dove','doves',10),('white_winged_dove','White-winged Dove','doves',20),('eurasian_collared_dove','Eurasian Collared-Dove','doves',30),
 ('american_woodcock','American Woodcock','upland',10),('common_snipe','Wilson''s Snipe','shorebirds',10),('american_coot','American Coot','other',10),
 ('other','Other Migratory Bird','other',90)
on conflict(slug) do update set display_name=excluded.display_name,category_slug=excluded.category_slug,sort_order=excluded.sort_order;

alter table public.sightings add column if not exists species_slug text;
update public.sightings set species_slug=species::text where species_slug is null;
alter table public.sightings alter column species drop not null;
alter table public.sightings add constraint sightings_species_catalog_fk foreign key(species_slug) references public.species_catalog(slug);

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  description text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);
insert into public.app_config(key,value,description) values
 ('reporting','{"enabled":true,"max_note_length":1000,"photo_limit":1}'::jsonb,'Reporting controls'),
 ('moderation','{"auto_hide_flag_count":3,"comments_enabled":true}'::jsonb,'Moderation controls'),
 ('map','{"default_days":7,"max_days":90,"max_results":250}'::jsonb,'Map defaults'),
 ('privacy','{"location_blur_required":true,"minimum_blur_miles":2}'::jsonb,'Immutable privacy floor')
on conflict(key) do nothing;

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id),
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit_log(created_at desc);
create index if not exists flags_unresolved_idx on public.flags(created_at desc) where resolved_at is null;

alter table public.bird_categories enable row level security;
alter table public.species_catalog enable row level security;
alter table public.app_config enable row level security;
alter table public.admin_audit_log enable row level security;
revoke all on public.bird_categories,public.species_catalog,public.app_config,public.admin_audit_log from anon,authenticated;

commit;

drop function if exists public.nearby_sightings(integer,timestamptz);
create function public.nearby_sightings(p_limit integer default 100,p_since timestamptz default(now()-interval '7 days'))
returns table(id uuid,species text,flock_size public.flock_band,behavior public.sighting_behavior,zone_latitude double precision,zone_longitude double precision,confidence smallint,occurred_at timestamptz,expires_at timestamptz,confirmations bigint,notes text)
language sql security definer set search_path=public as $$
 select s.id,s.species_slug,s.flock_size,s.behavior,
 round((s.exact_latitude+(((('x'||substr(md5(s.id::text||':lat'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.06)::numeric,3)::double precision,
 round((s.exact_longitude+(((('x'||substr(md5(s.id::text||':lng'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.08)::numeric,3)::double precision,
 s.confidence,s.occurred_at,s.expires_at,count(c.hunter_id),s.notes
 from public.sightings s left join public.confirmations c on c.sighting_id=s.id
 join public.species_catalog sc on sc.slug=s.species_slug and sc.enabled
 where s.status='active' and s.occurred_at>=greatest(p_since,now()-interval '90 days')
 group by s.id order by s.occurred_at desc limit least(greatest(p_limit,1),250);
$$;
revoke all on function public.nearby_sightings(integer,timestamptz) from public;
grant execute on function public.nearby_sightings(integer,timestamptz) to anon,authenticated;
