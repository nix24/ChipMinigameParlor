import { createServer, type Server } from "node:http";

/** Expose only bot traffic, never Wrangler's local explorer or inspector routes. */
export async function startTunnelProxy(workerPort: number, signal: AbortSignal): Promise<Server> {
  const server = createServer(async (request, response) => {
    if (
      !(
        (request.url === "/" && request.method === "POST") ||
        (request.url === "/__dev/health" && request.method === "GET")
      )
    ) {
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 65_536) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers({ "Content-Type": "application/json" });
      for (const name of ["x-signature-ed25519", "x-signature-timestamp"]) {
        const value = request.headers[name];
        if (value && !Array.isArray(value)) headers.set(name, value);
      }
      const options: RequestInit = {
        method: request.method,
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        redirect: "error",
      };
      if (request.method === "POST") options.body = Buffer.concat(chunks);
      const upstream = await fetch(`http://127.0.0.1:${workerPort}${request.url}`, options);
      const body = await upstream.arrayBuffer();
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain",
      });
      response.end(Buffer.from(body));
    } catch {
      response.writeHead(502).end("Local Worker unavailable");
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  signal.addEventListener(
    "abort",
    () => {
      server.closeAllConnections();
      server.close();
    },
    { once: true }
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}
