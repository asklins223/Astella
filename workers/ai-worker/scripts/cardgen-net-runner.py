#!/usr/bin/env python3
"""在一次性库上跑制卡族集测（workers/ai-worker 那一批），DSN 用真角色、密码不外泄。

为什么住在这里而不是仓库根的 `scripts/`：`integration-run-registration` 那条守卫把
`scripts/` 整个目录当成"会真执行集测的注册面"，一份个人跑批脚本抄进那份目录，
就等于替 6 份集测谎报"已经有人跑它了"。这条路径不在它扫的目录里。

为什么要有这台：那批文件自己取 `DATABASE_URL_MIGRATOR`（夹具写入，超户）、
`DATABASE_URL_API` / `DATABASE_URL_WORKER`（被测读写，NOBYPASSRLS 角色），
而 dev `.env` 里四条 URL 的用户全是 `astella`（bypass RLS）——直接拿 `.env` 跑，
隔离类断言会读到不该读到的行。这里按 `.env` 的 `MIGRATOR_PASSWORD` /
`API_PASSWORD` / `WORKER_PASSWORD` 现拼，只打印角色与库名。

付费闸门见下面 `CARD_GENERATION_V3_PROVIDER` 那一段：这批网必须走确定性替身。

用法：
    workers/ai-worker/scripts/cardgen-net-runner.py [库名] [测试文件…]      # 不带文件＝整批制卡族
"""

import os
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = Path(__file__).resolve().parents[1]
TEST_DIR = "src/integration-tests"

# 制卡族（新链端到端）：这一批共用同一套夹具形状，要一起跑才算"整网"。
# 名单里**永远不许出现会打真模型的文件**。历史事故：旧链那份
# `card-generation-v2-llm-natural-activation` 在文件头自己写
# `process.env.CARD_GENERATION_V2_LLM = "true"`，摘环境变量拦不住它，2026-09-27 被抄进
# 名单后整网挂在那一发上轮询到 600s——那期间它已经在打真 provider。那份文件已随四阶段链
# 删除（2026-09-27 刀二），这条规矩留着：**加任何"要真 provider 配置"的文件之前，先读它
# 自己设了什么 env。**
FAMILY = [
    "card-generation-v2-c-cases.integration.ts",
    "card-generation-v2-e2e-subset.integration.ts",
    "card-generation-v2-redaction-quota.integration.ts",
    "card-generation-v3-simplified-postgres.integration.ts",
]


def dotenv() -> dict:
    values = {}
    for line in (ROOT / ".env").read_text().splitlines():
        match = re.match(r"^([A-Z_0-9]+)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"')
    return values


def main() -> int:
    args = sys.argv[1:]
    database = "astella_w73b"
    if args and args[0].startswith("astella_"):
        database, args = args[0], args[1:]
    values = dotenv()
    host = "127.0.0.1:5432"
    admin = f"postgres://astella:{quote(values['POSTGRES_PASSWORD'], safe='')}@{host}/{database}"
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": admin,
        "DATABASE_URL_MIGRATOR": admin,
        "DATABASE_URL_API": f"postgres://astella_api:{quote(values['API_PASSWORD'], safe='')}@{host}/{database}",
        "DATABASE_URL_WORKER": f"postgres://astella_worker:{quote(values['WORKER_PASSWORD'], safe='')}@{host}/{database}",
    })
    # 计费闸门：今天制卡唯一的真模型开关是 `CARD_GENERATION_V3_PROVIDER`（默认确定性替身，
    # 设成别的值就会去打真 provider、按次付费）。批次名单里出现付费调用是不可接受的，
    # 所以这里**拒绝执行**而不是摘掉它——摘掉会让"这一次到底有没有走模型"读不出来。
    if os.environ.get("CARD_GENERATION_V3_PROVIDER"):
        print("CARD_GENERATION_V3_PROVIDER 已经设上（这一批会打真模型、按次付费）。"
              "要跑真模型请单独一次、显式点头；跑这批网请先 unset 它。", file=sys.stderr)
        return 2
    # 以 "--" 开头的参数原样透传给 node --test（用来单跑一条：--test-name-pattern）。
    passthrough = [a for a in args if a.startswith("--")]
    args = [a for a in args if not a.startswith("--")]
    files = args or FAMILY
    # 11 份文件并发跑会把这一个一次性库的连接打满（表现为 37 条连接级红，不是产品回归）。
    print(f"库 {database}｜_MIGRATOR→astella(超户) _API→astella_api _WORKER→astella_worker｜"
          f"CARD_GENERATION_V3_PROVIDER 未设（确定性替身）｜{len(files)} 份文件", flush=True)
    return subprocess.run(
        ["node", "--import", "tsx", "--test", "--test-concurrency=1",
         *passthrough, *(f"{TEST_DIR}/{f}" for f in files)],
        cwd=PACKAGE, env=env,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
