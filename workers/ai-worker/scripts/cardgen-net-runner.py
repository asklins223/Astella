#!/usr/bin/env python3
"""在一次性库上跑制卡族集测（workers/ai-worker 那一批），DSN 用真角色、密码不外泄。

为什么住在这里而不是仓库根的 `scripts/`：`integration-run-registration` 那条守卫把
`scripts/` 整个目录当成"会真执行集测的注册面"，一份个人跑批脚本抄进那份目录，
就等于替 6 份集测谎报"已经有人跑它了"。这条路径不在它扫的目录里。

为什么要有这台：那批文件自己取 `DATABASE_URL_MIGRATOR`（夹具写入，超户）、
`DATABASE_URL_API` / `DATABASE_URL_WORKER`（被测读写，NOBYPASSRLS 角色），
而 dev `.env` 里四条 URL 的用户全是 `ailearn`（bypass RLS）——直接拿 `.env` 跑，
隔离类断言会读到不该读到的行。这里按 `.env` 的 `MIGRATOR_PASSWORD` /
`API_PASSWORD` / `WORKER_PASSWORD` 现拼，只打印角色与库名。

`CARD_GENERATION_V2_LLM` 一律摘掉：置上就会去打真模型（按次付费），测试必须走确定性替身。

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

# 制卡族（含 v3 新链）：这一批共用同一套夹具形状，要一起跑才算"整网"。
# **`card-generation-v2-llm-natural-activation` 不在名单里，而且不许顺手加**：那份文件
# 第 86 行自己写 `process.env.CARD_GENERATION_V2_LLM = "true"`，摘环境变量拦不住它——
# 它按名字跑就是真模型、按次付费。2026-09-27 把它抄进批次名单，结果整网挂在那一发上
# 轮询到 600s 被我杀掉，那期间那一发已经在打真 provider。
FAMILY = [
    "card-generation-v2-c-cases.integration.ts",
    "card-generation-v2-e2e-subset.integration.ts",
    "card-generation-v2-live-progress-postgres.integration.ts",
    "card-generation-v2-redaction-quota.integration.ts",
    "card-generation-v3-simplified-postgres.integration.ts",
]
PAID = "card-generation-v2-llm-natural-activation.integration.ts"


def dotenv() -> dict:
    values = {}
    for line in (ROOT / ".env").read_text().splitlines():
        match = re.match(r"^([A-Z_0-9]+)=(.*)$", line)
        if match:
            values[match.group(1)] = match.group(2).strip().strip('"')
    return values


def main() -> int:
    args = sys.argv[1:]
    database = "ailearn_w73b"
    if args and args[0].startswith("ailearn_"):
        database, args = args[0], args[1:]
    values = dotenv()
    host = "127.0.0.1:5432"
    admin = f"postgres://ailearn:{quote(values['POSTGRES_PASSWORD'], safe='')}@{host}/{database}"
    env = dict(os.environ)
    env.update({
        "DATABASE_URL": admin,
        "DATABASE_URL_MIGRATOR": admin,
        "DATABASE_URL_API": f"postgres://ailearn_api:{quote(values['API_PASSWORD'], safe='')}@{host}/{database}",
        "DATABASE_URL_WORKER": f"postgres://ailearn_worker:{quote(values['WORKER_PASSWORD'], safe='')}@{host}/{database}",
    })
    env.pop("CARD_GENERATION_V2_LLM", None)
    env.pop("CARD_GENERATION_CHAIN", None)
    files = args or FAMILY
    if PAID in files and os.environ.get("APPROVE_LLM_SPEND") != "1":
        print(f"{PAID} 会打真模型（按次付费）。要跑它请单独一次、并带 APPROVE_LLM_SPEND=1。",
              file=sys.stderr)
        return 2
    # 11 份文件并发跑会把这一个一次性库的连接打满（表现为 37 条连接级红，不是产品回归）。
    print(f"库 {database}｜_MIGRATOR→ailearn(超户) _API→ailearn_api _WORKER→ailearn_worker｜"
          f"CARD_GENERATION_V2_LLM 已摘｜{len(files)} 份文件", flush=True)
    return subprocess.run(
        ["node", "--import", "tsx", "--test", "--test-concurrency=1",
         *(f"{TEST_DIR}/{f}" for f in files)],
        cwd=PACKAGE, env=env,
    ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
