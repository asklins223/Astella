/* Local prototype identities. Never sends credentials or represents a server session. */
(() => {
  const KEY = 'astella-mobile-accounts-v1', SESSION = 'astella-mobile-session-v1';
  const copy = value => JSON.parse(JSON.stringify(value));
  class AccountError extends Error {
    constructor(message, field = '') { super(message); this.field = field; }
  }
  function identity(id, email, displayName, sample = false) {
    return { id, email, displayName, avatar: null, sample,
      preferences: { textScale: 1, speechRate: 1, chatLayout: 'scene' },
      companion: { name: '伴星', style: 'warm', detail: 'balanced', remember: true,
        memories: sample ? [
          { id: 'memory-order', text: '理解新概念时，先看例子，再回到定义。', kind: 'preference', space: null, enabled: true, source: '你确认的学习偏好' },
          { id: 'memory-history', text: '正在对照人员来源与责任关系，理解郡县制。', kind: 'context', space: 'home', enabled: true, source: '中央与地方，接着聊', conversationId: 'conversation-current', noteId: 'note-history' },
        ] : [],
        diary: sample ? [{ id: 'diary-history', space: 'home', date: '2026-10-10', title: '从两个问题开始', text: '今天，我们把“中央怎样管理地方”拆成了两个问题：官员从哪里来，又对谁负责。\n\n你停在了任命与责任的关系上。下次可以回到那篇笔记，用自己的话把这两个问题接起来。', noteId: 'note-history', conversationId: 'conversation-current' }] : [],
      },
    };
  }
  const demoIdentity = () => identity('demo', 'demo@astella.local', '林间读书', true);
  function validateAuth(values, register = false) {
    const email = (values.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) throw new AccountError('请输入有效的邮箱地址。', 'email');
    if (!values.password || values.password.length < (register ? 8 : 4) || values.password.length > 200) throw new AccountError(register ? '密码需要 8–200 位。' : '请输入至少 4 位的密码。', 'password');
    if (register && values.password !== values.confirmPassword) throw new AccountError('两次输入的密码不一致。', 'confirmPassword');
    if (register && (!values.displayName?.trim() || values.displayName.trim().length > 32)) throw new AccountError('称呼需要 1–32 个字。', 'displayName');
    // The real API accepts an optional invite token. This fixture recognizes one token only.
    if (register && values.inviteToken?.trim() && values.inviteToken.trim() !== 'ASTELLA') throw new AccountError('演示邀请码为 ASTELLA，也可以留空建立个人书房。', 'inviteToken');
    return email;
  }
  async function digest(password, salt, cryptoApi) {
    if (!cryptoApi?.subtle) throw new AccountError('当前浏览器无法保存体验凭据，请使用示例账号。');
    const bytes = Uint8Array.from([...password].flatMap(char => {
      const n = char.codePointAt(0);
      return n < 128 ? [n] : n < 2048 ? [192 | n >> 6, 128 | n & 63] : n < 65536 ? [224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63] : [240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63];
    }));
    const key = await cryptoApi.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveBits']);
    const bits = await cryptoApi.subtle.deriveBits({ name: 'PBKDF2', salt: Uint8Array.from(salt.match(/../g).map(v => parseInt(v, 16))), iterations: 100000, hash: 'SHA-256' }, key, 256);
    return [...new Uint8Array(bits)].map(n => n.toString(16).padStart(2, '0')).join('');
  }
  class Accounts {
    constructor(storage, sessionStorage, cryptoApi = globalThis.crypto) {
      this.storage = storage; this.sessionStorage = sessionStorage; this.crypto = cryptoApi;
      let first = false;
      try {
        const raw = storage?.getItem(KEY); first = !raw;
        const saved = JSON.parse(raw || 'null');
        this.data = saved?.schema === 1 && Array.isArray(saved.users) && saved.users.some(u => u.id === 'demo') ? saved : { schema: 1, users: [demoIdentity()] };
        this.session = JSON.parse(sessionStorage?.getItem(SESSION) || storage?.getItem(SESSION) || 'null');
      } catch { this.data = { schema: 1, users: [demoIdentity()] }; first = true; }
      if (first) { this.session = { userId: 'demo' }; this.persist(); this.writeSession(true); }
      if (!this.data.users.some(u => u.id === this.session?.userId)) this.session = null;
    }
    get user() { return this.data.users.find(u => u.id === this.session?.userId) || null; }
    get businessKey() { return this.user?.id === 'demo' ? 'astella-mobile-complete-demo-v3' : `astella-mobile-data-${this.user?.id || 'guest'}`; }
    persist() {
      try { this.storage?.setItem(KEY, JSON.stringify(this.data)); this.storageError = !this.storage; }
      catch { this.storageError = true; }
    }
    writeSession(remember) {
      this.storageError = false;
      try {
        this.storage?.removeItem(SESSION); this.sessionStorage?.removeItem(SESSION);
        if (this.session) (remember ? this.storage : this.sessionStorage)?.setItem(SESSION, JSON.stringify(this.session));
      } catch { this.storageError = true; }
    }
    useDemo() { this.session = { userId: 'demo' }; this.writeSession(true); return this.user; }
    async login(values) {
      const email = validateAuth(values);
      const found = this.data.users.find(u => u.email === email);
      const valid = found && (found.id === 'demo' ? values.password === 'Astella123' : found.digest === await digest(values.password, found.salt, this.crypto));
      if (!valid) throw new AccountError('邮箱或密码不正确，请再检查一次。', 'password');
      this.session = { userId: found.id }; this.writeSession(values.remember !== false); return this.user;
    }
    async register(values) {
      const email = validateAuth(values, true);
      if (this.data.users.some(u => u.email === email)) throw new AccountError('这个邮箱已经注册，可以直接登录。', 'email');
      if (!this.crypto?.getRandomValues) throw new AccountError('当前浏览器无法建立体验账号，请使用示例账号。');
      const salt = [...this.crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
      const hash = await digest(values.password, salt, this.crypto);
      const user = { ...identity(`user-${salt}`, email, values.displayName.trim()), sharedAccess: values.inviteToken?.trim() === 'ASTELLA', salt, digest: hash };
      // Recheck after the asynchronous digest: double submit cannot create duplicate accounts.
      if (this.data.users.some(u => u.email === email)) throw new AccountError('这个邮箱已经注册，可以直接登录。', 'email');
      this.data.users.push(user); this.persist();
      if (this.storageError) { this.data.users.pop(); throw new AccountError('浏览器未能保存账号，请释放存储空间后重试。'); }
      this.session = { userId: user.id }; this.writeSession(values.remember !== false); return user;
    }
    logout() { this.session = null; this.writeSession(false); }
    updateProfile({ displayName, avatar = this.user?.avatar }) {
      if (!this.user) throw new AccountError('请先登录。');
      if (!displayName?.trim() || displayName.trim().length > 32) throw new AccountError('称呼需要 1–32 个字。', 'displayName');
      return this.update(user => { user.displayName = displayName.trim(); user.avatar = avatar; });
    }
    update(change) {
      if (!this.user) throw new AccountError('请先登录。');
      const before = copy(this.user); change(this.user); this.persist();
      if (this.storageError) { this.data.users[this.data.users.findIndex(u => u.id === before.id)] = before; throw new AccountError('没有保存成功，请释放浏览器存储后重试。'); }
      return this.user;
    }
    updateCompanion(values) {
      if (!values.name?.trim() || values.name.trim().length > 16) throw new AccountError('伴星名字需要 1–16 个字。', 'name');
      if (!['warm','direct'].includes(values.style) || !['brief','balanced','detailed'].includes(values.detail)) throw new AccountError('请选择有效的表达方式。');
      return this.update(user => Object.assign(user.companion, { name: values.name.trim(), style: values.style, detail: values.detail }));
    }
    memories(space) { return this.user?.companion.memories.filter(m => !m.space || m.space === space) || []; }
    updateMemory(memoryId, values, space) {
      const memory = this.memories(space).find(m => m.id === memoryId);
      if (!memory) throw new AccountError('这条记忆不属于当前书房。');
      if (values.text !== undefined && (!values.text.trim() || values.text.trim().length > 300)) throw new AccountError('记忆需要 1–300 个字。', 'text');
      return this.update(user => { const item = user.companion.memories.find(m => m.id === memoryId); if (values.text !== undefined) item.text = values.text.trim(); if (values.enabled !== undefined) item.enabled = !!values.enabled; });
    }
  }
  const api = { Accounts, AccountError, validateAuth, identity };
  if (typeof window !== 'undefined') window.MOBILE_DEMO_ACCOUNT = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
