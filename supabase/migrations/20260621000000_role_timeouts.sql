-- PostgREST connects as `authenticator` to introspect the schema cache on
-- every startup. The default 8s statement_timeout is too short when the DB
-- is recovering from a restart (WAL replay can delay query execution).
-- 60s gives enough headroom for schema cache loading while still protecting
-- against runaway user queries (anon/authenticated keep their own timeouts).
ALTER ROLE authenticator SET statement_timeout = '60s';
ALTER ROLE authenticator SET lock_timeout    = '30s';
