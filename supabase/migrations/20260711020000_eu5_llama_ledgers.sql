create table if not exists public.eu5_campaigns (
  campaign_key text primary key,
  playthrough_name text,
  game_version text,
  latest_game_date text,
  latest_game_year integer,
  latest_captured_at timestamptz,
  latest_source_hash text,
  snapshot_count integer not null default 0,
  event_count integer not null default 0,
  player_names text[] not null default '{}',
  latest_players jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.eu5_campaign_snapshots (
  campaign_key text not null references public.eu5_campaigns(campaign_key) on delete cascade,
  source_hash text not null,
  line_number integer not null,
  captured_at timestamptz,
  source_file text,
  game_date text,
  game_year integer,
  playthrough_name text,
  game_version text,
  player_country_count integer not null default 0,
  war_count integer not null default 0,
  war_filter text,
  snapshot jsonb not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (campaign_key, source_hash)
);

create table if not exists public.eu5_war_events (
  event_id text primary key,
  campaign_key text not null references public.eu5_campaigns(campaign_key) on delete cascade,
  source_hash text,
  line_number integer not null,
  event_type text,
  war_number bigint,
  game_date text,
  event jsonb not null,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists eu5_campaigns_latest_captured_at_idx
  on public.eu5_campaigns(latest_captured_at desc);

create index if not exists eu5_campaign_snapshots_campaign_captured_idx
  on public.eu5_campaign_snapshots(campaign_key, captured_at);

create index if not exists eu5_campaign_snapshots_snapshot_gin_idx
  on public.eu5_campaign_snapshots using gin (snapshot jsonb_path_ops);

create index if not exists eu5_war_events_campaign_line_idx
  on public.eu5_war_events(campaign_key, line_number);

create index if not exists eu5_war_events_campaign_war_idx
  on public.eu5_war_events(campaign_key, war_number);

create or replace function public.eu5_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists eu5_campaigns_set_updated_at on public.eu5_campaigns;
create trigger eu5_campaigns_set_updated_at
  before update on public.eu5_campaigns
  for each row execute function public.eu5_set_updated_at();

drop trigger if exists eu5_campaign_snapshots_set_updated_at on public.eu5_campaign_snapshots;
create trigger eu5_campaign_snapshots_set_updated_at
  before update on public.eu5_campaign_snapshots
  for each row execute function public.eu5_set_updated_at();

drop trigger if exists eu5_war_events_set_updated_at on public.eu5_war_events;
create trigger eu5_war_events_set_updated_at
  before update on public.eu5_war_events
  for each row execute function public.eu5_set_updated_at();

create or replace view public.eu5_latest_campaigns
with (security_invoker = true) as
select
  campaign_key,
  playthrough_name,
  game_version,
  latest_game_date,
  latest_game_year,
  latest_captured_at,
  snapshot_count,
  event_count,
  player_names,
  latest_players,
  updated_at
from public.eu5_campaigns;

create or replace function public.eu5_get_campaign_ledger(p_campaign_key text)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'campaign', to_jsonb(c),
    'snapshots', coalesce(
      (
        select jsonb_agg(s.snapshot order by s.captured_at, s.line_number)
        from public.eu5_campaign_snapshots s
        where s.campaign_key = c.campaign_key
      ),
      '[]'::jsonb
    ),
    'events', coalesce(
      (
        select jsonb_agg(e.event order by e.line_number, e.event_id)
        from public.eu5_war_events e
        where e.campaign_key = c.campaign_key
      ),
      '[]'::jsonb
    )
  )
  from public.eu5_campaigns c
  where c.campaign_key = p_campaign_key;
$$;

alter table public.eu5_campaigns enable row level security;
alter table public.eu5_campaign_snapshots enable row level security;
alter table public.eu5_war_events enable row level security;

drop policy if exists "Public read EU5 campaigns" on public.eu5_campaigns;
create policy "Public read EU5 campaigns"
  on public.eu5_campaigns for select
  using (true);

drop policy if exists "Public read EU5 campaign snapshots" on public.eu5_campaign_snapshots;
create policy "Public read EU5 campaign snapshots"
  on public.eu5_campaign_snapshots for select
  using (true);

drop policy if exists "Public read EU5 war events" on public.eu5_war_events;
create policy "Public read EU5 war events"
  on public.eu5_war_events for select
  using (true);

grant select on public.eu5_campaigns to anon, authenticated;
grant select on public.eu5_campaign_snapshots to anon, authenticated;
grant select on public.eu5_war_events to anon, authenticated;
grant select on public.eu5_latest_campaigns to anon, authenticated;
grant execute on function public.eu5_get_campaign_ledger(text) to anon, authenticated;

grant select, insert, update, delete on public.eu5_campaigns to service_role;
grant select, insert, update, delete on public.eu5_campaign_snapshots to service_role;
grant select, insert, update, delete on public.eu5_war_events to service_role;
grant execute on function public.eu5_get_campaign_ledger(text) to service_role;
