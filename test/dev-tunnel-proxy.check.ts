import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startTunnelProxy } from "../src/scripts/dev-tunnel-proxy";

const controller = new AbortController();
let forwarded = 0;
const upstream = createServer((request, response) => {
  forwarded += 1;
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify({ path: request.url, signature: request.headers["x-signature-ed25519"] })
  );
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const address = upstream.address();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Verify Node supplied a TCP address rather than a Unix socket path.
if (!address || typeof address === "string") throw new Error("Missing upstream address");
const proxy = await startTunnelProxy(address.port, controller.signal);
const proxyAddress = proxy.address();
// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Verify Node supplied a TCP address rather than a Unix socket path.
if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy address");
const origin = `http://127.0.0.1:${proxyAddress.port}`;
try {
  for (const path of [
    "/cdn-cgi/local/explorer/api/d1/database",
    "/admin/dev",
    "/__dev/health?other=1",
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 404);
  }
  assert.equal(forwarded, 0);
  const health = await fetch(`${origin}/__dev/health`);
  assert.equal(health.status, 200);
  const interaction = await fetch(origin, {
    method: "POST",
    headers: { "X-Signature-Ed25519": "test-signature" },
    body: "{}",
  });
  assert.match(await interaction.text(), /test-signature/);
  assert.equal(forwarded, 2);
  const oversized = await fetch(origin, { method: "POST", body: "a".repeat(65_537) });
  assert.equal(oversized.status, 413);
  assert.equal(forwarded, 2);
  console.log(
    "Dev tunnel proxy checks passed: allowed routes, signature forwarding, blocked explorer/admin, request size bound."
  );
} finally {
  controller.abort();
  upstream.closeAllConnections();
  upstream.close();
}
