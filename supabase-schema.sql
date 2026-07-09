-- BLINDSPOT schema — v2, multi-tenant. Run in the Supabase SQL editor.
-- Idempotent: safe on a fresh project AND on a v1 database (it upgrades in place).
-- Functions use the service role key, so RLS stays enabled; the only client-visible
-- policies are owner-scoped reads, added for defense in depth.
--
-- Rollout order on an existing deployment: deploy the new function code first,
-- then run this file. (The v1 watcher upserts seen_items on item_id alone; this
-- file changes that to per-watch dedupe, which the v1 code doesn't know about.)

-- ── Tenants ─────────────────────────────────────────────────────────
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  plan text not null default 'scout', -- scout | picker | operator (source of truth, synced by stripe-webhook)
  is_admin boolean not null default false,
  econ jsonb not null default '{}'::jsonb, -- { feeRate, perOrderFee } — per-seller, was FEE_RATE/PER_ORDER_FEE env
  discord_webhook_url text,              -- per-user alerts, was DISCORD_WEBHOOK_URL env
  typo_exclude text[] not null default '{}',
  stripe_customer_id text,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id text primary key, -- Stripe subscription id
  user_id uuid not null references profiles(id) on delete cascade,
  plan text not null,
  status text not null,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists subscriptions_user on subscriptions(user_id);

-- Auto-create a profile the moment auth.users gets a row. me.mjs also
-- lazy-creates on first request, so a missed trigger can't orphan a login.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── Watches (now user-owned, cadence-aware) ─────────────────────────
create table if not exists watches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  -- config shape: { queries[], typoBrands[], typoHunt, typoExclude[], categoryIds[], conditionIds[],
  --   auctionOnly, maxPrice, endingWithinHours, fixable, expectModelNumbers, minScore,
  --   threshold: { minMarginPct, minNetUsd }, comps: { [query]: { median, n } }, econ: {} }
  created_at timestamptz not null default now()
);
alter table watches add column if not exists user_id uuid references profiles(id) on delete cascade;
alter table watches add column if not exists cadence_minutes int not null default 60;
alter table watches add column if not exists last_run_at timestamptz;
alter table watches add column if not exists last_hit_at timestamptz;
create index if not exists watches_user on watches(user_id);

-- ── Seen items: dedupe is per-watch now, not global ─────────────────
-- (Two users watching the same query each get their own first alert.)
create table if not exists seen_items (
  item_id text,
  watch_id uuid references watches(id) on delete cascade,
  score int,
  title text,
  seen_at timestamptz not null default now()
);
alter table seen_items drop constraint if exists seen_items_pkey;
create unique index if not exists seen_items_watch_item on seen_items(watch_id, item_id);
create index if not exists seen_items_seen_at on seen_items(seen_at);

