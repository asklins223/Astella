how to run

```
# 1) 独立库（容器 astella-note-editor-test-20261029，端口 51073）：
#    CREATE DATABASE astella_fixes_20261101; 跑完 461 条迁移；用 infra/postgres/roles.sql 授权
# 2) 起一份只连这个库的 API（不要碰 dev 的 4000）：
#    cd apps/api && PORT=4100 DATABASE_URL=… DATABASE_URL_API=… STORAGE_MODE=local \
#      STORAGE_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=… NODE_ENV=development \
#      EMAIL_VERIFICATION_DISABLED=true node --import tsx src/server.ts
# 3) 跑这份脚本（放在 apps/api 下才能解析 yjs / @hocuspocus/provider）：
#    cp …/verify-fixes.mjs apps/api/ && cd apps/api && node verify-fixes.mjs
```

2026-11-01 那次跑出来 16 项全过；输出贴在
[`../../note-editing-concurrency-load-boundary-2026-10-31.md`](../../note-editing-concurrency-load-boundary-2026-10-31.md) 的「修复与复验」一节。
