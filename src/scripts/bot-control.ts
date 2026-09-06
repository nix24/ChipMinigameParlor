import { botAdmin } from "./bot-admin-client";

const command = process.argv[2];
if (command === "prod") {
  await botAdmin("dev", "DELETE");
  console.log(
    "Test server switched to production. Old dev buttons remain blocked. Any running dev session will stop at its next renewal."
  );
} else if (command === "restart") {
  await botAdmin("restart", "POST");
  console.log(
    "Gateway recovery requested. Check bun run bot:status for READY; commands use the existing HTTP endpoint."
  );
} else if (command === "status") {
  const response = await botAdmin("status");
  // SAFETY: this is the authenticated Worker status contract; output is limited to non-secret fields.
  const status = (await response.json()) as {
    gateway: string;
    testGuildId: string | null;
    route: { mode: string; expiresAt?: number } | null;
  };
  console.log(`Gateway: ${status.gateway}`);
  console.log(`Test server: ${status.testGuildId ?? "not configured"}`);
  console.log(`Test mode: ${status.route?.mode ?? "development (not connected)"}`);
  if (status.route?.expiresAt)
    console.log(
      `Dev lease: ${status.route.expiresAt > Date.now() ? "active" : "expired; production fallback blocked"}`
    );
} else throw new Error("Expected status, prod, or restart.");
