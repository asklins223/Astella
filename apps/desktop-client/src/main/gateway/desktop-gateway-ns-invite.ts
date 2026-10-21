
import { DesktopGatewayFailure } from "./desktop-gateway-failure";import { inviteCreatedV1Schema, inviteListResultV1Schema, type InviteCreatedV1, type InviteListResultV1 } from "@astella/shared/desktop-ipc-contracts";
import type { GatewayTransport } from "./desktop-gateway-transport";

export async function createInvite(t: GatewayTransport, 
    options: { role: "member" | "owner"; expiresInHours?: number },
    requestId?: string,
  ): Promise<InviteCreatedV1> {
    await t.ensureConnected(requestId);
    const body: Record<string, unknown> = { role: options.role };
    if (options.expiresInHours !== undefined) body.expiresInHours = options.expiresInHours;
    const result = await t.request("/invites", {
      method: "POST",
      body: JSON.stringify(body),
    }, true, true, requestId);
    const payload = (result.body ?? {}) as Record<string, unknown>;
    const parsed = inviteCreatedV1Schema.safeParse({
      version: 1,
      id: payload.id,
      token: payload.token,
      tokenHint: payload.tokenHint,
      role: payload.role,
      expiresAt: payload.expiresAt ?? null,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function listInvites(t: GatewayTransport, requestId?: string): Promise<InviteListResultV1> {
    await t.ensureConnected(requestId);
    const result = await t.request("/invites?limit=100", { method: "GET" }, true, true, requestId);
    const payload = (result.body ?? {}) as { items?: unknown[]; total?: unknown };
    const parsed = inviteListResultV1Schema.safeParse({
      version: 1,
      items: (payload.items ?? []).map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          version: 1,
          id: row.id,
          tokenHint: row.tokenHint,
          role: row.role,
          status: row.status,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt ?? null,
          consumedAt: row.consumedAt ?? null,
          consumedByEmail: row.consumedBy ?? null,
          revokedAt: row.revokedAt ?? null,
        };
      }),
      total: payload.total,
    });
    if (!parsed.success) throw new DesktopGatewayFailure("unsupported_contract", "user_action");
    return parsed.data;
  }

export async function revokeInvite(t: GatewayTransport, inviteId: string, requestId?: string): Promise<{ revoked: true }> {
    await t.ensureConnected(requestId);
    await t.request(`/invites/${inviteId}`, { method: "DELETE" }, true, true, requestId);
    return { revoked: true };
  }
