-- The combined eu5_get_campaign_ledger(campaign_key) RPC jsonb_agg's every
-- snapshot and event for a campaign in one call - the same shape of bug
-- already hit and fixed on the WRITE side (see
-- 20260718050000_eu5_upsert_campaign_ledger_chunked_rpc.sql's comment):
-- snapshot rows embed a large jsonb blob each, and a real campaign that has
-- grown to 103 snapshots + 179 events now blows the anon/authenticated
-- role's statement timeout on this single read (confirmed directly:
-- 57014 canceling statement due to statement timeout calling this exact RPC
-- for campaign_key 3baa76aa-825a-4655-ae49-02edd3b90a4b, which is why
-- "Share link" recipients stopped seeing that campaign's Llama Score data).
-- Split into three narrow, page-able RPCs so the browser can fetch a large
-- campaign's ledger the same conservative way js/share-store.js's
-- uploadCampaignLedger already writes it - see fetchCampaignLedger.
drop function if exists public.eu5_get_campaign_ledger(text);

create or replace function public.eu5_get_campaign(p_campaign_key text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select to_jsonb(c)
  from public.eu5_campaigns c
  where c.campaign_key = p_campaign_key;
$$;

create or replace function public.eu5_get_campaign_snapshots_page(p_campaign_key text, p_offset integer, p_limit integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(x.snapshot), '[]'::jsonb)
  from (
    select s.snapshot
    from public.eu5_campaign_snapshots s
    where s.campaign_key = p_campaign_key
    order by s.captured_at, s.line_number
    offset p_offset
    limit p_limit
  ) x;
$$;

create or replace function public.eu5_get_campaign_events_page(p_campaign_key text, p_offset integer, p_limit integer)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(x.event), '[]'::jsonb)
  from (
    select e.event
    from public.eu5_war_events e
    where e.campaign_key = p_campaign_key
    order by e.line_number, e.event_id
    offset p_offset
    limit p_limit
  ) x;
$$;

grant execute on function public.eu5_get_campaign(text) to anon, authenticated, service_role;
grant execute on function public.eu5_get_campaign_snapshots_page(text, integer, integer) to anon, authenticated, service_role;
grant execute on function public.eu5_get_campaign_events_page(text, integer, integer) to anon, authenticated, service_role;
