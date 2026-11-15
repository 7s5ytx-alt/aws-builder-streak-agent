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
