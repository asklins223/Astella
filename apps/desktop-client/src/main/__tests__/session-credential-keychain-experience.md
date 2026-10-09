# macOS 启动钥匙串弹窗：一天内的两次处理（2026-10-08 → 2026-10-09）

## 10-08 那一版为什么没按住

现场旧记录 `astella-desktop-client Safe Storage` 的受信应用是开发依赖里的
`Electron.app`，分区绑定开发版的 CDHash。安装版 `/Applications/Astella.app`
共用同一个 package name，但签名不同。用户每次拒绝，下一次启动又会访问该记录。
启动日志在 IPC 注册之前停留约 20 秒，调用入口是凭据存储构造时的
`safeStorage.isEncryptionAvailable()`，当时尚未创建主窗口。

当时的修法：安装版在 `ready` 前设置独立的 `Astella` 应用名并保留原 userData 路径；
安装版改用 `session-credential-packaged-v2.bin`，不读取无法通过新钥匙串身份解密的旧
凭据；再补一层签名身份守卫（`session-credential-identity.ts` 调 `codesign --display`
取 `developer-id:…` 或 `adhoc:…:CDHash`），身份对不上就不去碰钥匙串，避免每次启动白弹
一次。验证记录：109 项凭据/身份/网关回归通过，隔离目录里真实主进程保存→退出→重启
→恢复成功，更新安装版后启动无弹窗。

## 10-09 复现与判定

用户仍然报告「退出应用后要重新登录」，并且明确拒掉过钥匙串弹窗。本机核对：

- `~/Library/Application Support/astella-desktop-client/` 下既没有
  `session-credential-v1.bin`，也没有 `session-credential-packaged-v2.bin`，
  身份旁车也不存在 → 凭据从未落盘。
- 钥匙串里有 `Electron Safe Storage`、`ailearn-desktop-client Safe Storage`、
  `Astella Safe Storage`，唯独没有当前 dev 名对应的 `astella-desktop-client Safe Storage`。
  旧的三个都有对应的 bin 文件，反证机制本身能工作，坏在授权这一步。
- `/Applications/Astella.app` 实测 `Signature=adhoc`、`TeamIdentifier=not set`。
  ad-hoc 的 CDHash 每次重新构建都会变，而 `load()` 在身份不相等时直接返回 null →
  **装了自动更新的版本，每次更新必然重登一次**，与拒不拒弹窗无关。
- 拒一次之后的破坏性：`decryptString` 抛错 → 删掉凭据文件并写 `access:"denied"`；
  该旁车之后每次启动都短路返回 null，只有重新登录成功写入才会翻回 `allowed`。
  同一条链上 `persistCredential` 里「保存失败就 `clear()`」也会把已有凭据一起带走。

对照实测（证明"允许授权时确实能记住"）：把当时刚写入的 `session-credential-v1.bin`
复制进一个隔离 userData，重新启动一个独立实例，`auth.getState` 直接返回
`status: authenticated` / `credentialPersistence: safe_storage`，全程没有授权交互。
所以问题不是"存不住"，是"要用户签字"。

## 裁决与改动

用户裁决：登录态必须无感，不接受任何需要输入密码或点允许的弹窗。于是把钥匙串这一条
整段撤掉，凭据改存 userData 下 `session-credential-local-v1.txt`（0600，原子写）：

- 删除 `session-credential-identity.ts` 与身份旁车；dev 与安装版共用同一个文件名
  （两者本来就共用 userData，也已经被单实例锁当成一个应用）。
- 读取失败或内容可疑都不删凭据，交给服务端那道 401 去作废（`discardStoredCredential`）。
  一次偶发的读取问题不该让人重登。
- 写入失败仍然 `clear()`：没写成当前凭据，就不让上一次留下的凭据冒名顶替。
- `credentialPersistence` 契约值 `safe_storage` → `local_file`，登录页文案与
  PRODUCT.md、docs/guide 中英分册同步。

代价说清楚：token 从此在本机是明文。接受它的理由是这台机器上同一目录里的笔记正文
（`note-doc-cache.json`）、语音音频与导出文件本来就是 0600 明文，能读到这个文件的
攻击者同样能读到那些；单独把一把 token 关进钥匙串没有改变实际威胁模型，却把系统授权
交互引入了每次启动。真正能两全的是 Developer ID 签名 + 公证，那需要账号与构建流水线
改动，本机没有证书，本轮没有做。
