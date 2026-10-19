-- Run with psql -X --no-password --quiet --tuples-only --no-align
-- --set=ON_ERROR_STOP=1 --single-transaction --file=scripts/export-legacy.sql.
-- Connection settings come from PGSERVICE/.pgpass or PG* environment variables.
-- Only this transaction's snapshot is exported; no source rows are modified.
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL TIME ZONE 'UTC';

SELECT json_build_object(
  'format_version', 1,
  'exported_at', to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'users', COALESCE((
    SELECT json_agg(row_to_json(exported_user) ORDER BY exported_user.id)
    FROM (SELECT id FROM users) AS exported_user
  ), '[]'::json),
  'lists', COALESCE((
    SELECT json_agg(row_to_json(exported_list) ORDER BY exported_list.id)
    FROM (
      SELECT id, name, slug, "user",
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM lists
    ) AS exported_list
  ), '[]'::json),
  'gifts', COALESCE((
    SELECT json_agg(row_to_json(exported_gift) ORDER BY exported_gift.id)
    FROM (
      SELECT id, list_id, name, url, image, price::text AS price, position,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
        to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
      FROM gifts
    ) AS exported_gift
  ), '[]'::json)
);
