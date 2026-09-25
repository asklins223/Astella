/**
 * 集成测试的数据库连接串：**变量缺了就喊**，绝不静默落到开发库（39d §19 那条待办）。
 *
 * 病是这么来的（2026-09-25 实测）：一批集成测试把「变量没设」这件事咽了下去——写成
 * `process.env.DATABASE_URL ?? "postgres://ailearn:ailearn_dev@localhost:5432/ailearn"`，
 * 于是**在本机跑测试时，夹具悄悄写进了开发者真实的 dev 库**（那一轮多出 12 个 fixture
 * 用户／10 个 workspace，还是事后数出来的）。CI 里看不出来：那条链上变量总是设好的。
 *
 * 正确形状两种，这个函数给的是第二种：
 *  1. 需要哪一段就用哪个变量（夹具写用 `DATABASE_URL`／`DATABASE_URL_MIGRATOR` 的超户串，
 *     被测读写用 `DATABASE_URL_API`／`DATABASE_URL_WORKER` 的受限角色串）；
 *  2. 变量缺失 → **当场抛**，并告诉人怎么起一个一次性库（`scripts/dev-disposable-db.sh`）。
 *
 * 配套的棘轮在 `apps/api/src/__tests__/integration-db-url-ratchet.test.ts`：存量位点冻结
 * 在名单里只许调低，新增一处就红。清扫完这一批，这份模块仍然留着——它是"以后也不会再长
 * 回来"的那一半。
 */
export function testDatabaseUrl(variable: string): string {
  const value = process.env[variable]?.trim();
  if (value) return value;

  throw new Error(
    `集成测试缺少 ${variable}：这里以前会静默用一个写死的开发库串`
      + `（postgres://…@localhost:5432/ailearn），于是夹具可能写进真实的 dev 库。`
      + `起一个一次性库再跑：bash scripts/dev-disposable-db.sh <名字>（它会打印四个变量）；`
      + `或者显式把 ${variable} 指到你要用的库。`,
  );
}

/**
 * 写死的开发库串长什么样——棘轮与这个模块共用同一份判据，免得两处各写一遍正则。
 * 只匹配"主机是本机、库名是 ailearn"这一类串，不匹配文档里的示例（调用方只扫代码行）。
 */
export const HARDCODED_DEV_DATABASE_URL_PATTERN =
  /"postgres:\/\/[^"]*@(?:localhost|127\.0\.0\.1):\d+\/ailearn"/;
