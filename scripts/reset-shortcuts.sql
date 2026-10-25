-- 仅在切换到 Typora 默认快捷键的部署中执行一次；保留所有其他设置。
BEGIN IMMEDIATE;
UPDATE settings SET value = json_remove(value, '$.shortcuts') WHERE key = 'app.settings';
COMMIT;
