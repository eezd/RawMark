-- 一次性部署清理：先停止旧服务，并保留数据库与镜像配套的回滚备份。
-- 不由应用启动流程执行；原始笔记和图片不在此脚本的清理范围内。
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
