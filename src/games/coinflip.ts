import type { EconomyRepository } from "../db/repository";
import { MAX_CHIPS } from "../db/schema";

export const MAX_COIN_FLIP_STAKE = Math.floor(MAX_CHIPS / 2);
export type CoinSide = "heads" | "tails";

export interface CoinFlipWager {
  transactionId: string;
  userId: string;
  guildId: string;
  amount: number;
  choice: CoinSide;
}

export function coinFlipStake(value: string | number | boolean | undefined): number | undefined {
  if (value === undefined || value === true || value === false) return undefined;
  const stake = Number(value);
  return Number.isSafeInteger(stake) && stake > 0 && stake <= MAX_COIN_FLIP_STAKE
    ? stake
    : undefined;
}

export async function settleCoinFlip(economy: EconomyRepository, wager: CoinFlipWager) {
  const generatedOutcome =
    crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "heads" : "tails";
  const settlement = await economy.settleWager({
    transactionId: wager.transactionId,
    userId: wager.userId,
    guildId: wager.guildId,
    game: "coinflip",
    requestFingerprint: `coinflip:${wager.userId}:${wager.guildId}:${wager.amount}:${wager.choice}`,
    stake: wager.amount,
    payout: generatedOutcome === wager.choice ? wager.amount * 2 : 0,
    result: generatedOutcome,
  });
  if (!settlement.settled) return settlement;
  const outcome = settlement.result;
  if (outcome !== "heads" && outcome !== "tails")
    throw new Error("Stored Coin Flip outcome is invalid.");
  const won = outcome === wager.choice;
  return { settled: true as const, chips: settlement.chips, outcome, won, amount: wager.amount };
}
