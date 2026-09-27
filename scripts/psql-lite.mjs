/**
 * 极小的 `psql` 替身，只覆盖 `scripts/dev-disposable-db.sh` 真正用到的那几个形状。
 *
 * 为什么需要它：那个脚本原本只走 `docker compose ps -q postgres` + `docker exec psql`。
 * docker CLI 不在 PATH 的机器上（**daemon 在跑**、127.0.0.1:5432 可达）它会直接拒绝，
 * 于是真库集测只能落**共享 dev 库**——而那一族判据的前提是「库里只有自己的夹具」，
 * 不满足时制卡那几份会报**假失败**（`worker must process outbox jobs (got 0)`、
 * `生成并发已达上限`），症状完全不像环境问题。一次性库纪律是那批判据的地基。
 *
 * 装一个 `psql` 是最省事的选择，但要求每台机器都装过；用仓库里本来就有的 `pg` 驱动
 * （只装在 `apps/api` 的依赖树里）不需要新增任何东西。
 *
 * ## 实现的 psql 语义（只这些）
 *
 *  - 变量：`-v name=value` 传入；`\set name value` 设置；`:'name'` 引用**字面量**替换。
 *  - `\gset`：执行当前缓冲，**取结果集的第一列第一个值**写进同名列的变量。
 *  - `\gexec`：执行当前缓冲，**把结果集第一列第一行当 SQL 再执行**。
 *  - 其余反斜杠元命令（`\d`／`\copy`／`\timing`…）**一律拒绝**。
 *
 * **为什么最后那条不是偷懒**：`infra/postgres/roles.sql` 真实用到的恰好就是上面
 * 三个（`\set ON_ERROR_STOP`、4 处 `\gset`、6 处 `\gexec`），全部已按语义实现。
 * 而**近似**执行一个不认识的元命令，等于让人以为角色授权跑过了而其实没有——
 * 那正是这个脚本存在的理由被推翻的方式。所以未知的一律明确失败。
 *
 * 语句切分必须知道**字符串与美元引用体**，否则 `format('…;…')` 里那个分号会把一条
 * 语句劈成两半，而 `$$ … $$` 里的分号更是到处都是（roles.sql 满篇都是 DO 块）。
 *
 * 用法（由 dev-disposable-db.sh 调用，不要手工用）：
 *   node scripts/psql-lite.mjs -h HOST -p 5432 -U ailearn -d DB -v k=v -f -
 *   node scripts/psql-lite.mjs ... -c "SELECT 1"
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `pg` 只装在 app 包的依赖树里，从那儿解析——不新增依赖。 */
function loadPg() {
  for (const base of [`${REPO_ROOT}/apps/api`, REPO_ROOT]) {
    try {
      return createRequire(resolve(base, "package.json"))("pg");
    } catch { /* 换下一个位置 */ }
  }
  throw new Error("psql-lite: 找不到 pg 驱动（它只装在 apps/api 的依赖树里）");
}

/**
 * 把一段 SQL 文本切成若干条：普通语句、`\gset`、`\gexec`。
 * 扫描时跟踪单引号字符串（含 `''` 转义）与美元引用体，只有在它们之外才认分隔符。
 */
export function splitStatements(text) {
  const out = [];
  let buf = "";
  let i = 0;
  let inSingle = false;
  let dollarTag = null; // 非 null 时处在 $tag$ … $tag$ 体内

  const flush = () => { const t = buf.trim(); if (t) out.push({ kind: "sql", text: t }); buf = ""; };
  const emit = (kind, column) => { flush(); out.push({ kind, column: column ?? null }); };

  while (i < text.length) {
    // ① 美元引用体：体内的分号**不是**语句分隔符（roles.sql 满篇都是 DO 块）
    if (dollarTag !== null) {
      if (text.startsWith(dollarTag, i)) { buf += dollarTag; i += dollarTag.length; dollarTag = null; continue; }
      buf += text[i]; i++; continue;
    }
    if (!inSingle) {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(i));
      if (tag) { dollarTag = tag[0]; buf += tag[0]; i += tag[0].length; continue; }
    }

    const ch = text[i];

    // ② 单引号字符串（'' 是转义，不是结束）
    if (inSingle) {
      buf += ch;
      if (ch === "'") { if (text[i + 1] === "'") { buf += "'"; i += 2; continue; } inSingle = false; }
      i++; continue;
    }
    if (ch === "'") { inSingle = true; buf += ch; i++; continue; }

    // ②b 注释：**剥掉**，不参与变量替换也不参与切分。
    // 这不是洁癖：roles.sql 第 17 行的说明文字里就写着 `:'name'` 这几个字符，
    // 而 psql 的词法器在注释里**不做**变量插值——照做才与真 psql 一致。
    // （不剥的话，那行说明会把 `name` 当成一个没给值的变量而直接失败。）
    if (ch === "-" && text[i + 1] === "-") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("psql-lite: 块注释没有闭合（*/ 缺失）");
      i = end + 2;
      continue;
    }

    // ③ 反斜杠元命令。三种都实现；第四种一律拒绝。
    if (ch === "\\") {
      const m = /^\\(set|gset|gexec|copy|d|timing|pset|echo|s|watch|conninfo)\b([^\n]*)/.exec(text.slice(i));
      const name = m?.[1];
      if (m && (name === "set" || name === "gset" || name === "gexec")) {
        const rest = m[2] ?? "";
        if (name === "set") {
          const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(rest);
          // `\set ON_ERROR_STOP on` 记下即可：我们本来就遇错即停，不需要读它。
          if (kv) out.push({ kind: "set", name: kv[1], value: (kv[2] ?? "").trim() });
        } else if (name === "gset") {
          emit("gset", rest.trim() || null);
        } else {
          emit("gexec", null);
        }
        i += m[0].length;
        continue;
      }
      throw new Error(
        `psql-lite: 不支持的反斜杠元命令 \\${name ?? text.slice(i, i + 12)}。`
        + "这个替身只实现 \\set / \\gset / \\gexec 三个（roles.sql 用到的就这三个）；"
        + "**故意不近似执行**——近似会让人以为角色授权跑过了而其实没有。"
        + "装个真 psql，或走 docker exec 那条路。",
      );
    }

    // ④ 普通分隔符
    if (ch === ";") { flush(); i++; continue; }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

