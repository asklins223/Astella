const test = require('node:test');
const assert = require('node:assert/strict');
const { Store, paragraph, clone } = require('../mobile-companion-data.js');
function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}
test('lost create receipt can be queried and replayed without another note, including after reload', () => {
  const storage = memoryStorage();
  const store = new Store(storage);
  const task = store.startTask({ kind: 'create', space: 'home' });
  const args = { requestId: task.id, title: '短记', blocks: [paragraph('想法', '只保留用户这句话')] };
  const receipt = store.createNote(args);
  store.updateTask(task.id, { status: 'unknown' });
  const restored = new Store(storage);
  assert.deepEqual(restored.resolve(task.id), receipt);
  assert.deepEqual(restored.createNote(args), receipt);
  assert.equal(restored.data.notes.filter(n => n.title === '短记').length, 1);
  assert.equal(restored.note(receipt.noteId).blocks[0].text, '只保留用户这句话');
});
test('editing keeps object identity and an immutable before snapshot', () => {
  const store = new Store(memoryStorage());
  const note = store.note('note-history');
  const before = clone(note.blocks);
  const blocks = clone(note.blocks);
  blocks[1].text = '这是局部修改。';
  const args = { requestId: 'edit-once', noteId: note.id, expectedVersion: 1, blocks, summary: '改第二段' };
  const receipt = store.editNote(args);
  blocks[0].text = '调用方后来的变化';
  assert.equal(store.note(note.id), note);
  assert.equal(note.version, 2);
  assert.deepEqual(note.history[0].blocks, before);
  assert.equal(note.blocks[0].text, before[0].text);
  assert.deepEqual(store.editNote(args), receipt);
  assert.equal(note.version, 2);
});
test('a desktop update rejects a stale mobile edit without overwriting it', () => {
  const store = new Store(memoryStorage());
  const note = store.note('note-history');
  const staleBlocks = clone(note.blocks);
  store.desktopEdit(note.id);
  assert.throws(() => store.editNote({ requestId: 'stale', noteId: note.id, expectedVersion: 1, blocks: staleBlocks }), error => error.code === 'CONFLICT');
  assert.equal(note.version, 2);
  assert.equal(note.blocks.at(-1).heading, '来自桌面的补充');
  assert.equal(store.data.receipts.stale, undefined);
});
test('readonly objects reject both new notes and edits, retaining readable content', () => {
  const store = new Store(memoryStorage());
  const note = store.note('note-shared');
  const before = clone(note);
  assert.throws(() => store.createNote({ requestId: 'shared-create', space: 'shared', title: '不能写', blocks: [] }), error => error.code === 'READONLY');
  assert.throws(() => store.editNote({ requestId: 'shared-edit', noteId: note.id, expectedVersion: 1, blocks: [] }), error => error.code === 'READONLY');
  assert.deepEqual(note, before);
});
test('refresh never pretends an interrupted task is still executing', () => {
  const storage = memoryStorage();
  const store = new Store(storage);
  const task = store.startTask({ kind: 'create', space: 'home' });
  assert.equal(new Store(storage).data.tasks[0].status, 'paused');
  store.createNote({ requestId: task.id, title: '已经写入', blocks: [paragraph('正文', '回执还没回来')] });
  assert.equal(new Store(storage).data.tasks[0].status, 'unknown');
});
test('one live thread per space, reused rather than forked', () => {
  const storage = memoryStorage();
  const store = new Store(storage);
  assert.equal(store.activeConversation('home'), store.activeConversation('home'), 'reading the thread never forks it');
  const live = store.activeConversation('home');
  store.message(live.id, { role: 'user', text: '接着问一句' });
  assert.equal(store.activeConversation('home').id, live.id, 'the next message still lands in the same thread');
  const reloaded = new Store(storage);
  assert.equal(reloaded.activeConversation('home').id, live.id, 'the same thread survives a reload');
  assert.equal(reloaded.conversation(live.id).messages.length, 3);
  for (const space of ['home', 'shared']) assert.equal(reloaded.data.conversations.filter(c => c.space === space && c.status === 'active').length, 1);
  assert.ok(reloaded.conversation('conversation-entropy'), 'older conversations stay readable as history');
  assert.equal(reloaded.conversation('conversation-entropy').status, 'archived');
});
test('malformed local storage recovers to usable demo facts', () => {
  const storage = memoryStorage();
  storage.setItem('astella-mobile-complete-demo-v3', JSON.stringify({ schema: 3 }));
  const store = new Store(storage);
  assert.ok(store.conversation('conversation-current'));
  assert.ok(store.note('note-history'));
});
test('learning facts only come from an explicit grade and come back on the level gap', () => {
  const store = new Store(memoryStorage());
  assert.equal(store.latestRecall('note-history'), null, 'reading a note never creates a record');
  const note = store.note('note-history');
  const blockId = note.blocks[0].id;
  const due = () => store.dueRecalls('home').find(item => item.note.id === note.id);
  assert.ok(due(), 'a note with no record still comes back as unread');
  store.recordRecall({ noteId: note.id, blockId, level: 'practiced', answer: '官员由中央任免。', longTerm: true });
  assert.equal(due(), undefined, 'a record made just now is not due yet');
  assert.equal(store.data.recall.filter(r => r.noteId === note.id).length, 1, 'a second grade appends, it never rewrites');
  store.data.recall.at(-1).at = new Date(Date.now() - 4 * 86400000).toISOString();
  assert.match(due().reason, /隔 3 天/, 'the practiced gap is three days');
  store.recordRecall({ noteId: note.id, blockId, level: 'independent' });
  assert.equal(store.latestRecall(note.id).level, 'independent', 'the newest grade is the one that sets the next gap');
  assert.equal(due(), undefined, 'a week for independent use');
  assert.throws(() => store.recordRecall({ noteId: note.id, level: 'mastered' }), /看过、练过或独立用过/);
});
