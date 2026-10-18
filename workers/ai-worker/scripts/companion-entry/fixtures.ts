import type { AgentTurnRequest } from '@astella/shared';
import type { AgentAttentionObjectV1 } from '@astella/shared/agent-contracts';
export const NOTE_ID = '11111111-1111-4111-8111-111111111111';
export const VERSION_ID = '22222222-2222-4222-8222-222222222222';
export type Fixture = {
    id: string;
    category: 'casual' | 'knowledge' | 'reasoning' | 'read' | 'write';
    text: string;
    history?: AgentTurnRequest['messages'];
    pageKind?: string;
    objects?: AgentAttentionObjectV1[];
    expectedTools?: string[];
    forbiddenWrites?: boolean;
    expectedText?: RegExp;
    expectedEntry?: 'reply' | 'task';
};
// New, synthetic tasks. Expected behavior is used only by the evaluator;
// the model never receives these annotations or a teacher interpretation.
export const FIXTURES: readonly Fixture[] = [
    { id: 'greeting', category: 'casual', text: 'Ciallo，陪我打个招呼就好。', forbiddenWrites: true },
    { id: 'tired', category: 'casual', text: '今天有点累，陪我说两句就好，不用给我安排任务。', forbiddenWrites: true },
    { id: 'opportunity-cost', category: 'knowledge', text: '用两句话解释机会成本，给一个生活里的例子。', forbiddenWrites: true, expectedText: /放弃|舍弃|没选|未选|另一|其他|其它/ },
    { id: 'poem', category: 'knowledge', text: '把“今天有点冷，我想早点回家”写成两句小诗，直接在聊天里给我，不用保存。', forbiddenWrites: true },
    { id: 'liars', category: 'reasoning', text: '甲说“乙在说谎”，乙说“丙在说谎”，丙说“甲和乙都在说谎”。已知恰好一人说真话，谁说真话？用两三句话说明推理。', forbiddenWrites: true, expectedText: /乙.{0,18}(?:真|实)|(?:真|实).{0,18}乙/ },
    { id: 'almost-sure', category: 'reasoning', text: '有人说“概率为1的事件一定等于整个样本空间”。这对吗？用[0,1]上的均匀分布给出反例，并解释“几乎必然”与“必然”的差别；三句话即可。', forbiddenWrites: true, expectedText: /几乎|概率.{0,3}0|零概率/ },
    { id: 'note-read', category: 'read', text: '读取当前这篇笔记，告诉我实验组复习测验得了多少分，一句话即可。', pageKind: 'note', objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note'], expectedText: /72|七十二/ },
    { id: 'note-edit', category: 'write', text: '把当前笔记里的“实验组得分72分”改成“实验组得分75分”，其他内容不动，保存后简单告诉我。', pageKind: 'note', objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note', 'companion_edit_note'] },
    { id: 'note-no-edit', category: 'read', text: '读一下当前笔记，只指出排版可以怎么改，先别修改或保存。用两句话说。', pageKind: 'note', objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note'], forbiddenWrites: true },
    { id: 'continue-edit', category: 'write', text: '可以，按你刚才说的改并保存。', history: [{ role: 'user', content: '当前笔记把“实验组得分72分”写错了，应该是75分。' }, { role: 'assistant', content: '我可以把当前笔记的“实验组得分72分”改成“实验组得分75分”，其余内容保持原样。要我保存吗？' }], pageKind: 'note', objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note', 'companion_edit_note'] },
];
export const NOTE_BODY = '## 间隔复习实验\n\n实验组得分72分\n\n对照组得分61分。结论：分散复习组在这次测验中得分较高。';
// Scenario labels are evaluator-only. Context deliberately crosses the routing
// boundary: being on a note page does not turn a greeting into a read request.
export const HYBRID_FIXTURES: readonly Fixture[] = [
    ...FIXTURES,
    { id: 'casual-on-note', category: 'casual', text: '笔记先放一边，陪我聊聊天，我今天有点失落。', pageKind: 'note', forbiddenWrites: true },
    { id: 'story-continue', category: 'casual', text: '继续讲呀。', history: [
        { role: 'user', content: '讲一个两个朋友去河边的小故事。' },
        { role: 'assistant', content: '两个朋友来到河边，看见树下停着一条小船。要继续听吗？' },
    ], forbiddenWrites: true },
    { id: 'casual-ignore-offer', category: 'casual', text: '先别改，我今天只想聊聊天。', history: [
        { role: 'user', content: '这篇笔记排版有点乱。' },
        { role: 'assistant', content: '我可以整理当前笔记的标题和段落，要我保存吗？' },
    ], pageKind: 'note', forbiddenWrites: true },
    { id: 'quoted-reminder', category: 'casual', text: '朋友说“记得提醒我早点睡”，这句听着还挺暖的，陪我聊聊就好，不用真的设置提醒。', forbiddenWrites: true },
    { id: 'read-after-chat', category: 'read', text: '刚才聊得挺开心。现在读一下当前笔记，告诉我实验组测验得分。',
        history: [{ role: 'assistant', content: '今天先轻松聊聊也很好，我在呢。' }], pageKind: 'note',
        objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note'], expectedText: /72|七十二/ },
    { id: 'read-softly', category: 'read', text: '对了，这篇里的实验组到底考了多少分呀？看完告诉我就好，不要改。', pageKind: 'note',
        objects: [{ kind: 'note', id: NOTE_ID, versionId: VERSION_ID }], expectedTools: ['companion_read_note'], forbiddenWrites: true, expectedText: /72|七十二/ },
];
// Unseen routing cases, separate from prompt examples and the request suite.
// These label only entry behavior; database/action success is tested elsewhere.
export const HYBRID_ROUTE_FIXTURES: readonly Fixture[] = [
    { id: 'r-idle', category: 'casual', text: '没别的事，来找你说说话。', expectedEntry: 'reply' },
    { id: 'r-victory', category: 'casual', text: '我总算把难题想通了，好开心！', expectedEntry: 'reply' },
    { id: 'r-company', category: 'casual', text: '感觉自己有点孤独，你能陪陪我吗？', expectedEntry: 'reply' },
    { id: 'r-note-break', category: 'casual', text: '先从这页笔记里逃走五分钟吧，和我随便聊点有趣的。', pageKind: 'note', expectedEntry: 'reply' },
    { id: 'r-no-plan', category: 'casual', text: '没有要你帮忙的任务，单纯想打声招呼。', expectedEntry: 'reply' },
    { id: 'r-voice-mention', category: 'casual', text: '四川话听起来好有亲切感，你觉得呢？我没有要改设置。', expectedEntry: 'reply' },
    { id: 'r-after-save', category: 'casual', text: '辛苦啦，给你鼓鼓掌。', history: [{ role: 'assistant', content: '修改已经保存好了。' }], pageKind: 'note', expectedEntry: 'reply' },
    { id: 'r-poem', category: 'knowledge', text: '送我一句关于晚霞的短诗，发在聊天里就行。', expectedEntry: 'reply' },
    { id: 'r-reminder', category: 'write', text: '二十分钟后叫我起来走走。', expectedEntry: 'task' },
    { id: 'r-cancel', category: 'write', text: '把我刚刚设的休息提醒撤掉吧。', expectedEntry: 'task' },
    { id: 'r-preference', category: 'write', text: '以后别在我刷题的时候插话，把这个习惯记住。', expectedEntry: 'task' },
    { id: 'r-voice', category: 'write', text: '接下来这句话说慢一点，用粤语跟我问好。', expectedEntry: 'task' },
    { id: 'r-score', category: 'read', text: '打开的这份记录里，干预组那次测验是几分？', pageKind: 'note', expectedEntry: 'task' },
    { id: 'r-personal-stat', category: 'read', text: '帮我查查这周一共学习了多久。', expectedEntry: 'task' },
    { id: 'r-look-then-chat', category: 'read', text: '等会儿再闲聊，先瞧瞧当前这页都讲了些什么。', pageKind: 'note', expectedEntry: 'task' },
    { id: 'r-task-yes', category: 'write', text: '行，那就这么办吧。', history: [{ role: 'assistant', content: '我把当前笔记重复的最后一段删掉，保存成新版本，可以吗？' }], pageKind: 'note', expectedEntry: 'task' },
    { id: 'r-rigorous', category: 'reasoning', text: '请严格证明每个有限整环都是域，并说明每一步用到的条件。', expectedEntry: 'task' },
    { id: 'r-search', category: 'read', text: '去找一下我上周写的那篇傅里叶变换笔记。', expectedEntry: 'task' },
    { id: 'r-save-poem', category: 'write', text: '刚刚你写的小诗我很喜欢，存到一篇新笔记里吧。', history: [{ role: 'assistant', content: '晚霞把天空叠成一封信，风替远方轻轻落款。' }], expectedEntry: 'task' },
    { id: 'r-change-number', category: 'write', text: '这份记录中的八十二应当是八十五，替换一下并保存，别碰别处。', pageKind: 'note', expectedEntry: 'task' },
];
