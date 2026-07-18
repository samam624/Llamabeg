-- The combined eu5_upsert_campaign_ledger(campaign, snapshots, events) RPC
-- from the previous migration hit the anon/authenticated role's statement
-- timeout on a real campaign (49 snapshots + 116 events, one call) -
-- snapshot rows embed a large jsonb blob each, and
-- scripts/import-llama-ledgers-to-supabase.js already learned this same
-- lesson (TABLE_CHUNK_SIZES chunks snapshots ONE at a time even under the
-- unlimited service_role connection). Split into three narrow RPCs so the
-- browser can chunk each table's writes the same conservative way - see
-- js/share-store.js's uploadCampaignLedger.
drop function if exists public.eu5_upsert_campaign_ledger(jsonb, jsonb, jsonb);

create or replace function public.eu5_upsert_campaign(p_campaign jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.eu5_campaigns (
    campaign_key, playthrough_name, game_version, latest_game_date, latest_game_year,
    latest_captured_at, latest_source_hash, snapshot_count, event_count, player_names, latest_players
  )
  select
    x.campaign_key, x.playthrough_name, x.game_version, x.latest_game_date, x.latest_game_year,
    x.latest_captured_at, x.latest_source_hash, x.snapshot_count, x.event_count,
    coalesce(x.player_names, '{}'::text[]), coalesce(x.latest_players, '[]'::jsonb)
  from jsonb_to_record(p_campaign) as x(
    campaign_key text, playthrough_name text, game_version text, latest_game_date text, latest_game_year integer,
    latest_captured_at timestamptz, latest_source_hash text, snapshot_count integer, event_count integer,
    player_names text[], latest_players jsonb
  )
  where x.campaign_key is not null
  on conflict (campaign_key) do update set
    playthrough_name = excluded.playthrough_name,
    game_version = excluded.game_version,
    latest_game_date = excluded.latest_game_date,
    latest_game_year = excluded.latest_game_year,
    latest_captured_at = excluded.latest_captured_at,
    latest_source_hash = excluded.latest_source_hash,
    snapshot_count = excluded.snapshot_count,
    event_count = excluded.event_count,
    player_names = excluded.player_names,
    latest_players = excluded.latest_players;
end;
$$;

create or replace function public.eu5_upsert_campaign_snapshots(p_snapshots jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.eu5_campaign_snapshots (
    campaign_key, source_hash, line_number, captured_at, source_file, game_date, game_year,
    playthrough_name, game_version, player_country_count, war_count, war_filter, snapshot
  )
  select
    x.campaign_key, x.source_hash, x.line_number, x.captured_at, x.source_file, x.game_date, x.game_year,
    x.playthrough_name, x.game_version, coalesce(x.player_country_count, 0), coalesce(x.war_count, 0),
    x.war_filter, x.snapshot
  from jsonb_to_recordset(p_snapshots) as x(
    campaign_key text, source_hash text, line_number integer, captured_at timestamptz, source_file text,
    game_date text, game_year integer, playthrough_name text, game_version text, player_country_count integer,
    war_count integer, war_filter text, snapshot jsonb
  )
  where x.campaign_key is not null and x.source_hash is not null
  on conflict (campaign_key, source_hash) do update set
    line_number = excluded.line_number,
    captured_at = excluded.captured_at,
    source_file = excluded.source_file,
    game_date = excluded.game_date,
    game_year = excluded.game_year,
    playthrough_name = excluded.playthrough_name,
    game_version = excluded.game_version,
    player_country_count = excluded.player_country_count,
    war_count = excluded.war_count,
    war_filter = excluded.war_filter,
    snapshot = excluded.snapshot;
end;
$$;

create or replace function public.eu5_upsert_campaign_events(p_events jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.eu5_war_events (
    event_id, campaign_key, source_hash, line_number, event_type, war_number, game_date, event
  )
  select
    x.event_id, x.campaign_key, x.source_hash, x.line_number, x.event_type, x.war_number, x.game_date, x.event
  from jsonb_to_recordset(p_events) as x(
    event_id text, campaign_key text, source_hash text, line_number integer, event_type text,
    war_number bigint, game_date text, event jsonb
  )
  where x.event_id is not null and x.campaign_key is not null
  on conflict (event_id) do update set
    campaign_key = excluded.campaign_key,
    source_hash = excluded.source_hash,
    line_number = excluded.line_number,
    event_type = excluded.event_type,
    war_number = excluded.war_number,
    game_date = excluded.game_date,
    event = excluded.event;
end;
$$;

grant execute on function public.eu5_upsert_campaign(jsonb) to anon, authenticated;
grant execute on function public.eu5_upsert_campaign_snapshots(jsonb) to anon, authenticated;
grant execute on function public.eu5_upsert_campaign_events(jsonb) to anon, authenticated;
