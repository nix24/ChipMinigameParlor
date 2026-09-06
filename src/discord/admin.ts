import type { Env } from "../env";

export async function admin(request: Request, env: Env): Promise<Response> {
  if (env.APP_ENV !== "production" || !env.BOT_ADMIN_TOKEN)
    return new Response("Not found", { status: 404 });
  const supplied = request.headers.get("Authorization") ?? "";
  const encoder = new TextEncoder();
  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${env.BOT_ADMIN_TOKEN}`)),
  ]);
  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  if (difference) return new Response("Unauthorized", { status: 401 });
  const path = new URL(request.url).pathname.slice("/admin".length);
  if (
    !(
      (path === "/status" && request.method === "GET") ||
      (path === "/restart" && request.method === "POST") ||
      (path === "/dev" && ["PUT", "PATCH", "DELETE"].includes(request.method))
    )
  )
    return new Response("Not found", { status: 404 });
  const body = request.method === "GET" ? undefined : await request.text();
  if (body && body.length > 2048) return new Response("Request too large", { status: 413 });
  return env.BOT_CONTROL.get(env.BOT_CONTROL.idFromName("singleton")).fetch(`https://bot${path}`, {
    method: request.method,
    body,
  });
}
