-- Run once only when migrating to Typora default shortcuts; retain all other settings.
BEGIN IMMEDIATE;
UPDATE settings SET value = json_remove(value, '$.shortcuts') WHERE key = 'app.settings';
COMMIT;
