-- One-time deployment cleanup: stop the old service and retain matching database/image rollback backups first.
-- Never run at application startup; original notes and images are outside this script's cleanup scope.
BEGIN IMMEDIATE;
DROP TABLE IF EXISTS share_items;
DROP TABLE IF EXISTS shares;
DELETE FROM settings WHERE key = 'share.secret';
UPDATE settings
SET value = json_remove(value, '$.shortcuts."note.share"', '$.shortcuts."app.shares"')
WHERE key = 'app.settings'
  AND (json_type(value, '$.shortcuts."note.share"') IS NOT NULL
    OR json_type(value, '$.shortcuts."app.shares"') IS NOT NULL);
COMMIT;
