-- Game patch 1.3.11 stopped serializing a per-country Black Death death
-- breakdown into the save file at all (see docs/ARCHITECTURE.md's "Black
-- Death analyzer" section, 2026-07-30 updates, for the full investigation -
-- the data is confirmed unrecoverable from a 1.3.11+ save on its own). Since
-- an outbreak's death toll is fixed forever once the outbreak ends, this
-- captures it the first time ANY save (pre-1.3.11, or a 1.3.11+ save
-- uploaded before too much per-location data has been pruned) provides it,
-- keyed by the save's own playthrough_id + the outbreak's own identity
-- number (both already present in every save's metadata/situation_manager -
-- no filename parsing needed, unlike the llama-ledger campaign_key). A LATER
-- save of the same campaign that no longer carries the raw data can then
-- look the captured total up instead of needing it again.
create table if not exists public.eu5_black_death_captures (
  playthrough_id text not null,
  outbreak_identity bigint not null,
  deaths_by_country jsonb not null,
  start_date text,
  end_date text,
  game_version text,
  captured_at timestamptz not null default now(),
  primary key (playthrough_id, outbreak_identity)
);

alter table public.eu5_black_death_captures enable row level security;

drop policy if exists "Public read EU5 black death captures" on public.eu5_black_death_captures;
create policy "Public read EU5 black death captures"
  on public.eu5_black_death_captures for select
  using (true);

grant select on public.eu5_black_death_captures to anon, authenticated;
grant select, insert, update, delete on public.eu5_black_death_captures to service_role;

-- Anon-callable capture, same security-definer-RPC pattern as
-- eu5_upsert_campaign (see 20260718050000_eu5_upsert_campaign_ledger_chunked_rpc.sql)
-- rather than a direct anon INSERT grant on the table. ON CONFLICT DO
-- NOTHING deliberately keeps only the FIRST-ever capture for a given
-- outbreak: every caller only invokes this when deathsByCountry is
-- non-null, so a later call could in principle carry a less-complete
-- reading (e.g. a future patch quirk) - never worth risking overwriting a
-- known-good captured total with a worse one.
create or replace function public.eu5_capture_black_death(
  p_playthrough_id text,
  p_outbreak_identity bigint,
  p_deaths_by_country jsonb,
  p_start_date text,
  p_end_date text,
  p_game_version text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_playthrough_id is null or p_outbreak_identity is null or p_deaths_by_country is null then
    return;
  end if;
  insert into public.eu5_black_death_captures (
    playthrough_id, outbreak_identity, deaths_by_country, start_date, end_date, game_version
  )
  values (p_playthrough_id, p_outbreak_identity, p_deaths_by_country, p_start_date, p_end_date, p_game_version)
  on conflict (playthrough_id, outbreak_identity) do nothing;
end;
$$;

grant execute on function public.eu5_capture_black_death(text, bigint, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.eu5_capture_black_death(text, bigint, jsonb, text, text, text) to service_role;
