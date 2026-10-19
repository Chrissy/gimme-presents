-- Compare these counts with the converter's summary before exposing the Worker.
SELECT
  (SELECT COUNT(*) FROM owners) AS owners,
  (SELECT COUNT(*) FROM lists) AS lists,
  (SELECT COUNT(*) FROM gifts) AS gifts,
  (SELECT COUNT(*) FROM sessions) AS sessions,
  (SELECT COUNT(*) FROM lists LEFT JOIN owners ON owners.id = lists.owner_id WHERE owners.id IS NULL) AS lists_without_owner,
  (SELECT COUNT(*) FROM gifts LEFT JOIN lists ON lists.id = gifts.list_id WHERE lists.id IS NULL) AS gifts_without_list;

-- Must return no violations. These statements do not expose list contents.
PRAGMA foreign_key_check;
