import { sha256Hex } from "./content-hash.ts";

/**
 * 方案 20（learning-card-v2）§9.5 Hash Canonicalization V2。
 *
 * 所有方案 20 的 hash 共用一个版本化 canonical serializer；不得由各模块直接
 * `JSON.stringify`。规则（§9.5 冻结）：
 *
 * - 算法 SHA-256，输入前加 domain separator 与 schema version；
 * - object key 按 UTF-8 字节序排序；array 默认保序，只有合同明确标注 set 的
 *   数组才按稳定 element hash 排序（见 hashSetElementsV2）；
 * - 字符串使用 Unicode NFC；换行统一 LF；不做同义改写或空白折叠；
 * - integer 十进制无前导零；禁止浮点序列化（遇非 safe integer 直接 throw）；
 * - `null`、字段缺失和空数组严格区分；unknown field 由各合同 zod `.strict()`
 *   在 parse 阶段 fail closed；
 * - ID 一律 canonical lowercase UUID/string form（由 zod `.uuid()` 保证）；
 *   时间为 UTC RFC3339 固定毫秒精度（由 zod `datetime({ offset: true })` 保证）；
 * - serializer 版本变化必须改变 domain separator，不能重算历史 hash。
 *
 * 只服务端调用（node:crypto 惰性获取，客户端 bundle 中 createRequire 为
 * undefined —— 与 content-hash.ts 同一约定）。
 */

// 这个串是**摘要的域分隔前缀**，逐字进了每一个 hash 的输入。
// 改名等于作废全部存量摘要（快照哈希、证据绑定、卡片身份……），所以它不参与品牌改名。
export const HASH_CANONICAL_V2_DOMAIN = "ailearn-hash-canonical-v2";
export const HASH_CANONICAL_V2_VERSION = 1;

/** hash domain 白名单：字母数字与 `-._/`，防止调用方拼接造成域混淆。 */
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9\-._/]*$/;

/**
 * UTF-8 字节序比较（object key 排序；对合法 Unicode 与 code point 序一致）。
 *
 * ## 降级路径（P2-9）
 *
 * `codePointAt` 每次要解一次代理对，而 key 里绝大多数是 ASCII（id、枚举、字段名）。
 * 所以先跑一条 `charCodeAt` 的逐字节扫描：纯 ASCII 时**码位序就是字节序**，
 * 且 `charCodeAt` 比 `codePointAt` 便宜得多；一旦遇到 > 0x7f 就退回通用路径。
 *
 * 两条路径必须给出**同一个序**——所以下面的测试拿随机字符串对拍，而不是只测几个例子。
 */
function compareAsciiPrefix(a: string, b: string): number | null {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca > 0x7f || cb > 0x7f) return null; // 交回通用路径
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return a.length - b.length;
}

function compareUtf8(a: string, b: string): number {
  const fast = compareAsciiPrefix(a, b);
  if (fast !== null) return fast;
  // 对合法 Unicode，UTF-8 字节序 == code point 序。直接按 code point 比较，
  // 避免排序比较器每次分配两个 Buffer（hash 热路径上的常见开销）。
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(i);
    if (ca !== cb) return ca! < cb! ? -1 : 1;
    i += ca! > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

/**
 * canonical 化的字符串规整：NFC + 换行统一 LF。**不** trim、不折叠空白。
 *
 * ## 为什么分两路（P2-9）
 *
 * `String.prototype.normalize("NFC")` 在**纯 ASCII** 字符串上也要走一遍
 * 完整的规范化查表，是这条 hash 热路径上最大的一笔无谓开销——而 hash 输入里
 * 绝大多数是 id、枚举值、键名这些 ASCII 串。
 *
 * 下面这个测试只有在**含非 ASCII** 时才成立：ASCII 串按定义已经是 NFC，
 * 跳过 normalize 不改变结果。快速路径用 `charCodeAt` 扫描（比正则快，且
 * 能在发现第一个非 ASCII 时立刻退出）。
 *
 * 换行统一不能省：CRLF 必须变 LF，那是**会改变结果**的，不能放在快速路径里跳过。
 */
const NON_ASCII = /[^\u0000-\u007F]/;

export function normalizeCanonicalStringV2(value: string): string {
  // 先处理换行（这一步对 ASCII 与非 ASCII 都要做）
  const lineNormalized = value.indexOf("\r") === -1 ? value : value.replace(/\r\n?/g, "\n");
  // 纯 ASCII：按定义已是 NFC，直接返回
  if (!NON_ASCII.test(lineNormalized)) return lineNormalized;
  return lineNormalized.normalize("NFC");
}

/**
 * 递归 canonicalize：返回一个只剩 null/boolean/integer/string/array/plain
 * object 的值。规则见文件头。任何浮点、非整数、undefined 或非 plain object
 * 都会 throw —— hash 输入必须先经 zod strict parse。
 */
export function canonicalizeV2(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `hash canonicalization V2: non-safe-integer number ${value} is not serializable`,
      );
    }
    return value === 0 ? 0 : value; // -0 规范为 0
  }
  if (typeof value === "string") {
    return normalizeCanonicalStringV2(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalizeV2(v));
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        "hash canonicalization V2: non-plain object is not serializable",
      );
    }
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareUtf8)) {
      const v = source[key];
      if (v === undefined) {
        // 字段缺失与 null 严格区分：undefined 不入 canonical form。
        continue;
      }
      out[key] = canonicalizeV2(v);
    }
    return out;
  }
  throw new Error(
    `hash canonicalization V2: unsupported value type ${typeof value}`,
  );
}

/** canonical JSON 字符串：无额外空白、末尾无换行。 */
export function canonicalJsonV2(value: unknown): string {
  return JSON.stringify(canonicalizeV2(value));
}

/**
 * 版本化 canonical hash：
 * `SHA-256("astella-hash-canonical-v2" \n version \n domain \n canonicalJson)`
 */
export function hashCanonicalV2(domain: string, value: unknown): string {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new Error(
      `hash canonicalization V2: invalid domain separator ${JSON.stringify(domain)}`,
    );
  }
  const payload = [
    HASH_CANONICAL_V2_DOMAIN,
    String(HASH_CANONICAL_V2_VERSION),
    domain,
    canonicalJsonV2(value),
  ].join("\n");
  return sha256Hex(payload);
}

/**
 * set 语义数组的规范化（§9.5：只有合同明确标注 set 的数组才按稳定 element
 * hash 排序）。调用方把 ID/hash 集合字段映射为排序后的 element hash 列表后
 * 再参与 canonical hash —— 顺序不敏感、重复元素幂等。
 */
export function hashSetElementsV2(elements: unknown[]): string[] {
  const hashes = elements.map((el) => {
    const canonical = canonicalizeV2(el);
    const json = JSON.stringify(canonical);
    return sha256Hex(json);
  });
  hashes.sort(compareUtf8);
  return hashes;
}

/** 去重后的 set element hash（ID 集合语义）。 */
export function hashIdSetV2(ids: string[]): string[] {
  const seen = new Set<string>();
  return hashSetElementsV2(
    ids.filter((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
  );
}
