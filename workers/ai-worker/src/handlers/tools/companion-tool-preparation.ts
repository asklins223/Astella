import type { CompanionAgentToolDefinitionV1 } from "@astella/shared";

export type PreparingTool = { index: number; id: string; name: string };

/** Display generation as soon as its named item arrives. No arguments, ledger
 * registration or executor is involved until the completed call is validated. */
export class CompanionToolPreparation {
  private readonly pending = new Map<string, PreparingTool>();
  private delivery: Promise<void> = Promise.resolve();

  constructor(
    private readonly offered: readonly CompanionAgentToolDefinitionV1[],
    private readonly publish: (tool: PreparingTool, definition: CompanionAgentToolDefinitionV1, status: "requested" | "not_executed") => Promise<void>,
  ) {}

  observe = (tool: PreparingTool): void => {
    const definition = this.offered.find(item => item.name === tool.name);
    if (!definition || definition.riskClass === "read" || !tool.id || tool.id.length > 200 || this.pending.has(tool.id)) return;
    this.pending.set(tool.id, tool);
    this.delivery = this.delivery.then(() => this.publish(tool, definition, "requested"));
    // The provider callback is synchronous; finish() owns error propagation.
    void this.delivery.catch(() => undefined);
  };

  async finish(calls: readonly { id: string; name: string }[]): Promise<void> {
    await this.delivery;
    for (const tool of this.pending.values()) {
      if (calls.some(call => call.id === tool.id && call.name === tool.name)) continue;
      await this.publish(tool, this.offered.find(item => item.name === tool.name)!, "not_executed");
    }
    this.pending.clear();
  }
}
