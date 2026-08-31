import { applicationCommands } from "../commands";

const token = process.env.DISCORD_BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId)
  throw new Error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required to register commands.");

const response = await fetch(`https://discord.com/api/v10/applications/${clientId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(applicationCommands),
});
if (!response.ok)
  throw new Error(
    `Discord command registration failed: ${response.status} ${await response.text()}`
  );
console.log(`Registered ${applicationCommands.length} application commands.`);
