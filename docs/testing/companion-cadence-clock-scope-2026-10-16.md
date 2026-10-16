# 「该开口的时候不开口」：档位间隔的钟量错了对象（2026-10-16）

第三份记录（声音 / 送达 / 内容 / 时机）里的**时机**这一份。用户口径：「该开口的时候不开口」。

## 全库把她的主动面摊开（同一账号，全量历史）

| 观察 | 条数 | | 产出的运行 | 个数 |
| --- | ---: | --- | --- | ---: |
| `page.arrived` | 48 | | `app.started` | 94 |
| `presence.quiet` | 3 | | `reply.finished` | 20 |
| `result.available` | 1 | | `study.started` | 12 |
| `help.available` | **0** | | `page.arrived` | **1** |
| | | | `presence.quiet` | 1（本轮真栈检查造的） |

也就是说：她的主动几乎只有**每次启动的招呼**与**答完之后的接续**；到了页面（48 次）只换来
1 次运行，`help.available` 这条"真帮忙"的通道**从来没被客户端触发过**（客户端只在
「导入的资料解析失败」与「学习运行出结果」两处发它，见
`source-detail-surface.tsx:141`、`learning-run-surface.tsx:323`）。

## 修：档位间隔的钟只数她自己新起的话题

档位间隔（`PROACTIVE_CADENCE_MS`：安静 90 分／适中 30 分／活跃 10 分）本来要管的是
**"她自己新起的话题多久说一次"**。但它的读数 SQL 数的是"任意一次她开口"
（`companion-initiative.ts` 里那张 `companion_turn_runs` + `EXISTS assistant message`），
于是**触发式**（启动招呼、答后接续、真实结果、页面帮助）也把钟按下去：

- 真窗口实测（第八轮）：一次启动问候之后六分钟，`page.arrived` 报上来 2 次、产出运行 0 个；
- 全库对照：`app.started` 一类产出 94 次运行，而 `page.arrived` 48 条观察只换来 1 次；
- 真栈诊断（本轮）：`all_clock = routine_clock = 13:26:54`，一次启动问候之后页面搭话被挡到
  13:56:54——**它的名额被那句招呼吃掉了**。

改法是让钟与它要管的对象同类：读数排除 `COMPANION_TRIGGERED_TOPICS`
（`app.started` / `app.foreground` / `preference.changed` / `help.available` / `result.available` /
`reply.finished`）。触发式不再占用"她自己新起的话题"的名额；页面搭话仍然每 30 分钟（适中档）
最多一次，跨话题地板（2 分钟）照旧。

**没有放宽的**：到页面的搭话仍走档位间隔（10-13/14 记录的分寸决定），页面上"没有依据就不说话"
仍由提示与工具收口；陪着的时候按第八轮的口径豁免。

## 验证

- 新增守卫 `companion-initiative-cadence-clock-guard.test.ts`：读真代码断言钟的 SQL
  排除触发式、且排除名单与 `COMPANION_TRIGGERED_TOPICS` 同源（不能各写一份）；
  另钉住"谁走档位间隔"的边界（页面搭话走、陪着的时候与触发式不走）。
- `companion-initiative-observation` + 新守卫 **20/20**；`npm run typecheck` 干净；
  worker 全量单测已含这批用例。
- 端到端（`check-page-arrival-door.mjs`：先来一次启动招呼，再翻一篇笔记）：**受当前账号的
  档位窗口限制**——诊断显示上一条"她自己新起的话题"在 13:26:54，窗口到 13:56:54 才过，
  所以第一次跑（等到 200 秒）如预期没有起来；已排一次等到窗口过去之后的复跑，
  结果记在提交说明里。这个"等不到"本身也是证据：钟读的就是那张表，改的是它数谁。
