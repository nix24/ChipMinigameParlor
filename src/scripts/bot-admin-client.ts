export function productionUrl(): string {
  const value = process.env.BOT_PRODUCTION_URL;
  if (!value)
    throw new Error("Set BOT_PRODUCTION_URL in .dev.vars to the production Worker HTTPS origin.");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("BOT_PRODUCTION_URL must be an HTTPS origin.");
  return url.origin;
}

export async function botAdmin(
  path: string,
  method = "GET",
  payload?: { url: string; lease: string }
): Promise<Response> {
  const token = process.env.BOT_ADMIN_TOKEN;
  if (!token)
    throw new Error("Set BOT_ADMIN_TOKEN in .dev.vars and as a production Worker secret.");
  const options: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  };
  if (payload) options.body = JSON.stringify(payload);
  const response = await fetch(`${productionUrl()}/admin/${path}`, options);
  if (!response.ok) {
    const detail = response.headers.get("Content-Type")?.startsWith("text/plain")
      ? (await response.text()).slice(0, 160)
      : "Check bot:status and production configuration.";
    throw new Error(`Bot control failed (HTTP ${response.status}). ${detail}`);
  }
  return response;
}
