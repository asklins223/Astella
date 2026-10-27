# 对象存储直传、版本缓存与限速备用存储（2026-10-27）

本次服务端发布 2.0.4。只包含图片／文件直传、缓存版本与对话增量读取、可选备用存储；原工作区中未提交的伴星、记忆及其他数据库重构没有打包。

## 实际调用链

- `GET /storage/transfers/config` 给出允许的对象存储 HTTPS origin。
- `POST /storage/transfers` 签发指定用途、大小、哈希与账号／空间的 PUT。iOS 原始字节直接发送到对象存储，不携带 App token；`POST .../complete` 校验并登记不可变回执。
- 新用途 `companion_file` 使用既有文件类型与 20 MiB 限制。PDF、DOCX、TXT、Markdown 的正文由手机本地解析；消息携带抽取文字及原件引用。
- 私有下载仍先鉴权，再返回短期对象存储 GET。客户端按稳定的鉴权地址缓存原字节，不把临时签名 URL 当缓存身份。云端访问失败时可请求备用下载授权。
- `/client-cache/notes/version` 与 `/v2/notes/:id/cache-version` 只返回版本时钟，不读取正文、脑图 JSON 或题目。当前笔记版本与更新时间、派生内容时间、当前用户学习记录共同决定对应材料是否变化。权限检查在任何 304 之前完成。
- 对话消息新增 `afterSeq`，按正序分页读取新尾部，原有 `beforeSeq` 历史分页保留。

## 备份与故障处理

默认仍为云端主存储。启用后 API 使用小型持久化队列，单消费者，每 5 秒至多处理一个对象，默认 256 KiB/s、单次突发不超过 64 KiB。写入成功不等待备份完成；旧对象分批扫描，失败指数退避。副本流式复制并核对长度、来源 ETag 与可用的 SHA-256；删除留墓碑，旧复制不能覆盖新的删除意图。

云端健康探测有超时与短缓存，故障时切到服务器 MinIO；云恢复后将本地新写入排队同步回去。MinIO 使用独立凭据、私有桶、持久卷，控制台不公开；对象数据面经同证书 HTTPS `:9443` 直接服务。默认内存上限 512 MiB、0.5 CPU。

备用 Compose 文件位于 `infra/deploy/docker-compose.storage-backup.yml`，属于现有部署包允许的公开配置目录。这样当前主机已安装的安全解包器能接收新版本，无须扩大部署 key 权限。

## 主机启用步骤

The one-time host setup below has been completed using the administrator access explicitly authorized in this session. Subsequent releases use the existing restricted CI deployment key and the checked-in Compose overlay.

For a new production host, run after deploying a version containing these files:

```sh
sudo bash /opt/astella/current/infra/deploy/enable-storage-backup.sh
```

The script installs the fixed deployment entry point and enables the production overlay without printing credentials. Run the release deployment again to initialize host-generated independent credentials, the private bucket and the persistent queue. HTTPS 9443 must be reachable by clients. This setup does not apply to local development or Alpha.

## 验证

- shared / API / worker / desktop 类型检查通过；隔离发布目录再次执行 shared / API / worker 类型检查通过。
- 存储领域 11 项测试通过：文件限制、回执字节核验、备份持久化与重启、单消费者、复制与删除竞态、退避、限速与中断、ETag 及权限错误。
- 两个一次性、仅绑定回环地址的真实 MinIO 集测通过（13.3 秒）：复制哈希一致、关闭主端后读备用、本地写入、主端恢复同步、双端删除。测试容器均移除，未操作已有开发服务。
- 正常与备用 Compose 插值检查通过；部署包测试 2 项与 shellcheck 通过。检查只使用合成占位配置，无真实密钥输出。
- iOS 缓存、直传凭据隔离和相片坐标测试记录在手机仓库对应文档；本文件不以模拟器结果代替生产故障演练。

首次 2.0.1 提交漏入两份 shared 传输合同；在 CI 部署前补齐，以 2.0.2 重新执行现有流程，不移动已公开 tag。2.0.2 CI 发现集测缺少脚本注册、新增路由计数未同步，以及基础设施反向引用业务模块。已注册 `test:object-storage:replicas`，保留两个新增端点的账号／空间事务边界，并将备用传输与其私有队列合并到 `lib/storage/replicas.ts`。shared 全量 532 项通过；API 全量除上述归属守卫外 2001 项通过、1 项既有跳过，修复后相关 23 项全部通过。最终 2.0.3 的 CI、版本回读与备用启用结果在实际完成后补记。

## 生产启用与镜像修正

2.0.3 CI 全绿并部署成功，线上版本回读确认 2.0.3。缓存集合时钟返回 70 字节，条件请求返回 304；单篇版本时钟返回 467 字节及六类内容时钟。用户随后授权主机管理员登录，已执行启用脚本，固定部署脚本更新成功；口令只用于当前 SSH 会话，未写入文件。

第二次部署在停止 API 前被旧 `minio/minio`、`minio/mc` 镜像拉取失败拦住，线上原服务保持健康。Docker Hub 与 Quay 的旧公开镜像均无法拉取，因此 2.0.4 改为 CI 从上游 `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` 源码构建，源压缩包另有固定 SHA-256。镜像经当前项目 GHCR 发布并以 digest 部署；初始化用现有 API 镜像的 S3 SDK，去掉 mc 镜像依赖。MinIO 的 AGPLv3 许可证随镜像保留。

初始化器在一次性本地 MinIO 上执行两次均成功，匿名读取桶返回 403。无真实账号／对象参与该测试。

## Production verification and environment boundary

- Server release `s-v2.0.4`, commit `709d4869`, passed [CI and deployment](https://github.com/asklins223/Astella/actions/runs/40486220190). `/app/server-version` returns 2.0.4 and `/ready` returns 200.
- The cloud primary and server-local standby are both running. The authenticated transfer configuration lists `https://cn-nb1.rains3.com` and `https://103.106.191.159:9443`. The standby health endpoint returns 200 and an anonymous private-object request returns 403; its console is not published.
- Two synthetic 68-byte objects, an image and a Markdown file, were sent through each location using grant → direct PUT → completion → repeated completion → authorized GET. All four uploads completed with 201 and matching bytes/hashes. No conversation was sent and no AI job was invoked. The four disposable objects, their transfer receipts and image registrations have been removed; all eight primary/standby HEAD checks confirm their absence.
- The persistent replica queue completed the initial backfill of 135 objects with no pending jobs at readback. It remains a single consumer, at most one object per five seconds and 262,144 bytes/second by default.
- Local `docker-compose.dev.yml` and the Alpha overlay use exactly one local MinIO, with `STORAGE_MODE=local` and `STORAGE_BACKUP_ENABLED=false` fixed for both API and worker. Inherited production environment variables cannot activate a cloud dependency or replica queue there. Only the production deployment adds `infra/deploy/docker-compose.storage-backup.yml`.
- Local MinIO and `mc` images now build from pinned, checksum-verified upstream source instead of unavailable public image tags. The Alpha backup runner reuses the pinned client build and continues to use the same local store.
- Three resolved Compose configuration tests cover development, Alpha and production, and run from both `make verify` and CI. The source-built client initialized a disposable local store twice, round-tripped bytes and preserved anonymous 403 responses. The source-built backup runner also starts successfully; the existing 53 backup-script assertions and two deployment-bundle tests pass. Existing development containers were left running throughout verification.


The retention scope and schedule above were superseded by the accepted 30-day chat / nightly durable-media policy; see [chat upload retention](chat-upload-retention-2026-10-27.md) for the deployed behavior and later upload-verification optimization.
