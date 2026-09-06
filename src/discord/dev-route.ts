import { json, message } from "./protocol";

export type DevRoute =
  | { mode: "production" }
  | { mode: "development"; url: string; expiresAt: number; lease: string };

export async function forwardToDev(request: Request, route?: DevRoute): Promise<Response> {
  if (route?.mode === "production") return new Response(null, { status: 204 });
  if (!route || route.expiresAt <= Date.now())
    return json(
      message(
        "Local dev is unavailable. Start bun run dev:discord on your computer. Production data was not accessed.",
        true
      )
    );
  try {
    const response = await fetch(route.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-Ed25519": request.headers.get("X-Signature-Ed25519") ?? "",
        "X-Signature-Timestamp": request.headers.get("X-Signature-Timestamp") ?? "",
      },
      body: await request.text(),
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get("Content-Type")?.includes("application/json")
    )
      throw new Error("Local dev returned an invalid response.");
    return response;
  } catch {
    console.error("Local dev forwarding failed or exceeded its 2 second deadline.");
    return json(
      message("Local dev did not respond in time. Production data was not accessed.", true)
    );
  }
}

export function tunnelUrl(value: string): string {
  const url = new URL(value);
  // Quick tunnels are the only supported forwarding destination; never forward to arbitrary hosts.
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Expected a Cloudflare quick tunnel HTTPS origin.");
  return url.origin;
}
