/* Shared local facts for the frontend prototype. No account or business API. */
(() => {
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  let sequence = 0;
  const id = prefix => `${prefix}-${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${++sequence}`}`;
  const paragraph = (heading, text, key) => ({ id: key || id('block'), type: 'paragraph', heading, text });
  const HISTORY_BLOCKS = [
    paragraph('先看，官员从哪里来', '分封制下，诸侯的身份与封地通常由家族继承。郡县制下，地方官员由中央任免，管理的是行政区。两种制度都管理地方，人员产生的方式却不同。', 'history-1'),
    paragraph('再看，他对谁负责', '郡县制下，官员的职务不由家族持续继承，而是由中央任命和考核。地方官员对中央负责，中央可以通过调任、考核和撤换管理地方。', 'history-2'),
    paragraph('为什么任命会改变关系', '把地方治理交给受中央任免的官员，中央与地方之间就形成了更直接的组织关系。这能加强中央对地方的管理，但实际效果还取决于交通、财政、监督和具体治理能力。', 'history-3'),
    paragraph('用一个小例子理解', '把两者想成两种管理办法：一种把一片地区长期交给某个家族；另一种为这片地区设置职位，再决定由谁任职。这里是在帮助区分人员来源，不能把历史制度简单等同于现代公司。', 'history-4'),
    paragraph('读完，再问自己一句', '如果一个地方职位可以由中央撤换，它与一个能够世代继承的身份，在权力来源和责任关系上有什么不同？先用自己的话说清这一点，再回到具体时代与材料中核对。', 'history-5'),
    paragraph('留给下次的一点问题', '制度名称只是入口。继续读时，可以对照具体材料看看：任命怎样发生，考核由谁完成，地方遇到问题时向谁报告。', 'history-6'),
  ];
  function seed(empty = false) {
    const notes = empty ? [] : [
      { id: 'note-history', title: '从世袭到任命', subtitle: '从人员来源，理解中央与地方', color: 'mint', category: '历史', space: 'home', version: 1, source: '桌面笔记', updatedAt: '2026-10-10T06:32:00.000Z', blocks: clone(HISTORY_BLOCKS), history: [] },
      { id: 'note-entropy', title: '熵，为什么总让人困惑', subtitle: '先区分微观状态与日常的“乱”', color: 'blue', category: '物理', space: 'home', version: 1, source: '桌面笔记', updatedAt: '2026-10-09T11:20:00.000Z', blocks: [paragraph('从微观状态开始', '在统计物理中，可以把宏观状态看作对大量微观状态的描述。同一种宏观表现可能对应许多种微观排列。'), paragraph('一个有用的比喻', '想象把几枚硬币抛在桌上。有些结果只对应少数排列，有些结果对应更多排列。这个比喻帮助理解可能性，不能替代真实系统的定义和计算。'), paragraph('不要把“乱”当作完整定义', '日常语言里的整齐与混乱带有观察者判断。学习熵时，需要明确系统、状态和条件，再决定正在讨论哪一种熵。')], history: [] },
      { id: 'note-function', title: '函数：输入与输出之间', subtitle: '一条对应规则，一个确定的输出', color: 'peach', category: '数学', space: 'home', version: 1, source: '自己写的', updatedAt: '2026-10-08T03:12:00.000Z', blocks: [paragraph('先明确输入范围', '定义函数时先说明允许哪些输入，这个集合是定义域。'), paragraph('每个输入对应一个输出', '对于定义域中的每一个输入，函数都给出一个确定的输出。不同输入可以对应相同输出。'), paragraph('用简单例子检查', '规则 f(x)=2x 把每个允许的数字映射为它的两倍。先代入几个输入，再讨论图像和性质。')], history: [] },
      { id: 'note-shared', title: '一起读：学习怎样发生', subtitle: '共享空间里的阅读材料', color: 'blue', category: '共读', space: 'shared', version: 1, source: '共享笔记', updatedAt: '2026-10-09T08:00:00.000Z', blocks: [paragraph('从实际材料开始', '先选一个你想弄懂的问题，读相关材料，再用自己的话解释。'), paragraph('给理解找证据', '读过不等于会用。可以找一个具体例子，检查自己的解释能否帮助完成实际任务。')], history: [] },
    ];
    return {
      schema: 5, revision: 0, consent: !empty, notes, assets: [], tasks: [], receipts: {},
      recall: empty ? [] : [
        { id: 'recall-seed-1', noteId: 'note-entropy', level: 'practiced', at: '2026-10-09T11:40:00.000Z', longTerm: false, answer: '先说微观排列的多少，再说日常的“乱”只是其中一个比喻。' },
      ],
      conversations: [
        { id: 'conversation-current', title: empty ? '新的交流' : '中央与地方，接着聊', space: 'home', status: 'active', updatedAt: now(), messages: empty ? [] : [
          { id: 'message-seed-1', role: 'user', text: '为什么郡县制更有利于中央管理？', time: '14:32', device: 'desktop', noteId: 'note-history' },
          { id: 'message-seed-2', role: 'assistant', text: '先看两件事：官员从哪里来，又对谁负责。\n\n分封制下，身份与封地通常由家族继承；郡县制下，地方官员由中央任免。中央可以通过任命、考核和撤换管理地方，所以组织关系更直接。\n\n你上次写的那篇正好讨论这件事，可以对照着看。', time: '14:32', device: 'desktop', noteId: 'note-history', action: 'read', source: '查阅了你的笔记' },
        ] },
        ...(!empty ? [{ id: 'conversation-entropy', title: '关于熵的一个小问题', space: 'home', status: 'archived', updatedAt: '2026-10-09T11:00:00.000Z', messages: [{ id: 'message-old-1', role: 'user', text: '能从微观状态讲一下熵吗？', time: '昨天', device: 'desktop', noteId: 'note-entropy' }, { id: 'message-old-2', role: 'assistant', text: '我们可以先从“同一宏观状态，对应多少种微观排列”开始。你整理的笔记里保留了这个入口。', time: '昨天', device: 'desktop', noteId: 'note-entropy', action: 'read' }] }] : []),
        { id: 'conversation-shared', title: '共读空间的交流', space: 'shared', status: 'active', updatedAt: now(), messages: [] },
      ],
    };
  }
  class DemoError extends Error { constructor(code, message) { super(message); this.code = code; } }
  class Store {
    constructor(storage, key = 'astella-mobile-complete-demo-v3', empty = false) {
      this.storage = storage; this.key = key; this.listeners = new Set();
      try { const value = JSON.parse(storage?.getItem(key) || 'null'); this.data = value?.schema === 5 && Array.isArray(value.notes) && Array.isArray(value.tasks) && Array.isArray(value.conversations) && Array.isArray(value.assets) && Array.isArray(value.recall) && value.receipts ? value : seed(empty); } catch { this.data = seed(empty); }
      for (const task of this.data.tasks) if (task.status === 'running') task.status = this.data.receipts[task.id] ? 'unknown' : 'paused';
    }
    activate(key, empty = false) { const loaded = new Store(this.storage,key,empty); this.key=key;this.data=loaded.data; }
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    commit() {
      this.data.revision++; this.storageError = false;
      try { this.storage?.setItem(this.key, JSON.stringify(this.data)); } catch { this.storageError = true; }
      for (const fn of this.listeners) fn(this.data);
    }
    reset(empty = false) { this.data = seed(empty); this.commit(); }
    note(noteId) { return this.data.notes.find(n => n.id === noteId); }
    conversation(conversationId) { return this.data.conversations.find(c => c.id === conversationId); }
    // Same shape as the client's ensureConversation: one live thread per space, reused until archived.
    // Reading never commits, because the app resolves this getter inside every render.
    activeConversation(space) {
      const existing = this.data.conversations.find(c => c.space === space && c.status === 'active');
      if (existing) return existing;
      const conversation = { id: id('conversation'), title: '新的交流', space, status: 'active', updatedAt: now(), messages: [] };
      this.data.conversations.unshift(conversation); return conversation;
    }
    message(conversationId, values) {
      const conversation = this.conversation(conversationId);
      if (!conversation) throw new DemoError('MISSING', '交流不存在');
      const message = { id: id('message'), time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), device: 'mobile', ...clone(values) };
      if (!conversation.messages.length && values.role === 'user') conversation.title = values.text.slice(0, 20);
      conversation.messages.push(message); conversation.updatedAt = now(); this.commit(); return message;
    }
    addAsset(values) { const asset = { id: id('image'), space: 'home', createdAt: now(), ...values }; this.data.assets.push(asset); this.commit(); return asset; }
    startTask(values) { const task = { id: id('task'), status: 'running', progress: 15, stage: '已收到', createdAt: now(), attempts: 1, ...clone(values) }; this.data.tasks.unshift(task); this.commit(); return task; }
    updateTask(taskId, values) { const task = this.data.tasks.find(t => t.id === taskId); if (task) { Object.assign(task, clone(values)); this.commit(); } return task; }
    assertWrite(space) { if (space !== 'home') throw new DemoError('READONLY', '这个空间只允许阅读，不能保存或修改笔记'); }
    createNote({ requestId, title, subtitle, blocks, source = '伴星整理', space = 'home', assetId }) {
      this.assertWrite(space); if (this.data.receipts[requestId]) return this.data.receipts[requestId];
      const note = { id: id('note'), title, subtitle: subtitle || blocks[0]?.heading || '一份新的笔记', blocks: clone(blocks), source, space, assetId, color: assetId ? 'peach' : 'mint', category: assetId ? '随手学' : '随手记', version: 1, history: [], updatedAt: now() };
      this.data.notes.unshift(note);
      const receipt = { noteId: note.id, version: note.version, savedAt: note.updatedAt, kind: 'create' };
      this.data.receipts[requestId] = receipt; this.commit(); return receipt;
    }
    editNote({ requestId, noteId, expectedVersion, blocks, summary = '调整正文' }) {
      const note = this.note(noteId); if (!note) throw new DemoError('MISSING', '笔记已不存在');
      this.assertWrite(note.space); if (this.data.receipts[requestId]) return this.data.receipts[requestId];
      if (note.version !== expectedVersion) throw new DemoError('CONFLICT', '这篇笔记已经更新，先核对最新版');
      note.history.push({ version: note.version, blocks: clone(note.blocks), savedAt: note.updatedAt, summary });
      note.blocks = clone(blocks); note.version++; note.updatedAt = now();
      const receipt = { noteId, version: note.version, savedAt: note.updatedAt, kind: 'edit', summary };
      this.data.receipts[requestId] = receipt; this.commit(); return receipt;
    }
    desktopEdit(noteId) {
      const note = this.note(noteId); if (!note) return;
      return this.editNote({ requestId: id('desktop-edit'), noteId, expectedVersion: note.version, summary: '桌面补充一个阅读提示', blocks: [...clone(note.blocks), paragraph('来自桌面的补充', '读完后，尝试用自己的话解释其中一个关键关系，再回到原文核对。')] });
    }
    // 复习事实只由用户明确分级产生；读没读过、讲过几句都不算，避免把浏览记成掌握。
    recallFor(noteId) { return this.data.recall.filter(r => r.noteId === noteId).sort((a, b) => a.at.localeCompare(b.at)); }
    latestRecall(noteId) { return this.recallFor(noteId).at(-1) || null; }
    recordRecall({ noteId, blockId, level, answer, longTerm }) {
      if (!['seen', 'practiced', 'independent'].includes(level)) throw new DemoError('BAD_LEVEL', '学习事实只能记成看过、练过或独立用过。');
      const record = { id: id('recall'), noteId, blockId, level, answer: answer || '', longTerm: Boolean(longTerm), at: now() };
      this.data.recall.push(record); this.commit(); return record;
    }
    static nextGap(level) { return { seen: 1, practiced: 3, independent: 7 }[level] ?? 0; }
    dueRecalls(space) {
      const day = 86400000;
      return this.data.notes.filter(n => n.space === space).map(note => {
        const last = this.latestRecall(note.id);
        if (!last) return { note, reason: '还没留下过学习记录', due: true, level: null, days: 0 };
        const due = Date.parse(last.at) + Store.nextGap(last.level) * day <= Date.now();
        return { note, level: last.level, due, days: Math.max(0, Math.round((Date.now() - Date.parse(last.at)) / day)),
          reason: { seen: '只标过看过，隔一天该回来看一眼', practiced: `练过一次，隔 ${Store.nextGap(last.level)} 天再回想`, independent: '已经能独立用，隔一周再确认' }[last.level] };
      }).filter(item => item.due);
    }
    resolve(taskId) { const receipt = this.data.receipts[taskId]; if (receipt) this.updateTask(taskId, { status: 'succeeded', progress: 100, stage: '已核对保存', receipt }); return receipt || null; }
  }
  const api = { Store, DemoError, seed, clone, id, paragraph, HISTORY_BLOCKS };
  if (typeof window !== 'undefined') window.MOBILE_DEMO_DATA = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
