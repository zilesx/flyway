begin;
alter table public.profiles alter column show_attribution set default false;
alter table public.sightings add column if not exists observed_weather jsonb;
alter table public.sightings add constraint sightings_observed_weather_object check(observed_weather is null or jsonb_typeof(observed_weather)='object') not valid;
commit;

drop function if exists public.activity_heatmap(timestamptz,double precision,integer);
drop function if exists public.nearby_sightings(integer,timestamptz);
create function public.nearby_sightings(p_limit integer default 100,p_since timestamptz default(now()-interval '7 days'))
returns table(id uuid,species text,flock_size public.flock_band,behavior public.sighting_behavior,zone_latitude double precision,zone_longitude double precision,confidence smallint,occurred_at timestamptz,expires_at timestamptz,confirmations bigint,notes text,weather jsonb,observed_weather jsonb,reporter_name text)
language sql security definer set search_path=public as $$
 select s.id,s.species_slug,s.flock_size,s.behavior,
 round((s.exact_latitude+(((('x'||substr(md5(s.id::text||':lat'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.06)::numeric,3)::double precision,
 round((s.exact_longitude+(((('x'||substr(md5(s.id::text||':lng'),1,8))::bit(32)::bigint%1000)/1000.0)-.5)*.08)::numeric,3)::double precision,
 s.confidence,s.occurred_at,s.expires_at,count(c.hunter_id),s.notes,s.weather,s.observed_weather,
 case when p.show_attribution then coalesce(nullif(trim(p.first_name),'')||case when nullif(trim(p.last_name),'') is not null then ' '||upper(left(trim(p.last_name),1))||'.' else '' end,'Flyway member') else 'Flyway member' end
 from public.sightings s
 left join public.confirmations c on c.sighting_id=s.id
 join public.species_catalog sc on sc.slug=s.species_slug and sc.enabled
 left join public.profiles p on p.id=s.reporter_id
 where s.status='active' and s.occurred_at>=greatest(p_since,now()-interval '90 days')
 group by s.id,p.id
 order by s.occurred_at desc limit least(greatest(p_limit,1),250);
$$;
revoke all on function public.nearby_sightings(integer,timestamptz) from public;
grant execute on function public.nearby_sightings(integer,timestamptz) to anon,authenticated;

create function public.activity_heatmap(p_since timestamptz default(now()-interval '7 days'),p_grid_degrees double precision default 4,p_minimum integer default 3)
returns table(cell_latitude double precision,cell_longitude double precision,report_count bigint,dominant_category text,intensity double precision)
language sql security definer set search_path=public as $$
 with safe as(select n.*,sc.category_slug from public.nearby_sightings(250,p_since)n join public.species_catalog sc on sc.slug=n.species),grouped as(select floor(zone_latitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lat,floor(zone_longitude/p_grid_degrees)*p_grid_degrees+p_grid_degrees/2 lon,category_slug,count(*) count from safe group by 1,2,3),ranked as(select *,row_number()over(partition by lat,lon order by count desc,category_slug)rn,sum(count)over(partition by lat,lon)total from grouped)select lat,lon,total,category_slug,least(1.0,total::double precision/12.0)from ranked where rn=1 and total>=greatest(p_minimum,3);
$$;
revoke all on function public.activity_heatmap(timestamptz,double precision,integer) from public;
grant execute on function public.activity_heatmap(timestamptz,double precision,integer) to anon,authenticated;
