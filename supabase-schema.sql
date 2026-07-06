-- BLINDSPOT schema. Run in Supabase SQL editor.
-- Functions use the service role key, so RLS stays enabled with no public policies.

create table if not exists watches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  -- config shape: { queries[], typoBrands[], typoHunt, categoryIds[], conditionIds[],
  --   auctionOnly, maxPrice, endingWithinHours, fixable, minScore,
  --   threshold: { minMarginPct, minNetUsd }, comps: { [query]: { median, n } }, econ: {} }
  created_at timestamptz not null default now()
);

create table if not exists seen_items (
  item_id text primary key,
  watch_id uuid references watches(id) on delete cascade,
  score int,
  title text,
  seen_at timestamptz not null default now()
);

create table if not exists comps_cache (
  keywords text primary key,
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

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

alter table watches enable row level security;
alter table seen_items enable row level security;
alter table comps_cache enable row level security;
alter table deals enable row level security;
