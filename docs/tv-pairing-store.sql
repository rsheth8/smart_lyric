-- Supabase setup for the Apple TV Spotify pairing handshake.
--
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Then set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the deployment.
--
-- This table holds a Spotify refresh token for the ~30 seconds between the
-- phone finishing OAuth and the Apple TV's next poll, so it is locked down
-- accordingly: RLS on, no policies, service-role access only.

create table if not exists public.tv_pairings (
  key         text primary key,
  value       jsonb       not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Row Level Security with NO policies means the anon and authenticated roles
-- can read nothing at all. The service-role key bypasses RLS, and it is the
-- only key the server uses. Never expose it to a browser.
alter table public.tv_pairings enable row level security;

revoke all on public.tv_pairings from anon, authenticated;

-- Sweeping is a belt-and-braces measure: `pair-store.mjs` already treats an
-- expired row as absent on read, so a stale row is never honoured even if
-- nothing has cleaned it up yet. This just stops the table growing.
create index if not exists tv_pairings_expires_at_idx
  on public.tv_pairings (expires_at);

-- Optional: schedule with pg_cron (Database → Extensions → enable pg_cron).
--   select cron.schedule(
--     'sweep-tv-pairings', '*/15 * * * *',
--     $$delete from public.tv_pairings where expires_at < now()$$
--   );
