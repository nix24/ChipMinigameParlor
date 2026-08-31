import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Env } from "../env";
import { initializePlayerAccount } from "./player-account";
import { MAX_CHIPS, userGuildStats } from "./schema";

const DAILY_CHIPS = 500;
const DAY_MS = 86_400_000;
const MAX_WRITE_ATTEMPTS = 3;

interface AccountRow {
  chips: number;
  last_daily_claimed_at?: number | null;
}

interface EconomyBatchRow {
  id?: string;
  user_id?: string;
  guild_id?: string;
  source?: string;
  game?: string | null;
  request_fingerprint?: string;
  stake?: number;
  balance_after?: number;
  result?: string;
  chips?: number;
  last_daily_claimed_at?: number | null;
}

export interface WagerRequest {
  transactionId: string;
  userId: string;
  guildId: string;
  game: string;
  requestFingerprint: string;
  stake: number;
  payout: number;
  result: string;
}

export type WagerSettlement =
  | { settled: true; chips: number; result: string }
  | { settled: false; chips: number; reason: "insufficient-funds" | "balance-limit" };

export type DailyClaim =
  | { claimed: true; chips: number }
  | { claimed: false; chips: number; reason: "not-ready" | "balance-limit" };

function validateIdentifier(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required.`);
}

function validateChipAmount(name: string, value: number, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_CHIPS)
    throw new Error(`${name} is outside the supported chip range.`);
}

function isRetryableWrite(error: Error): boolean {
  const message = error.message;
  return [
    "Network connection lost",
    "storage caused object to be reset",
    "reset because its code was updated",
  ].some((fragment) => message.includes(fragment));
}

export class EconomyRepository {
  private readonly db;

  constructor(private readonly env: Env) {
    this.db = drizzle(env.DB);
  }

  async balance(userId: string, guildId: string): Promise<number> {
    const account = await this.account(userId, guildId);
    if (account) return account.chips;
    await initializePlayerAccount(this.env, userId, guildId);
    return 100;
  }

  async claimDaily(
    transactionId: string,
    userId: string,
    guildId: string,
    now = Date.now()
  ): Promise<DailyClaim> {
    validateIdentifier("Transaction ID", transactionId);
    const fingerprint = `daily:${userId}:${guildId}`;
    const attempt = await this.claimDailyForExistingAccount(
      transactionId,
      userId,
      guildId,
      fingerprint,
      now
    );
    if (attempt) return attempt;
    await initializePlayerAccount(this.env, userId, guildId);
    const initializedAttempt = await this.claimDailyForExistingAccount(
      transactionId,
      userId,
      guildId,
      fingerprint,
      now
    );
    if (!initializedAttempt) throw new Error("Daily account initialization did not persist.");
    return initializedAttempt;
  }

  async settleWager(request: WagerRequest): Promise<WagerSettlement> {
    this.validateWager(request);
    const attempt = await this.settleWagerForExistingAccount(request);
    if (attempt) return attempt;
    await initializePlayerAccount(this.env, request.userId, request.guildId);
    const initializedAttempt = await this.settleWagerForExistingAccount(request);
    if (!initializedAttempt) throw new Error("Wager account initialization did not persist.");
    return initializedAttempt;
  }

  async leaderboard(guildId: string): Promise<Array<{ userId: string; chips: number }>> {
    return this.db
      .select({ userId: userGuildStats.userId, chips: userGuildStats.chips })
      .from(userGuildStats)
      .where(eq(userGuildStats.guildId, guildId))
      .orderBy(desc(userGuildStats.chips))
      .limit(10)
      .all();
  }

  private async account(userId: string, guildId: string): Promise<AccountRow | undefined> {
    return (
      (await this.env.DB.prepare(
        "SELECT chips, last_daily_claimed_at FROM user_guild_stats WHERE user_id = ? AND guild_id = ? LIMIT 1"
      )
        .bind(userId, guildId)
        .first<AccountRow>()) ?? undefined
    );
  }

  private async claimDailyForExistingAccount(
    transactionId: string,
    userId: string,
    guildId: string,
    fingerprint: string,
    now: number
  ): Promise<DailyClaim | undefined> {
    const cutoff = now - DAY_MS;
    const results = await this.writeBatch(() => [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO chip_transactions (
          id, user_id, guild_id, source, game, request_fingerprint,
          stake, payout, delta, balance_before, balance_after, result, applied, created_at
        )
        SELECT ?, user_id, guild_id, 'daily', NULL, ?, 0, ?, ?, chips, chips + ?, ?, 0, ?
        FROM user_guild_stats
        WHERE user_id = ? AND guild_id = ?
          AND (last_daily_claimed_at IS NULL OR last_daily_claimed_at <= ?)
          AND chips + ? <= ?`
      ).bind(
        transactionId,
        fingerprint,
        DAILY_CHIPS,
        DAILY_CHIPS,
        DAILY_CHIPS,
        String(now),
        now,
        userId,
        guildId,
        cutoff,
        DAILY_CHIPS,
        MAX_CHIPS
      ),
      this.env.DB.prepare(
        `UPDATE user_guild_stats
        SET chips = (SELECT balance_after FROM chip_transactions WHERE id = ?),
            last_daily_claimed_at = ?
        WHERE user_id = ? AND guild_id = ?
          AND EXISTS (
            SELECT 1 FROM chip_transactions
            WHERE id = ? AND user_id = ? AND guild_id = ? AND applied = 0
          )`
      ).bind(transactionId, now, userId, guildId, transactionId, userId, guildId),
      this.env.DB.prepare(
        "UPDATE chip_transactions SET applied = 1 WHERE id = ? AND user_id = ? AND guild_id = ? AND applied = 0"
      ).bind(transactionId, userId, guildId),
      this.env.DB.prepare("SELECT * FROM chip_transactions WHERE id = ? LIMIT 1").bind(
        transactionId
      ),
      this.env.DB.prepare(
        "SELECT chips, last_daily_claimed_at FROM user_guild_stats WHERE user_id = ? AND guild_id = ? LIMIT 1"
      ).bind(userId, guildId),
    ]);

    const transaction = results[3].results[0];
    const account = results[4].results[0];
    if (account?.chips === undefined) return undefined;
    if (!transaction?.id)
      return {
        claimed: false,
        chips: account.chips,
        reason:
          account.last_daily_claimed_at && account.last_daily_claimed_at > cutoff
            ? "not-ready"
            : "balance-limit",
      };
    this.assertTransactionOwner(transaction, transactionId, userId, guildId, "daily", fingerprint);
    if (transaction.balance_after === undefined)
      throw new Error("Daily transaction is missing its resulting balance.");
    return { claimed: true, chips: transaction.balance_after };
  }

  private async settleWagerForExistingAccount(
    request: WagerRequest
  ): Promise<WagerSettlement | undefined> {
    const delta = request.payout - request.stake;
    const now = Date.now();
    const results = await this.writeBatch(() => [
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO chip_transactions (
          id, user_id, guild_id, source, game, request_fingerprint,
          stake, payout, delta, balance_before, balance_after, result, applied, created_at
        )
        SELECT ?, user_id, guild_id, 'wager', ?, ?, ?, ?, ?, chips, chips + ?, ?, 0, ?
        FROM user_guild_stats
        WHERE user_id = ? AND guild_id = ?
          AND chips >= ?
          AND chips + ? BETWEEN 0 AND ?`
      ).bind(
        request.transactionId,
        request.game,
        request.requestFingerprint,
        request.stake,
        request.payout,
        delta,
        delta,
        request.result,
        now,
        request.userId,
        request.guildId,
        request.stake,
        delta,
        MAX_CHIPS
      ),
      this.env.DB.prepare(
        `UPDATE user_guild_stats
        SET chips = (SELECT balance_after FROM chip_transactions WHERE id = ?),
            games_played = games_played + 1
        WHERE user_id = ? AND guild_id = ?
          AND EXISTS (
            SELECT 1 FROM chip_transactions
            WHERE id = ? AND user_id = ? AND guild_id = ? AND applied = 0
          )`
      ).bind(
        request.transactionId,
        request.userId,
        request.guildId,
        request.transactionId,
        request.userId,
        request.guildId
      ),
      this.env.DB.prepare(
        "UPDATE chip_transactions SET applied = 1 WHERE id = ? AND user_id = ? AND guild_id = ? AND applied = 0"
      ).bind(request.transactionId, request.userId, request.guildId),
      this.env.DB.prepare("SELECT * FROM chip_transactions WHERE id = ? LIMIT 1").bind(
        request.transactionId
      ),
      this.env.DB.prepare(
        "SELECT chips FROM user_guild_stats WHERE user_id = ? AND guild_id = ? LIMIT 1"
      ).bind(request.userId, request.guildId),
    ]);

    const transaction = results[3].results[0];
    const account = results[4].results[0];
    if (account?.chips === undefined) return undefined;
    if (!transaction?.id)
      return {
        settled: false,
        chips: account.chips,
        reason: account.chips < request.stake ? "insufficient-funds" : "balance-limit",
      };
    this.assertTransactionOwner(
      transaction,
      request.transactionId,
      request.userId,
      request.guildId,
      "wager",
      request.requestFingerprint
    );
    if (transaction.game !== request.game || transaction.stake !== request.stake)
      throw new Error("Transaction ID was reused for a different wager.");
    if (transaction.balance_after === undefined || !transaction.result)
      throw new Error("Wager transaction is missing its stored result.");
    return {
      settled: true,
      chips: transaction.balance_after,
      result: transaction.result,
    };
  }

  private assertTransactionOwner(
    transaction: EconomyBatchRow,
    transactionId: string,
    userId: string,
    guildId: string,
    source: string,
    fingerprint: string
  ): void {
    if (
      transaction.id !== transactionId ||
      transaction.user_id !== userId ||
      transaction.guild_id !== guildId ||
      transaction.source !== source ||
      transaction.request_fingerprint !== fingerprint
    )
      throw new Error("Transaction ID was reused for a different chip operation.");
  }

  private validateWager(request: WagerRequest): void {
    validateIdentifier("Transaction ID", request.transactionId);
    validateIdentifier("User ID", request.userId);
    validateIdentifier("Guild ID", request.guildId);
    validateIdentifier("Game", request.game);
    validateIdentifier("Request fingerprint", request.requestFingerprint);
    validateIdentifier("Result", request.result);
    validateChipAmount("Stake", request.stake, false);
    validateChipAmount("Payout", request.payout, true);
    const delta = request.payout - request.stake;
    if (!Number.isSafeInteger(delta)) throw new Error("Wager result exceeds the safe chip range.");
  }

  private async writeBatch(
    statements: () => D1PreparedStatement[]
  ): Promise<D1Result<EconomyBatchRow>[]> {
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      try {
        return await this.env.DB.batch<EconomyBatchRow>(statements());
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error("Unknown D1 write failure.");
        if (attempt === MAX_WRITE_ATTEMPTS || !isRetryableWrite(error)) throw caught;
        await new Promise((resolve) =>
          setTimeout(resolve, 20 * 2 ** (attempt - 1) + Math.random() * 20)
        );
      }
    }
    throw new Error("Unreachable write retry state.");
  }
}
