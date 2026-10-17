import type { CompanionChatSession } from "../../../app/companion-session/companion-chat-session";

export function CompanionFollowupPrompts({
  prompts,
  chat,
}: {
  readonly prompts: readonly string[];
  readonly chat: CompanionChatSession;
}) {
  if (prompts.length === 0) return null;
  const disabled = chat.phase === "sending" || !chat.conversationId;
  return (
    <section className="companion-followups" role="group" aria-label="可以接着问">
      <span>可以接着问</span>
      <div>
        {prompts.map((prompt, index) => (
          <button
            key={`${prompt}:${index}`}
            type="button"
            disabled={disabled}
            onClick={() => { void chat.send({ text: prompt }); }}
          >
            {prompt}
          </button>
        ))}
      </div>
    </section>
  );
}
