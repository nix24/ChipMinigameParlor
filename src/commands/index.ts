//index file, import all commands at later data
//import from commands folder for static build
import type { Command } from "@/types/types";

//importing all comamnd instances
//economy
import balanceCommand from "./economy/balance.command";
import DailyCommand from "./economy/daily.command";
import fishingCommand from "./economy/fishing.command";
import leaderboardCommand from "./economy/leaderboard.command";
import sellCommand from "./economy/sell.command";
//games
import EightBallCommand from "./games/8ball.command";
import bigblastCommand from "./games/bigblast.command";
import blackcatCommand from "./games/blackcat.command";
import catheistCommand from "./games/catheist.command";
import CoinflipCommand from "./games/coinflip.command";
import connect4tressCommand from "./games/connect4tress.command";


const allCommands: Command[] = [
    //economy
    balanceCommand,
    DailyCommand,
    fishingCommand,
    leaderboardCommand,
    sellCommand,
    //games
    EightBallCommand,
    bigblastCommand,
    blackcatCommand,
    catheistCommand,
    CoinflipCommand,
    connect4tressCommand,
]

//type guard
function isCommand(command: unknown): command is Command {
    return command !== null &&
        typeof command === 'object' &&
        'execute' in command &&
        typeof (command as Command).execute === 'function' &&
        'data' in command;
}
export const validatedCommands = allCommands.filter(isCommand);
