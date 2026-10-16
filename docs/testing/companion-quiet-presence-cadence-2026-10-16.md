# 「开机招呼之后就一直安静」：一条被双重计数的闸（2026-10-16）

用户口径：「该开口的时候不开口」「开机招呼之后就一直安静」。这一篇记录真窗口测出来的机制、
一处**双重计数**的修法，以及仍然保留的那道分寸闸。内容那一半见
[companion-greeting-content-variety-2026-10-16.md](companion-greeting-content-variety-2026-10-16.md)。

## 真窗口实测（发行渲染包 + 本地栈 + 隔离 profile）

窗口起在 13:18，`app.started` 问候 13:18:46 落库；随后按真实阅读节奏跑一段
（安静 100 秒 → 只滚动 60 秒 → 再安静 200 秒），全程读库：

| 从 13:18:45 起 | 数量 |
| --- | ---: |
| `context.updated` | 多数（15 秒一格的心跳） |
| `page.arrived` | 2（13:21:30、13:21:32） |
| `presence.quiet` | **0** |
| 产出运行 | **1**（只有那句启动问候） |

读数里还有一条要注意的：那 6 分钟里 `document.hasFocus()` 多数时刻为 false（窗口可见但
焦点在跑脚本的终端上），所以这段不能用来判"滚动会不会清零安静"——它只能证明**问候之后
六分钟里没有任何新开口**。其中 `page.arrived` 两次都发生在 `fg=true` 的那几秒里。

## 机制：同一件事被两道闸各算一次

- 问候是**触发式**，但它同样写进 `assistant_deliveries`；档位间隔的读数
  （"上一次她真的开口"）就取这张表最近一条（真库实测同一账号三小时里 29 次 `app.started`）。
- 于是问候之后，**所有 routine 话题**在档位间隔内一律被挡：适中档 = **30 分钟**
  （`PROACTIVE_CADENCE_MS`：安静 90 分／适中 30 分／活跃 10 分）。
- 而「陪着的时候」本来就有两道自己的闸：
  1. 客户端一段安静只开一次门（同一个 `quietEpisodeId` 只考虑一次，用户一动就换新一集）；
  2. 账号档位决定安静多久才算时机（`COMPANION_QUIET_PRESENCE_MIN_MS`：10 分／3 分／90 秒）。
- 再叠 30 分钟，得到的不是"她别太吵"，而是**"开机招呼之后半小时内她一律不开口"**。

## 修法

`initiativeCadenceApplies(topic, selfArranged)`（`companion-initiative-observation.ts`，导出并有单测）：

- `presence.quiet` → **不走**档位间隔（它自带上面两道闸，双重计数没有意义）；
- `attention.due` / `self_note.due`（`selfArranged`）→ 照旧豁免；
- 其余 routine（`page.arrived`、`study.started`）→ 照旧走间隔；
- 触发式（招呼、答后接续、真实结果）→ 本来就不进这条闸。

## 验证

- 单测：`companion-initiative-observation` **18/18**（新增一条钉住豁免边界：`presence.quiet`
  豁免、`page.arrived`/`study.started` 仍走间隔、触发式不进、`selfArranged` 照旧豁免）；
  worker 全量单测 **1890 项**通过；`npm run typecheck` 干净。
- 真栈（`check-quiet-door.mjs`，按客户端同样的形状发观察）：
  - 报一段 200 秒的安静（适中档门槛 180 秒）→ **当场起了一轮**（此前该账号
    `presence.quiet` 运行数为 0）；
  - 反向对照：同一轮里 `page.arrived`（`note-read:*`）**仍然被档位间隔挡住**——本轮只给
    「陪着的时候」开了门，没有顺手放开她自己新起的话题。
  - 注意：两次连着跑要隔 2 分钟以上——跨话题地板（2 分钟）对"刚说过话"照旧生效。

## 仍然保留的边界（没有改）

- **到页面的搭话仍按 30 分钟档位间隔**（适中档）。那是 2026-10-13/14 记录的用户分寸决定：
  "她自己新起的话题要过账号已声明的介入档位间隔"。如果"该开口的时候不开口"主要发生在
  翻笔记的时候，下一轮用同样方法量它再决定，不凭猜放松。
- 窗口必须真的在前台（`foreground` = 可见 + `document.hasFocus()` + 房间认为窗口可见）。
  实测里焦点被终端抢走的那几分钟，客户端如实报 `foreground: false`——这是设计，不是 bug。
