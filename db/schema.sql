create table if not exists daily_runs (
  utc_date date primary key,
  status text not null check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error text
);

create table if not exists articles (
  url text primary key,
  title text not null,
  first_seen_at timestamptz not null default now(),
  last_read_at timestamptz,
  body_hash text
);

create table if not exists posted_comments (
  id bigserial primary key,
  utc_date date not null references daily_runs(utc_date),
  article_url text not null references articles(url),
  body text not null,
  remote_id text,
  created_at timestamptz not null default now(),
  unique (utc_date, article_url)
);

-- The planned text is stored before the public action. On a retry, the agent
-- verifies whether this exact text already appears instead of generating or
-- posting a second comment.
create table if not exists comment_attempts (
  utc_date date not null references daily_runs(utc_date),
  article_url text not null references articles(url),
  body text not null,
  status text not null check (status in ('planned', 'posted')),
  created_at timestamptz not null default now(),
  primary key (utc_date, article_url)
);

-- Exactly one encrypted AWS Builder Center session state. It is encrypted in
-- the Vercel function before it reaches Neon; this table never holds a secret
-- in plaintext.
create table if not exists encrypted_browser_state (
  singleton boolean primary key default true check (singleton),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  updated_at timestamptz not null default now()
);

-- Wishes this account has voted for. The vote control on Builder Center is a
-- toggle that exposes no voted-state, so clicking one already voted REMOVES
-- the vote. The page cannot be asked; this table is the only reliable memory.
create table if not exists wish_votes (
  wish_url text primary key,
  title text not null,
  utc_date text not null,
  iso_week text not null,
  created_at timestamptz not null default now()
);

create index if not exists wish_votes_iso_week on wish_votes (iso_week);
