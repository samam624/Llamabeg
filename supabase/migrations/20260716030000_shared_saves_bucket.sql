-- Public, read-only Storage bucket for shared parsed-save blobs (gzip-
-- compressed JSON, ~5-6MB each - see js/share-store.js). Objects are keyed
-- "<playthrough_uuid>_<game_date>.json.gz"; the random campaign UUID makes a
-- share link unguessable (the bucket is public-read but its object listing
-- is NOT exposed, so nobody can browse other people's saves - only someone
-- you hand a link to can fetch that one object).
--
-- 20 MB per-object cap and a gzip-only mime allowlist are the guardrails on
-- the intentionally-open write policy below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shared-saves', 'shared-saves', true, 20971520, array['application/gzip'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Anyone (the anon browser key) may READ any object in this bucket - that's
-- what makes a shared link work for a recipient who never signed in.
drop policy if exists "shared_saves_public_read" on storage.objects;
create policy "shared_saves_public_read"
  on storage.objects for select
  using (bucket_id = 'shared-saves');

-- Anyone may WRITE/overwrite. The app only ever writes deterministic
-- "<uuid>_<date>" keys, so re-sharing a save overwrites its own object
-- rather than creating duplicates. This is deliberately open for a
-- friends-group tool - the unguessable-UUID keyspace, the 20MB size cap, and
-- the gzip-only mime allowlist are the guardrails, not authentication. If
-- this ever needs locking down, replace these two policies with an
-- authenticated-only or signed-upload (edge function) path.
drop policy if exists "shared_saves_anon_insert" on storage.objects;
create policy "shared_saves_anon_insert"
  on storage.objects for insert
  with check (bucket_id = 'shared-saves');

drop policy if exists "shared_saves_anon_update" on storage.objects;
create policy "shared_saves_anon_update"
  on storage.objects for update
  using (bucket_id = 'shared-saves')
  with check (bucket_id = 'shared-saves');
