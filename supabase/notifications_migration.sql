-- Notifications & preference-matching feature — run this once in the
-- Supabase SQL Editor. Additive only (uses "if not exists"), safe to run
-- even if part of it somehow already exists.

create table if not exists notifications (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id) on delete cascade,
  type          text not null,             -- 'track_nudge' | 'track_almost_done' | 'shared_file' | 'unread_messages' | ...
  title         text not null,
  body          text not null,
  action_url    text,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);

create index if not exists idx_notifications_user on notifications (user_id, created_at desc);

-- One row per browser/device the user has enabled push notifications on —
-- someone can have several (phone + laptop), each gets notified separately.
create table if not exists push_subscriptions (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_push_subscriptions_user on push_subscriptions (user_id);

-- Logs a search that came back empty, so admins/facilitators can see what
-- people are actually looking for and don't have yet — powers the
-- "consider uploading X" recommendation for managers.
create table if not exists search_misses (
  id            bigint generated always as identity primary key,
  user_id       bigint not null references users(id) on delete cascade,
  query         text not null,
  app           text not null,             -- 'files' | 'notes'
  created_at    timestamptz not null default now()
);

create index if not exists idx_search_misses_query on search_misses (app, lower(query), created_at desc);
