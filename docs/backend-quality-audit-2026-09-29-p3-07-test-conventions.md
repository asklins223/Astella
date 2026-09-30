# P3-7：把三种测试约定收到一种

> 2026-09-29。本文档记录"统一了什么、还剩什么没统一、以及为什么剩下那部分
> 不在 P3-7 里做"。

## 统一了的：node 三个包的 test 调用

`packages/shared` / `apps/api` / `workers/ai-worker` 现在是**同一条命令**：

```
node --import tsx --test --test-concurrency=1 $(find src -name '*.test.ts' | sort)
```

此前是两种：worker 带 `--test-concurrency=1`，另两个不带。

### 为什么 worker 当初需要串行

worker 里有测试共享**模块级状态**（限流器的固定窗口、连接池替身之类）。
并行跑时它们会互相看见对方的状态，于是同一份代码在 CI 上偶发红。

### 为什么不一致本身就是问题

另两个包"不带"不代表它们没有这种依赖——只说明**还没被并行跑到**。
`apps/api` 的 82 个平铺测试与 119 个 `__tests__` 测试里同样有共享状态：
本轮实测就撞到过 `companion-rate-limit.test.ts` 在满载全量跑里偶发红一次，
单跑三次全绿（它用 `Date.now()` 的固定窗口）。

统一到串行，那一类"只在满载时出现"的偶发就没有了。代价是墙钟时间变长，
换来的是**同一条命令在三个包里给出同一个答案**。

## 没统一的：测试文件的**位置**

`__tests__/` 子目录 vs 与源码平铺，三个包各占一半左右：

| 包 | `__tests__/` 内 | 平铺 |
| --- | --- | --- |
| `packages/shared` | 3 | 78 |
| `apps/api` | 119 | 82 |
| `workers/ai-worker` | 25 | 37 |

这一条**属于 B1（测试分离）**，不在 P3-7 里做：它要移动 197 个文件，
每一次移动都可能踩到某个"按相对路径找夹具"的测试。

## 仍然存在的第四种：桌面端

`apps/desktop-client` 用 `vitest run`，不是 `node --test`。
它本来就是另一套（React 组件 + jsdom 渲染），统一到 node runner 不现实。
所以准确地说，仓库里有 **两种 runner**（node / vitest）、**一种 node 调用**。

## 怎么验

```bash
cd packages/shared && npm test     # 与 apps/api / workers/ai-worker 逐字相同
```

守卫：`apps/api/src/__tests__/ci-test-file-references.test.ts`（P1-21 建的那条）
锁住"CI 脚本与本地脚本必须一致"，改动 test 调用时它会先红。
