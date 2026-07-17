begin;

alter table public.profiles
  add column if not exists preferences jsonb not null default '{"visible_groups":["ducks","geese","cranes"],"default_days":7,"start_view":"us","auto_open_card":true}'::jsonb;

alter table public.profiles drop constraint if exists profiles_preferences_object;
alter table public.profiles add constraint profiles_preferences_object
  check (jsonb_typeof(preferences) = 'object');

commit;
