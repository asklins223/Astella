# 阶段一门槛跑批台（2026-09-27 起）

> **这份文档回答一个问题：跑批红了，是谁的锅、下一步该做什么。**
> 它**不判定**任何 §16 案例是否通过。案例与 W 项的归属、以及"绿了也不等于该案例已达"
> 的理由，仍以 [39d 实施台账](./39d-implementation-task-breakdown-2026-09-24.md) 为准。
>
> `scripts/verify-stage-one.sh` 的文件头引用了这份文档；此前它不存在，
> 于是每个跑批的人都要重新把"组 → 集成档 → §16 案例 → W 项"这条链推一遍。

## 0. 为什么不判定通过

39d 台账反复纠正过同一个错误：**把"测试绿"写成"验收通过"**。跑批只回答
"这一组集成用例是绿是红"，不回答"§16.26 达成了没有"。两者的差距在
[§15 案例→波次对照表](./39d-implementation-task-breakdown-2026-09-24.md#15--16-案例--波次对照表)
里写得很清楚：同一个 §16 案例常常要跨两三个 W 项，而每个 W 项的完成判据
又常常要求"真窗口截图／录屏"这类集成档给不出的证据。

反过来也成立：**红的用例不等于该案例没做完**。判据可能钉的是已经删掉的旧链路。

## 1. 组 → 集成档 → §16 案例

`scripts/verify-stage-one.sh` 的七组与它们的覆盖面（脚本 `--list` 可直接读出）：

| 组 | 覆盖的 §16 案例 | 归属 W 项 | 跑的 npm script |
| --- | --- | --- | --- |
| `objectives` | 16.21、16.26 | W5-1、W5-2 | api `test:objective-governance:postgres` |
| `rounds` | 16.1、16.2、16.3、16.4、16.9、16.10、16.14、16.17、16.23 | W4-2/3/5/6/8 | api `test:learning-rounds:postgres`（12 份） |
| `disputes` | 16.11、16.22、16.24、16.25 | W5-5、W5-4 | api `test:assessment-disputes:postgres` |
| `runs` | 16.19、16.21 | W4-8 | api `test:learning-runs:postgres` |
| `cards` | 16.35 | W7-1/2/7 | worker `test:card-generation-v3:postgres` |
| `perimeter` | 16.13、16.20 | W5-6 | api `test:route-contract:postgres` |
| `companion` | 16.29、16.30、16.32、16.39 | W2-3、W6-2 | api + worker `test:companion-integration:postgres` |

**这张表是"覆盖"，不是"已覆盖"。** 左栏有组不代表该案例已有证据——`disputes`
组里有 `test:dispute-read-side:postgres` 这样的独立档，它是否被 `disputes` 组
的 script 带上，要看 `apps/api/package.json` 里那一条当前写了哪些文件。
台账 W6-3 行末维护着更细的逐条现状（哪条已达、哪条部分、哪条未达）。

## 2. 环境：共用一个一次性库

并行会话最大的浪费是各起各的库。实测 `pg_database` 里曾同时躺着三十多个
`ailearn_*` 一次性库，每个都导了两百多条迁移，而它们的内容完全一样。

**默认共用 `ailearn_stage1_gate`**（脚本里的 `STAGE_ONE_DB`）：

```bash
bash scripts/dev-disposable-db.sh ailearn_stage1_gate   # 建/重建，约 5 秒
bash scripts/verify-stage-one.sh all                    # 全部组，复用已就绪的库
bash scripts/verify-stage-one.sh --fresh all            # 重建再跑
```

脚本自己会补 PATH、设好九个 `*_DATABASE_URL`、并在组之间复用同一个库
（重建要导两百多条迁移，而同一轮验收通常要跑好几组）。

### 两条会让人误判的口径

1. **`DATABASE_URL` 不是多余的。** 多数用例经 `packages/shared` 的
   `integration-test-db-env` 读它；只设 `DATABASE_URL_API/MIGRATOR/WORKER`
   三个会让几十个用例以「集成测试缺少 DATABASE_URL」集体失败，
   **看上去像代码坏了，其实是环境没配**。
2. **`--fresh` 会重建库，跑之前先确认没人在用。** 三个会话共用一个库正是为了
   避免互相踩；用 `--fresh` 之前先 `ps` 一下有没有别人的集成档正在跑。

## 3. 红的分三类，只有第一类是真缺口

台账里 C31／C16 那几行记的就是第三类。所以看到红，**先归因再动手**：

| 类别 | 判别方法 | 该做什么 |
| --- | --- | --- |
| **A. 实现缺失** | 用例描述的是 §16 案例要求的行为，而生产代码里那条路根本没实现 | 记进对应 W 项，退回实现 |
| **B. 用例钉了旧链路** | 断言里出现的是已经删除的旧产物名／旧 jobType／旧状态（制卡四阶段链是重灾区） | 把这格迁到默认档，**判据改成正向断言**，不是删掉 |
| **C. 环境／夹具** | 报 `集成测试缺少 DATABASE_URL`、角色 `permission denied`、同篇笔记在制守卫 | 修环境或夹具，**不要改产品代码** |

B 类的处置有个已定的规矩（见 W7-2 那格）：原来"屏上没有这颗按钮"的守卫用例，
在按钮真正落地那一刻**换成正向断言，不是删掉**。删掉守卫＝把回归网一起删了。

## 4. 新增用例后的登记（39d §3 第 10 条）

写完一份集成测试，**同一批**要做完三件事，否则它等于没写：

1. `apps/api/package.json`（或 `workers/ai-worker/package.json`）加 npm script；
2. `.github/workflows/ci.yml` 加上对应 step（`v1.0` 不在 push 分支，
   **只有本地验证算数**，CI 只是防回归的第二道网）；
3. 挂进本文件第 1 节的某一组，或明确记下它不属于任何组。

漏第 1 步 ⇒ 跑批看不见它，§16.22 读侧那个缺口就是这样"修好了却没人知道"的。
漏第 2 步 ⇒ CI 不防回归。

## 5. 两次实测（2026-09-27）

### 5.1 会让整组永久挂住的地雷（已定位，源码待修）

**现象**：`bash scripts/verify-stage-one.sh all` 跑到 `rounds` 组后**永不返回**。
`pg_stat_activity` 里两个连接全是 `idle` / `ClientRead`（不是 `idle in transaction`），
没有任何锁等待——**不是数据库慢，是 node 进程不退出**。

**归因**（类别 A，落在别人在途的那一刀上）：
`apps/api/src/integration-tests/note-learning-round-artifact-postgres.integration.ts`
的 `wipeRounds()` 先 `set_config('app.allow_history_mutation','on')` 再
`DELETE FROM note_learning_round_teachings`，而
`note_learning_round_artifact_failures.teaching_id` 是
`REFERENCES note_learning_round_teachings(id) ON DELETE CASCADE`
（迁移 0298:43）——级联删到失败行，触发 `nlraf_append_only` 抛
`artifact failure is append-only`。

**真因是 0298 的守卫漏了绕行口子**：0282/0283/0284/0285 四张只追加表的守卫
都有 `IF current_setting('app.allow_history_mutation', true) = 'on' THEN RETURN COALESCE(NEW, OLD)`，
0298 那份（`:88-93`）只有一句 `RAISE EXCEPTION`，没有这段。

**它为什么表现成"挂住"而不是"红"**：抛错的 `wipeRounds` 在 `beforeEach`/`after` 里，
node 把它记成 `hookFailed`（所以第 8、9 格报的是 hook 失败而不是真因），
而失败后 `seeded.cleanup()` 的连接没被 `end()` 掉，事件循环永远不空。
**一个 3 行的守卫形状差异，让 12 份文件的整组读数永远拿不到。**

**已验证的修法**（在一次性库上验过，**源码没动**）：

```sql
CREATE OR REPLACE FUNCTION public.guard_note_learning_round_artifact_failure() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_history_mutation', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'artifact failure is append-only';
END; $$ LANGUAGE plpgsql;
```

改前：2 格失败 + 进程永不退出；改后：**8/8 通过，进程正常退出**。

**归属**：这属于 39d W4-6／§16.4「产物失败留痕」那一刀在途的文件
（`0298_*.sql` 与 `artifact-failure.ts` 都是未跟踪新文件）。
本文件不替那一刀改源码，只登记地雷与修法。

### 5.2 全组跑批读数（2026-09-27 20:30，地雷排除之后）

**这张表是"某一时刻的读数"，不是状态声明**；重跑以当次输出为准。

| 组 | 通过 | 失败 | 备注 |
| --- | --- | --- | --- |
| `objectives` | 7 | 0 | |
| `rounds` | 116 | 5 | 见 §5.2.1 |
| `disputes` | 5 | 11 | 见 §5.2.2 |
| `runs` | 27 | 0 | |
| `cards`（worker） | 21 | 0 | |
| `perimeter` ×2 | 12 | 0 | |
| `companion`（api） | 114 | 0 | |
| `companion`（worker） | 68 | 0 | |
| **合计** | **370** | **16** | |

**这 16 条没有一条是产品逻辑缺陷。** 全部是夹具/环境层的问题，
两处根因，各自都有已验证的一行修法。这一条值得单独强调：
**阶段一门槛当前的红不是"功能没做完"，是"测试从来没在真库上跑过"。**
台账里那几处"集成测试与 ci.yml 点名列未登记……等真库能跑再补"，
说的就是这件事——补登记的人以为登记完就有证据了，实际上登记后第一次跑才暴露夹具。

#### 5.2.1 `rounds` 5 条（两处根因）

| 症状 | 条数 | 位置 | 修法 |
| --- | --- | --- | --- |
| `column "source_block_ordinals" is of type integer[] but expression is of type text[]` | 4 | `note-learning-round-access-revoked-postgres.integration.ts:102` 的 `${tx.array([0])}` | postgres.js 按元素类型推断数组，`[0]` 推成 `text[]`；写成 `${tx.array([0])}::int[]` |
| `The input did not match /^note_teaching_explain_v1@v1/` | 1 | 同组"生成那一发"那格 | 教学讲解 provider 的 `modelId` 串变了；要么改夹具里的期望串，要么把 `modelId` 收回带版本前缀的形状 |

四条的 `hookFailed` 全落在同一个 `before` 上，所以**改一行四条一起绿**。

#### 5.2.2 `disputes` 11 条（一个根因）

11 条全是同一条 `before` 抛的：

```
new row for relation "learning_objective_origins_v2"
  violates check constraint "loo_v2_kind_fields_chk"
```

位置：`assessment-disputes-postgres.integration.ts:128-130`——夹具写
`origin_kind='note'` 却**没有 `note_version_id`**，而
`loo_v2_kind_fields_chk` 的 `note` 那一支要求 `note_version_id IS NOT NULL`
（另外两支 `manual` / `imported` 反过来要求它是 NULL）。
对照：`helpers/v2-card-fixture.ts:528` 走的是同一个 CHECK，**它补了** `note_version_id`。

已在一次性库上验过两个方向：不补 → 被 CHECK 拒；补上 → 通过。
夹具还缺一行 `note_versions`（该文件目前只插了 `notes`），
形状照 `helpers/v2-card-fixture.ts:268-271`：`version_no` / `content_json` /
`content_hash` / `created_by` 四列都要给。

### 5.3 跑批前发现并修掉的一个真缺口（不是红的，是**根本没跑**的）

`0301_learning_assessment_cancelled.sql` 存在于 `apps/api/src/db/migrations/`，
但**没有登记进 `meta/_journal.json`**。本仓库的迁移器
（`apps/api/src/db/migrate.ts`）读的是 journal 的 entries，
逐条比 sha256 决定要不要跑——**journal 里没有的文件就永远不会执行**，
而且不会报任何错，只会打印一句 "Migrations complete."

后果：`learning_assessments.status` 的 CHECK 里没有 `cancelled`，
`learning_assessments_cancelled_terminal` 触发器不存在。
于是 W5-1「停止本次评估」这条命令（§5.5、§16.36）在**所有**库里
——CI、开发库、每个一次性库——都缺数据面。任何人去验 §16.36 都会撞上一堆
看起来毫不相关的报错，而真因在三个目录之外。

发现方式：跑 `verify-stage-one.sh` 之前先核了一遍
「SQL 文件 vs journal entries」，发现 `unregistered sql files: ['0301_…']`。
**这个检查值得每次新增迁移后都做一遍**，它比任何测试都更早发现这类缺口。

修法是补一条 journal entry（`when` 取比当前最大值更大的值，
以防将来换回 drizzle 自带迁移器时踩到 `created_at` 那个陷阱）。
补完顺手把开发库也补齐了——开发库当时缺 0299／0300／0301 三条，
而台账早就记过"新迁移在真窗口里不存在是第一件要在实机前核的事"。

### 5.4 一条会被误读成"12 个产品 bug"的读数（已由脚本修好，登记在此）

同一份 `rounds`，把 `DATABASE_URL_API` 指成**超户**跑是 105/17，指成
**受限角色**跑是 117/5。差的 12 条全部是 RLS 档自己带着**正控制**当场拒绝：

> 扫描跑在 `ailearn` 上且 `rolbypassrls=true`：换成旁路 RLS 的角色之后，
> 这一份文件里所有归属断言都不再是证据

这正是 39d 反复夸的那种写法——**判据自己拒绝在无效环境下算数**。
`scripts/verify-stage-one.sh` 现在（2026-09-27 20:21 那一版）已经把
`DATABASE_URL_API`／`DATABASE_URL_WORKER` 指向受限角色，所以读数正常。
这里记一笔是因为：**"17 条红"这个数本身是对的，但它的归因不是"功能没做完"**，
而"归属断言在超户下不算证据"。

## 6. 怎么用这份文档

- 跑批红了 → 先看 §5 的两张归因表（多半直接命中），再看 §3 判类别。
- 新写的集成档跑不起来 → 先量它**有没有真的连到库**
  （`pg_stat_activity` 里有没有自己的连接、角色是不是 `rolbypassrls`），
  再读它的报错。§5.2 那 16 条里没有一条是业务逻辑问题。
- 进程不退出 → 直接跳 §5.1，那是已定位的地雷。
