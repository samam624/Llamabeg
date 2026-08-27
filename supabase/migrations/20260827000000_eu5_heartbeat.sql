-- Free-tier Supabase auto-pauses a project after 7 days of no API
-- activity (see docs/ or [[supabase_heartbeat_and_deploy_gap]] memory).
-- The original heartbeat (.github/workflows/supabase-heartbeat.yml) just
-- did an anon SELECT against eu5_campaigns every 3 days, but the project
-- paused anyway despite that heartbeat succeeding on schedule right up
-- until the pause - strong evidence a plain read isn't being counted as
-- real activity. This table + RPC exist purely so the heartbeat can
-- perform an actual WRITE instead, in case that's what's needed to reset
-- the inactivity clock. Not part of the app's real data model.
create table if not exists public.eu5_heartbeat (
  id boolean primary key default true,
  pinged_at timestamptz not null default now(),
  constraint eu5_heartbeat_singleton check (id)
);

insert into public.eu5_heartbeat (id, pinged_at)
values (true, now())
on conflict (id) do nothing;

alter table public.eu5_heartbeat enable row level security;

-- No direct anon grants on the table itself - anon can only touch it
-- through the security-definer RPC below, same pattern as
-- eu5_capture_black_death (20260730080000_eu5_black_death_captures.sql).
grant select, insert, update, delete on public.eu5_heartbeat to service_role;

create or replace function public.eu5_heartbeat_ping()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  result timestamptz;
begin
  update public.eu5_heartbeat
  set pinged_at = now()
  where id = true
  returning pinged_at into result;
  return result;
end;
$$;

grant execute on function public.eu5_heartbeat_ping() to anon, authenticated;
grant execute on function public.eu5_heartbeat_ping() to service_role;
