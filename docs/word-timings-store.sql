create table if not exists public.word_timings (
  id text primary key,
  track_key text not null,
  duration double precision not null check (duration > 0),
  value jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.word_timings enable row level security;
revoke all on public.word_timings from anon, authenticated;
create index if not exists word_timings_lookup on public.word_timings (track_key, duration);
