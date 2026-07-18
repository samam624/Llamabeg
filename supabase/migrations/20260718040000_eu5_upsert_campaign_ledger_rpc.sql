-- Lets the browser push a campaign's ledger (campaign + snapshots + events,
-- pre-shaped client-side to match the eu5_campaigns/eu5_campaign_snapshots/
-- eu5_war_events row shapes - see js/app.js's shapeCampaignLedgerForUpload,
-- which mirrors scripts/import-llama-ledgers-to-supabase.js's loadCampaign())
-- WITHOUT granting anon/authenticated raw table INSERT - anon only ever gets
-- EXECUTE on this one SECURITY DEFINER function, which does the actual
-- writes as its owner. Whoever clicks "Share link" no longer needs to run
-- the CLI import script by hand for the recipient to see live war data.
--
-- Same anonymous-write trust model this project already accepts for the
-- "shared-saves" storage bucket (20260716030000_shared_saves_bucket.sql) -
-- no per-user accounts exist anywhere in this app, so anyone with the anon
-- key can upsert any campaign_key. Acceptable for a small-group fan tool;
-- revisit if this ever needs real multi-tenant isolation.
create or replace function public.eu5_upsert_campaign_ledger(
  p_campaign jsonb,
  p_snapshots jsonb,
  p_events jsonb
)
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

grant execute on function public.eu5_upsert_campaign_ledger(jsonb, jsonb, jsonb) to anon, authenticated;
