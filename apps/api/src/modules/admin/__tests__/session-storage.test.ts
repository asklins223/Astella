import assert from "node:assert/strict";
import { test } from "node:test";

type SessionClient = {
  setToken(value: string | null): void;
  hasToken(): boolean;
  readSessionToken(): string | null;
  rememberSessionToken(): void;
  forgetSessionToken(): void;
};
let instance = 0;
async function loadClient(): Promise<SessionClient> {
  const url = new URL("../static/api-client.js", import.meta.url);
  url.search = `session-test=${++instance}`;
  return await import(url.href) as SessionClient;
}
function storageFixture() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value); },
    removeItem: (key: string) => { items.delete(key); },
  };
}
async function withStorage(storage: ReturnType<typeof storageFixture>, run: () => Promise<void>) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  try { await run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

test("输入候选令牌不立即保存，验证通过后才记住", async () => {
  const storage = storageFixture();
  await withStorage(storage, async () => {
    const client = await loadClient();
    client.setToken("a-test-operator-token");
    assert.equal(storage.items.size, 0);
    client.rememberSessionToken();
    assert.equal(storage.items.size, 1);
    assert.equal(client.readSessionToken(), "a-test-operator-token");
  });
});

test("刷新后的模块能读回候选，但必须重新验证才能进入后台", async () => {
  const storage = storageFixture();
  await withStorage(storage, async () => {
    const signedIn = await loadClient();
    signedIn.setToken("a-test-operator-token");
    signedIn.rememberSessionToken();
    const reloaded = await loadClient();
    assert.equal(reloaded.hasToken(), false);
    assert.equal(reloaded.readSessionToken(), "a-test-operator-token");
    assert.equal(reloaded.hasToken(), false, "读取缓存本身不绕过服务器验证");
  });
});

test("主动锁定或令牌失效，内存和标签页缓存一起清除", async () => {
  const storage = storageFixture();
  await withStorage(storage, async () => {
    const client = await loadClient();
    client.setToken("a-test-operator-token");
    client.rememberSessionToken();
    client.forgetSessionToken();
    assert.equal(client.hasToken(), false);
    assert.equal(client.readSessionToken(), null);
    assert.equal((await loadClient()).readSessionToken(), null);
  });
});

test("暂时断网只清内存，不删除可供下次重试的已验证凭据", async () => {
  const storage = storageFixture();
  await withStorage(storage, async () => {
    const client = await loadClient();
    client.setToken("a-test-operator-token");
    client.rememberSessionToken();
    client.setToken(null);
    assert.equal(client.hasToken(), false);
    assert.equal(client.readSessionToken(), "a-test-operator-token");
  });
});

test("缓存按面板的 API 挂载路径隔离，其他面板的令牌不会被取用", async () => {
  const storage = storageFixture();
  storage.items.set("astella:admin-session:/another-panel/api", "other-deployment-token");
  await withStorage(storage, async () => {
    const client = await loadClient();
    assert.equal(client.readSessionToken(), null);
    client.setToken("a-test-operator-token");
    client.rememberSessionToken();
    assert.equal(storage.items.size, 2);
    client.forgetSessionToken();
    assert.equal(storage.items.get("astella:admin-session:/another-panel/api"), "other-deployment-token");
  });
});

test("浏览器禁用会话存储时仍能登录和锁定", async () => {
  const storage = storageFixture();
  storage.getItem = () => { throw new Error("storage blocked"); };
  storage.setItem = () => { throw new Error("storage blocked"); };
  storage.removeItem = () => { throw new Error("storage blocked"); };
  await withStorage(storage, async () => {
    const client = await loadClient();
    assert.equal(client.readSessionToken(), null);
    client.setToken("a-test-operator-token");
    assert.doesNotThrow(() => client.rememberSessionToken());
    assert.equal(client.hasToken(), true);
    assert.doesNotThrow(() => client.forgetSessionToken());
    assert.equal(client.hasToken(), false);
  });
});
