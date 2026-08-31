import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { initializePlayerAccount } from "./player-account";
import { rogueliteRuns } from "./schema";

export class RunRepository {
  private readonly db;

  constructor(private readonly env: Env) {
    this.db = drizzle(env.DB);
  }

  async resume(userId: string, guildId: string): Promise<string> {
    const active = await this.activeRun(userId, guildId);
    if (active) return active;

    await initializePlayerAccount(this.env, userId, guildId);
    const id = crypto.randomUUID();
    const inserted = await this.db
      .insert(rogueliteRuns)
      .values({
        id,
        userId,
        guildId,
        state: { floor: 1, health: 100 },
        status: "active",
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .returning({ id: rogueliteRuns.id })
      .get();
    if (inserted) return inserted.id;

    const concurrent = await this.activeRun(userId, guildId);
    if (!concurrent) throw new Error("Active run creation conflicted without a saved run.");
    return concurrent;
  }

  private async activeRun(userId: string, guildId: string): Promise<string | undefined> {
    const run = await this.db
      .select({ id: rogueliteRuns.id })
      .from(rogueliteRuns)
      .where(
        and(
          eq(rogueliteRuns.userId, userId),
          eq(rogueliteRuns.guildId, guildId),
          eq(rogueliteRuns.status, "active")
        )
      )
      .get();
    return run?.id;
  }
}