/** `:'name'` → 字面量（psql 的引用语法，保证单引号被转义）。 */
function substituteVars(sql, vars) {
  return sql.replace(/:'([A-Za-z_][A-Za-z0-9_]*)'/g, (_m, name) => {
    if (!(name in vars)) throw new Error(`psql-lite: 变量 :'${name}' 没有给值（-v ${name}=…）`);
    const v = String(vars[name]);
    return `'${v.replace(/'/g, "''")}'`;
  });
}

function parseArgs(argv) {
  const opts = { vars: {}, commands: [], file: null, singleTransaction: false, tuplesOnly: false, unaligned: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") opts.host = argv[++i];
    else if (a === "-p") opts.port = Number(argv[++i]);
    else if (a === "-U") opts.user = argv[++i];
    else if (a === "-d") opts.database = argv[++i];
    else if (a === "-q") opts.quiet = true;
    else if (a === "-t") opts.tuplesOnly = true;
    else if (a === "-A") opts.unaligned = true;
    else if (a === "--single-transaction") opts.singleTransaction = true;
    else if (a === "-v") { const kv = argv[++i] ?? ""; const eq = kv.indexOf("="); if (eq < 0) throw new Error(`psql-lite: -v 需要 name=value，收到 '${kv}'`); opts.vars[kv.slice(0, eq)] = kv.slice(eq + 1); }
    else if (a === "-c") opts.commands.push(argv[++i]);
    else if (a === "-f") { const p = argv[++i]; if (p !== "-") throw new Error(`psql-lite: 只支持 -f -（stdin），收到 '${p}'`); opts.file = "stdin"; }
    else if (a === "-W") opts.quiet = true;
    else if (a.startsWith("-")) { /* 静默接受 -X -n -o -P 等无关开关 */ }
    else throw new Error(`psql-lite: 不支持的参数 '${a}'`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { Client } = loadPg();
  const vars = { ...opts.vars };

  const client = new Client({
    host: opts.host ?? process.env.DISPOSABLE_DB_HOST ?? "127.0.0.1",
    port: opts.port ?? Number(process.env.DISPOSABLE_DB_PORT ?? 5432),
    user: opts.user ?? process.env.POSTGRES_USER ?? "ailearn",
    password: process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? "",
    database: opts.database,
  });
  await client.connect();

  /**
   * `\gset` / `\gexec` 作用在**紧邻的前一条查询**上——它们是那条查询的"随后动作"，
   * 不是各自带一条 SQL。第一版把缓冲切成了 `sql` + `gexec` 两个元素却让 gexec
   * 去读自己的 text，于是它拿到 undefined，而报错只说「reading 'replace'」，
   * 离病因隔了三层（切分 → 执行模型 → 替换）。
   */
  let lastResult = null;
  const runScript = async (text) => {
    for (const item of splitStatements(text)) {
      if (item.kind === "set") { vars[item.name] = item.value; continue; }

      // 只有 `sql` 元素带 SQL。`gset`/`gexec` 元素**没有** text：
      // 它们是对紧邻前一条查询结果的"随后动作"，自己不带语句。
      if (item.kind === "sql") {
        lastResult = await client.query(substituteVars(item.text, vars));
        if (!opts.quiet && opts.tuplesOnly) {
          for (const row of lastResult.rows) {
            console.log(opts.unaligned ? Object.values(row).join("|") : JSON.stringify(row));
          }
        }
        continue;
      }

      const row = lastResult?.rows[0];
      const value = row ? Object.values(row)[0] : null;
      if (item.kind === "gset") {
        // psql 的 `\gset` 把第一列写进同名列的变量；`AS ignored` 这种取那个名字。
        const name = item.column ?? (row ? Object.keys(row)[0] : null);
        if (name) vars[name] = value == null ? "" : String(value);
        continue;
      }
      // `\gexec`：把结果当 SQL 再执行。`WHERE NOT EXISTS` 未命中时空结果是正常情形，
      // 不当作错误——那正是「角色已存在就跳过」的写法。
      if (value == null || value === "") continue;
      lastResult = await client.query(String(value));
    }
  };

  try {
    if (opts.singleTransaction) await client.query("BEGIN");
    try {
      for (const sql of opts.commands) await runScript(sql);
      if (opts.file === "stdin") await runScript(readFileSync(0, "utf8"));
      if (opts.singleTransaction) await client.query("COMMIT");
    } catch (error) {
      if (opts.singleTransaction) await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await client.end();
  }
}

// 被当脚本 import 时只导出纯函数，不启动连接。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
  // 栈打出来：这个替身的第一批真实输入是 roles.sql（一千多行），
  // 而症状只说"Cannot read properties of undefined"——不定位到行就等于没信息。
  console.error(String(error?.message ?? error));
  if (process.env.PSQL_LITE_TRACE) console.error(String(error?.stack));
  process.exit(1);
});
}
