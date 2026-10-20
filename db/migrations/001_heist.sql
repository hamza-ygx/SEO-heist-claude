begin;

create schema if not exists heist;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'heist_app') then
    create role heist_app login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'heist_approver') then
    create role heist_approver login noinherit;
  end if;
end $$;

revoke all on schema heist from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema heist from anon, authenticated'; end if;
end $$;
grant usage on schema heist to heist_app, heist_approver;
grant usage on schema public to heist_app;

create table if not exists heist.sites (
  domain text primary key check (domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  role text not null check (role in ('ours', 'competitor')),
  scope_prefix text check (scope_prefix is null or scope_prefix ~ '^/.*/$'),
  active boolean not null default true,
  added_at timestamptz not null default now()
);

create table if not exists heist.sitemap_urls (
  domain text not null references heist.sites(domain) on delete cascade,
  url text not null,
  lastmod text,
  topic text not null,
  kept boolean not null,
  drop_reason text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (domain, url)
);
create index if not exists sitemap_urls_domain_seen on heist.sitemap_urls (domain, last_seen desc);

create table if not exists heist.recon_runs (
  id bigint generated always as identity primary key,
  domain text not null references heist.sites(domain) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  sitemaps int,
  urls int,
  kept int,
  new_urls int,
  spend_usd numeric,
  warnings text[] not null default '{}',
  error text
);

create table if not exists heist.topics (
  id bigint generated always as identity primary key,
  domain text not null references heist.sites(domain) on delete cascade,
  url text not null,
  topic text not null,
  top_keyword text,
  volume int,
  kd numeric,
  traffic numeric,
  our_position int,
  our_url text,
  fetched_at timestamptz not null default now(),
  status text not null default 'new' check (status in ('new', 'kept', 'dropped')),
  drop_reason text,
  unique (domain, url)
);
create index if not exists topics_status on heist.topics (status);

create table if not exists heist.clusters (
  id bigint generated always as identity primary key,
  primary_keyword text not null unique,
  intent text,
  topic_ids bigint[] not null default '{}',
  est_traffic numeric,
  kd numeric,
  fit smallint check (fit between 0 and 5),
  gain smallint check (gain between 0 and 5),
  score numeric,
  ymyl boolean not null default false,
  rationale text,
  status text not null default 'candidate' check (status in ('candidate', 'picked', 'skipped')),
  created_at timestamptz not null default now()
);

create table if not exists heist.reviewers (
  name text primary key check (length(name) between 2 and 120),
  qualified_ymyl boolean not null default false,
  active boolean not null default true
);

create table if not exists heist.articles (
  slug text primary key check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 75),
  cluster_id bigint references heist.clusters(id),
  status text not null default 'draft' check (status in ('draft', 'qa_passed', 'in_review', 'approved', 'rejected', 'scheduled', 'published')),
  brief_skip boolean not null default false,
  content_hash text,
  approved_hash text,
  qa jsonb,
  wp_post_id bigint,
  approved_by text references heist.reviewers(name),
  approved_at timestamptz,
  rejected_reason text,
  scheduled_for timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists articles_status on heist.articles (status);

create table if not exists heist.publish_log (
  id bigint generated always as identity primary key,
  slug text not null references heist.articles(slug),
  action text not null,
  actor text not null,
  wp_post_id bigint,
  result text not null,
  at timestamptz not null default now()
);

create table if not exists heist.settings (
  id boolean primary key default true check (id),
  weekly_cap int not null default 3 check (weekly_cap between 1 and 30),
  cap_review_after date not null default (current_date + 56),
  min_volume int not null default 50 check (min_volume >= 0),
  timezone text not null default 'Europe/Stockholm'
);
insert into heist.settings (id) values (true) on conflict do nothing;

create or replace function heist.articles_guard() returns trigger language plpgsql as $$
declare
  is_ymyl boolean;
  qualified boolean;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.approved_by is not null or new.approved_at is not null or new.approved_hash is not null then
      raise exception 'new articles must start as an unapproved draft';
    end if;
  else
    if new.status <> old.status and (old.status, new.status) not in (
        ('draft', 'qa_passed'), ('qa_passed', 'draft'), ('qa_passed', 'in_review'), ('in_review', 'draft'),
        ('in_review', 'approved'), ('in_review', 'rejected'), ('rejected', 'draft'),
        ('approved', 'scheduled'), ('scheduled', 'approved'), ('scheduled', 'published'),
        ('approved', 'draft'), ('scheduled', 'draft')) then
      raise exception 'illegal status transition % -> %', old.status, new.status;
    end if;
    if old.approved_by is not null
       and (new.approved_by is distinct from old.approved_by or new.approved_at is distinct from old.approved_at or new.approved_hash is distinct from old.approved_hash)
       and not (new.status = 'draft' and new.approved_by is null and new.approved_at is null and new.approved_hash is null) then
      raise exception 'approval fields are immutable; revoke the approval (back to draft) instead';
    end if;
    if old.status in ('approved', 'scheduled', 'published') and new.status <> 'draft' and new.content_hash is distinct from old.content_hash then
      raise exception 'content of % changed after approval; it must go back to draft and be re-approved', new.slug;
    end if;
  end if;

  if new.status in ('approved', 'scheduled', 'published') then
    if new.approved_by is null or new.approved_at is null or new.approved_hash is null then
      raise exception 'status % requires approved_by, approved_at and approved_hash', new.status;
    end if;
    if new.content_hash is distinct from new.approved_hash then
      raise exception 'content of % differs from the approved version', new.slug;
    end if;
    select r.qualified_ymyl into qualified from heist.reviewers r where r.name = new.approved_by and r.active;
    if not found then
      raise exception 'approved_by % is not an active reviewer', new.approved_by;
    end if;
    select c.ymyl into is_ymyl from heist.clusters c where c.id = new.cluster_id;
    if coalesce(is_ymyl, false) and not qualified then
      raise exception 'YMYL article % needs a reviewer with qualified_ymyl', new.slug;
    end if;
  elsif new.approved_by is not null or new.approved_at is not null or new.approved_hash is not null then
    raise exception 'approval fields may only be set while approved, scheduled or published';
  end if;

  if new.status = 'published' and new.published_at is null then
    new.published_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;

create or replace function heist.approve(p_slug text, p_reviewer text) returns heist.articles
language plpgsql security definer set search_path = heist, pg_temp as $$
declare a heist.articles;
begin
  update heist.articles set status = 'approved', approved_by = p_reviewer, approved_at = now(), approved_hash = content_hash
    where slug = p_slug and status = 'in_review' and content_hash is not null
    returning * into a;
  if not found then
    raise exception 'article % is not in_review with a content hash', p_slug;
  end if;
  insert into heist.publish_log (slug, action, actor, result) values (p_slug, 'approve', p_reviewer, 'ok');
  return a;
end $$;

create or replace function heist.revoke_approval(p_slug text, p_reason text) returns heist.articles
language plpgsql security definer set search_path = heist, pg_temp as $$
declare a heist.articles;
begin
  update heist.articles set status = 'draft', approved_by = null, approved_at = null, approved_hash = null, scheduled_for = null, rejected_reason = p_reason
    where slug = p_slug and status in ('approved', 'scheduled')
    returning * into a;
  if not found then
    raise exception 'article % is not approved or scheduled', p_slug;
  end if;
  insert into heist.publish_log (slug, action, actor, result) values (p_slug, 'revoke_approval', session_user, coalesce(p_reason, ''));
  return a;
end $$;

revoke all on function heist.approve(text, text) from public;
revoke all on function heist.revoke_approval(text, text) from public;
grant execute on function heist.approve(text, text) to heist_approver;
grant execute on function heist.revoke_approval(text, text) to heist_app, heist_approver;
grant select on heist.articles, heist.reviewers, heist.clusters to heist_approver;

drop trigger if exists articles_guard on heist.articles;
create trigger articles_guard before insert or update on heist.articles for each row execute function heist.articles_guard();

grant select, insert, update, delete on heist.sites, heist.sitemap_urls, heist.recon_runs, heist.topics, heist.clusters to heist_app;
grant select on heist.reviewers, heist.settings to heist_app;
grant select, insert on heist.publish_log to heist_app;
grant select, insert on heist.articles to heist_app;
grant update (cluster_id, status, brief_skip, content_hash, qa, wp_post_id, rejected_reason, scheduled_for, published_at) on heist.articles to heist_app;
grant usage on all sequences in schema heist to heist_app;

grant select on public.dfs_keywords, public.gsc_query_daily, public.projects, public.api_spend to heist_app;
grant insert, update on public.dfs_keywords to heist_app;
grant insert, update (cost) on public.api_spend to heist_app;

drop policy if exists heist_read on public.dfs_keywords;
create policy heist_read on public.dfs_keywords for select to heist_app using (true);
drop policy if exists heist_write on public.dfs_keywords;
create policy heist_write on public.dfs_keywords for insert to heist_app with check (true);
drop policy if exists heist_update on public.dfs_keywords;
create policy heist_update on public.dfs_keywords for update to heist_app using (true) with check (true);

drop policy if exists heist_read on public.gsc_query_daily;
create policy heist_read on public.gsc_query_daily for select to heist_app using (true);
drop policy if exists heist_read on public.projects;
create policy heist_read on public.projects for select to heist_app using (true);

drop policy if exists heist_read on public.api_spend;
create policy heist_read on public.api_spend for select to heist_app using (provider = 'dataforseo');
drop policy if exists heist_insert on public.api_spend;
create policy heist_insert on public.api_spend for insert to heist_app with check (provider = 'dataforseo' and by = 'heist');
drop policy if exists heist_update on public.api_spend;
create policy heist_update on public.api_spend for update to heist_app using (by = 'heist') with check (by = 'heist');

insert into heist.sites (domain, role, scope_prefix) values
  ('rkjh.se', 'ours', null),
  ('cedra.se', 'competitor', null),
  ('bakertillyhalmstad.se', 'competitor', null),
  ('azets.com', 'competitor', '/sv-se/'),
  ('metricaccounting.se', 'competitor', null)
on conflict (domain) do nothing;

commit;