-- ── Comps cache: stays GLOBAL on purpose ────────────────────────────
-- Comps are facts about the market, not about a user. Sharing the cache is the
-- multi-tenant win: one RapidAPI pull serves everyone hunting that query for 7 days.
create table if not exists comps_cache (
  keywords text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

-- ── Scan cache: same idea for Browse results, short TTL ─────────────
-- Identical query+filters within the TTL costs zero API calls, whoever asks.
-- Pickers cluster on the same presets, so tenants make each other cheaper.
create table if not exists scan_cache (
  cache_key text primary key, -- sha1 of the full query+filter signature
  q text not null,
  payload jsonb not null,     -- raw itemSummaries (scoring is per-user, done at read time)
  fetched_at timestamptz not null default now()
);
create index if not exists scan_cache_fetched on scan_cache(fetched_at);

-- ── The 5,000/day ledger — server truth, atomic ─────────────────────
-- Pools keep the watcher from starving interactive scans and vice versa.
create table if not exists api_budget (
  day date not null,
  pool text not null, -- 'interactive' | 'watch'
  used int not null default 0,
  primary key (day, pool)
);

-- Reserve up to p_want calls from a pool, capped at p_cap for the day.
-- Returns how many were actually granted (0..p_want). Row lock = no over-issue
-- under concurrent scans.
create or replace function public.reserve_api_budget(p_pool text, p_want int, p_cap int)
returns int language plpgsql security definer set search_path = public as $$
declare v_used int; v_grant int;
begin
  insert into api_budget (day, pool, used) values (current_date, p_pool, 0)
  on conflict (day, pool) do nothing;
  select used into v_used from api_budget
    where day = current_date and pool = p_pool for update;
  v_grant := greatest(0, least(p_want, p_cap - v_used));
  if v_grant > 0 then
    update api_budget set used = used + v_grant
      where day = current_date and pool = p_pool;
  end if;
  return v_grant;
end $$;

-- Per-user daily usage (plan limits are enforced against this).
create table if not exists user_usage (
  user_id uuid not null references profiles(id) on delete cascade,
  day date not null,
  scans int not null default 0,
  api_calls int not null default 0,
  comp_pulls int not null default 0,
  primary key (user_id, day)
);

create or replace function public.record_usage(p_user uuid, p_scans int, p_calls int, p_comps int)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into user_usage (user_id, day, scans, api_calls, comp_pulls)
  values (p_user, current_date, p_scans, p_calls, p_comps)
  on conflict (user_id, day) do update set
    scans = user_usage.scans + excluded.scans,
    api_calls = user_usage.api_calls + excluded.api_calls,
    comp_pulls = user_usage.comp_pulls + excluded.comp_pulls;
end $$;

-- ── Community typo guard ────────────────────────────────────────────
-- When isLikelyRealTerm flags a "typo" as a real word (the Nikor case), record
-- it here. Every tenant's scans consult this list, so one user's confirmed
-- collision saves everyone else the API call AND the false positive.
create table if not exists typo_collisions (
  term text primary key,
  brand text,             -- the brand whose variant generator produced it
  seller_count int not null default 0,
  first_seen timestamptz not null default now()
);

-- ── Deals: user-owned pipeline with outcomes ────────────────────────
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  item_id text not null,
  title text,
  url text,
  buy_price numeric,
  comp_median numeric,
  est_net numeric,
  status text default 'watching', -- watching | bid | won | lost | listed | sold
  notes text,
  created_at timestamptz not null default now()
);
alter table deals add column if not exists user_id uuid references profiles(id) on delete cascade;
alter table deals add column if not exists sold_price numeric; -- what it actually resold for
alter table deals add column if not exists ship_cost numeric;  -- what shipping actually cost
alter table deals add column if not exists updated_at timestamptz not null default now();
-- v1 had a global unique item_id (two possible auto-names); uniqueness is per-user now.
alter table deals drop constraint if exists deals_item_id_unique;
alter table deals drop constraint if exists deals_item_id_key;
create unique index if not exists deals_user_item on deals(user_id, item_id);
create index if not exists deals_user_status on deals(user_id, status);

-- ── RLS ─────────────────────────────────────────────────────────────
-- Functions run with the service role (bypasses RLS). Owner-scoped policies
-- exist so the anon/user keys can never read across tenants even if a direct
-- client path is added later. Ledger/cache tables get no public policies at all.
alter table profiles enable row level security;
alter table subscriptions enable row level security;
alter table watches enable row level security;
alter table seen_items enable row level security;
alter table comps_cache enable row level security;
alter table scan_cache enable row level security;
alter table api_budget enable row level security;
alter table user_usage enable row level security;
alter table typo_collisions enable row level security;
alter table deals enable row level security;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select using (auth.uid() = id);
drop policy if exists "own subscriptions" on subscriptions;
create policy "own subscriptions" on subscriptions for select using (auth.uid() = user_id);
drop policy if exists "own watches" on watches;
create policy "own watches" on watches for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own deals" on deals;
create policy "own deals" on deals for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "own usage" on user_usage;
create policy "own usage" on user_usage for select using (auth.uid() = user_id);
