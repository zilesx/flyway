begin;

alter table public.species_catalog
  add column if not exists season_start_month smallint check (season_start_month between 1 and 12),
  add column if not exists season_start_day smallint check (season_start_day between 1 and 31),
  add column if not exists season_end_month smallint check (season_end_month between 1 and 12),
  add column if not exists season_end_day smallint check (season_end_day between 1 and 31),
  add column if not exists season_region text;

create index if not exists species_catalog_display_order_idx
  on public.species_catalog (category_slug, sort_order, display_name);

commit;
