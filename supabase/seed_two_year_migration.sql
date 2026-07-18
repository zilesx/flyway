-- Synthetic demonstration data informed by broad USFWS seasonal timing.
-- It is deliberately labeled and can be removed by seed_batch_id.
\set ON_ERROR_STOP on
begin;
select setseed(0.4172026);

do $$
declare
  batch uuid := '7c091b20-26f7-4f11-a202-607170000001';
  reporters uuid[];
  species_list text[] := array['mallard','pintail','teal','gadwall','canada_goose','snow_goose','white_fronted_goose','sandhill_crane','mourning_dove','white_winged_dove','american_woodcock','tundra_swan','american_coot','wood_duck','diver','mixed'];
  centers jsonb := '[
    {"lat":38.1,"lon":-121.5,"flyway":"pacific"},{"lat":41.1,"lon":-112.0,"flyway":"pacific"},{"lat":32.8,"lon":-115.5,"flyway":"pacific"},
    {"lat":40.7,"lon":-98.8,"flyway":"central"},{"lat":46.2,"lon":-100.5,"flyway":"central"},{"lat":29.4,"lon":-98.2,"flyway":"central"},
    {"lat":38.6,"lon":-90.1,"flyway":"mississippi"},{"lat":34.7,"lon":-91.2,"flyway":"mississippi"},{"lat":29.8,"lon":-92.2,"flyway":"mississippi"},
    {"lat":35.5,"lon":-76.4,"flyway":"atlantic"},{"lat":39.2,"lon":-75.4,"flyway":"atlantic"},{"lat":28.2,"lon":-81.4,"flyway":"atlantic"}
  ]'::jsonb;
  i integer; d timestamptz; doy integer; season text; c jsonb; sp text; lat double precision; lon double precision; flock public.flock_band; behavior public.sighting_behavior;
begin
  select array_agg(id) into reporters from public.profiles;
  if coalesce(array_length(reporters,1),0)=0 then raise exception 'Create at least one Flyway account before loading seed data'; end if;
  delete from public.sightings where seed_batch_id=batch;
  for i in 1..12000 loop
    d := now()-((random()*730)::integer||' days')::interval-(random()*interval '23 hours');
    doy := extract(doy from d);
    season := case when doy between 55 and 135 then 'spring' when doy between 225 and 350 then 'fall' when doy<80 or doy>335 then 'winter' else 'summer' end;
    c := centers->floor(random()*jsonb_array_length(centers))::integer;
    sp := species_list[1+floor(random()*array_length(species_list,1))::integer];
    -- Spring shifts north, fall/winter shifts south; cranes concentrate on the Platte in March.
    if sp='sandhill_crane' and extract(month from d)=3 then c:='{"lat":40.8,"lon":-98.7,"flyway":"central"}'::jsonb; end if;
    lat := (c->>'lat')::double precision + (random()-.5)*3.0 + case season when 'spring' then (doy-55)/80.0*5 when 'fall' then -(doy-225)/125.0*5 when 'winter' then -3 else 2 end;
    lon := (c->>'lon')::double precision + (random()-.5)*3.2;
    flock := (case when sp in ('snow_goose','canada_goose','sandhill_crane','tundra_swan') and random()>.25 then '50+' when random()>.62 then '25-50' when random()>.30 then '10-25' else '1-10' end)::public.flock_band;
    behavior := (array['feeding','resting','flying_over','circling','moving_in'])[1+floor(random()*5)::integer]::public.sighting_behavior;
    insert into public.sightings(reporter_id,species_slug,flock_size,behavior,notes,observed_weather,exact_latitude,exact_longitude,accuracy_meters,confidence,occurred_at,expires_at,created_at,status,is_synthetic,seed_batch_id)
    select reporters[1+floor(random()*array_length(reporters,1))::integer],sc.slug,flock,behavior,'Synthetic migration-pattern demonstration record',jsonb_build_object('sky',(array['clear','partly_cloudy','overcast','fog'])[1+floor(random()*4)::integer],'precipitation',case when random()<.72 then 'none' when season='winter' and lat>35 then 'snow' when random()<.5 then 'drizzle' else 'rain' end,'wind',(array['calm','light','moderate','strong'])[1+floor(random()*4)::integer],'wind_direction',(array['N','NE','E','SE','S','SW','W','NW'])[1+floor(random()*8)::integer],'temperature',round((case season when 'winter' then 32 when 'spring' then 55 when 'summer' then 78 else 58 end+(random()-.5)*24)::numeric,0),'temperature_unit','F','visibility',(array['good','good','moderate','poor'])[1+floor(random()*4)::integer]),lat,lon,100+floor(random()*900)::integer,55+floor(random()*41)::integer,d,d+interval '6 hours',d+interval '5 minutes',case when d>now()-interval '6 hours' then 'active' else 'expired' end,true,batch
    from public.species_catalog sc where sc.slug=sp and sc.enabled limit 1;
  end loop;
  raise notice 'Synthetic batch: %',batch;
end $$;
commit;

-- Rollback: delete from public.sightings where seed_batch_id='7c091b20-26f7-4f11-a202-607170000001';
