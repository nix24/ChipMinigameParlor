import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

// Local transport fixtures exercise the real SDK handshake without Discord credentials.
const guildId = "11111111111111111";
const userId = "22222222222222222";
const clientId = "33333333333333333";
const files = new Map();
const buildDirectory = new URL("../build/activity/", import.meta.url);
for (const name of await readdir(buildDirectory)) {
  if (name === "index.html" || /^index-[a-z0-9]+\.(js|css)$/.test(name))
    files.set(`/${name}`, Bun.file(new URL(name, buildDirectory)));
}
assert.ok(files.has("/index.html"), "Run bun run build:activity first.");
let behavior = "drop-response";
let denyLogin = false;
let chips = 100;
const requests = [];
const settlements = new Map();
const host = `<!doctype html><html><body style="margin:0"><iframe title="Activity" style="display:block;width:100%;height:100dvh;border:0" src="/?frame_id=fixture&instance_id=fixture&platform=desktop&guild_id=${guildId}"></iframe><script>
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || !Array.isArray(event.data)) return;
  const [op, command] = event.data;
  if (op === 0) {
    event.source.postMessage([1, {cmd:'DISPATCH',evt:'READY',nonce:null,data:{v:1,config:{api_endpoint:location.origin,environment:'test'}}}], location.origin);
    return;
  }
  if (op !== 1) return;
  const data = command.cmd === 'AUTHORIZE' ? {code:'fixture-code'} : {
    access_token:'fixture-access',user:{id:'${userId}',username:'Player',discriminator:'0',public_flags:0},
    scopes:['identify','guilds.members.read'],expires:'2099-01-01T00:00:00Z',application:{id:'${clientId}',name:'Coinflip',description:'Local test'}
  };
  event.source.postMessage([1, {cmd:command.cmd,evt:null,nonce:command.nonce,data}], location.origin);
});
</script></body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/host") return new Response(host, { headers: { "Content-Type": "text/html" } });
    if (path === "/api/activity/config")
      return Response.json({ clientId, maxStake: 10000, environment: "staging" });
    if (path === "/api/activity/session")
      return denyLogin
        ? Response.json({ error: "Membership denied." }, { status: 403 })
        : Response.json({
            accessToken: "fixture-access",
            session: "fixture-session",
            userId,
            chips,
          });
    if (path === "/api/activity/flip") {
      assert.equal(request.headers.get("Authorization"), "Bearer fixture-session");
      const round = await request.json();
      requests.push(round);
      if (behavior === "expired")
        return Response.json({ error: "Session expired." }, { status: 401 });
      if (behavior === "insufficient")
        return Response.json({ settled: false, chips: 3, reason: "insufficient-funds" });
      if (!settlements.has(round.roundId)) {
        chips += round.choice === "heads" ? round.amount : -round.amount;
        settlements.set(round.roundId, {
          settled: true,
          chips,
          outcome: "heads",
          won: round.choice === "heads",
          amount: round.amount,
        });
      }
      if (behavior === "drop-response") {
        behavior = "ok";
        return Response.json({ error: "Response interrupted." }, { status: 503 });
      }
      return Response.json(settlements.get(round.roundId));
    }
    const asset = files.get(path === "/" ? "/index.html" : path);
    return asset ? new Response(asset) : new Response("Not found", { status: 404 });
  },
});

async function waitFor(view, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await view.evaluate(expression)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}
const backend = { type: "chrome", url: false, argv: ["--no-sandbox"] };
try {
  await using desktop = new Bun.WebView({ width: 1280, height: 1000, backend });
  await desktop.navigate(server.url.href);
  await desktop.click("#tails");
  await desktop.click("#sound");
  assert.equal(
    await desktop.evaluate("document.querySelector('#sound').getAttribute('aria-pressed')"),
    "true"
  );
  await desktop.click("#flip");
  assert.equal(await desktop.evaluate("document.querySelector('#flip').disabled"), true);
  await waitFor(desktop, "document.querySelector('#round-number').textContent === '02'");
  assert.equal(requests.length, 0, "Practice must not call the server.");
  await desktop.click("#help");
  await desktop.press("Escape");
  assert.equal(await desktop.evaluate("document.querySelector('#rules').open"), false);
  await desktop.click("#motion");
  await desktop.click("#flip");
  await waitFor(desktop, "document.querySelector('#round-number').textContent === '03'");
  await desktop.click("#motion");
  await desktop.click("#flip");
  await desktop.click("#motion");
  await waitFor(desktop, "document.querySelector('#round-number').textContent === '04'");
  await Bun.write("/tmp/coinflip-desktop.png", await desktop.screenshot());

  await using mobile = new Bun.WebView({ width: 390, height: 844, backend });
  await mobile.navigate(server.url.href);
  assert.equal(await mobile.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(
    await mobile.evaluate(
      "document.querySelector('#flip').getBoundingClientRect().bottom < innerHeight"
    ),
    true
  );
  await Bun.write("/tmp/coinflip-mobile.png", await mobile.screenshot());
  await mobile.click("#flip");
  await waitFor(mobile, "document.querySelector('#round-number').textContent === '02'");

  await using landscape = new Bun.WebView({ width: 1100, height: 720, backend });
  await landscape.navigate(server.url.href);
  assert.equal(
    await landscape.evaluate(
      "document.querySelector('#flip').getBoundingClientRect().bottom < innerHeight"
    ),
    true
  );
  assert.equal(
    await landscape.evaluate(
      "document.querySelector('.stage-caption').getBoundingClientRect().bottom < innerHeight"
    ),
    true
  );
  await Bun.write("/tmp/coinflip-landscape.png", await landscape.screenshot());

  await using activity = new Bun.WebView({ width: 1280, height: 1000, backend });
  const doc = "frames[0].document";
  await activity.navigate(new URL("/host", server.url).href);
  await waitFor(
    activity,
    `${doc}.querySelector('#mode-label')?.textContent === 'TEST · SERVER CHIPS'`
  );
  await activity.evaluate(
    `(${doc}.querySelector('#motion').click(), ${doc}.querySelector('#flip').click())`
  );
  await waitFor(activity, `${doc}.querySelector('#flip-label').textContent === 'CHECK RESULT'`);
  assert.equal(settlements.size, 1);
  assert.equal(await activity.evaluate(`${doc}.querySelector('#wager-controls').disabled`), true);
  // Reload loses the bearer token but keeps the unresolved wager's non-secret retry ID.
  await activity.reload();
  await waitFor(activity, `${doc}.querySelector('#flip-label')?.textContent === 'CHECK RESULT'`);
  await activity.evaluate(
    `(${doc}.querySelector('#motion').click(), ${doc}.querySelector('#flip').click())`
  );
  await waitFor(activity, `${doc}.querySelector('#round-number').textContent === '02'`);
  assert.deepEqual(requests[1], requests[0]);
  assert.equal(settlements.size, 1);
  assert.equal(await activity.evaluate(`${doc}.querySelector('#balance').textContent`), "110");
  assert.equal(await activity.evaluate("frames[0].sessionStorage.length"), 0);

  behavior = "expired";
  await activity.evaluate(`${doc}.querySelector('#flip').click()`);
  await waitFor(activity, `${doc}.querySelector('#flip-label').textContent === 'CHECK RESULT'`);
  behavior = "ok";
  await activity.evaluate(`${doc}.querySelector('#connect').click()`);
  await waitFor(activity, `${doc}.querySelector('#flip-label').textContent === 'CHECK RESULT'`);
  await activity.evaluate(`${doc}.querySelector('#flip').click()`);
  await waitFor(activity, `${doc}.querySelector('#round-number').textContent === '03'`);
  assert.deepEqual(requests[3], requests[2]);
  assert.equal(settlements.size, 2);

  behavior = "insufficient";
  await activity.evaluate(`${doc}.querySelector('#motion').click()`);
  await activity.evaluate(`${doc}.querySelector('#flip').click()`);
  await waitFor(
    activity,
    `${doc}.querySelector('#result-title').textContent === "That one's still in your pocket."`
  );
  assert.equal(await activity.evaluate(`${doc}.querySelector('#round-number').textContent`), "03");
  assert.equal(await activity.evaluate(`${doc}.querySelector('#flip').disabled`), true);
  assert.equal(await activity.evaluate("frames[0].sessionStorage.length"), 0);
  assert.equal(settlements.size, 2);
  assert.equal(await activity.evaluate(`${doc}.querySelector('#coin').getAnimations().length`), 0);

  await activity.evaluate(
    `frames[0].sessionStorage.setItem('coinflip:pending:production:${guildId}:${userId}', JSON.stringify({roundId:'1a8f0e75-4d99-4ee5-9ec5-f3d9860aa145',amount:10,choice:'heads'}))`
  );
  await activity.reload();
  await waitFor(
    activity,
    `${doc}.querySelector('#mode-label')?.textContent === 'TEST · SERVER CHIPS'`
  );
  assert.equal(
    await activity.evaluate(`${doc}.querySelector('#flip-label').textContent`),
    "LET IT FLY"
  );
  assert.equal(
    await activity.evaluate("frames[0].sessionStorage.length"),
    1,
    "Other-environment retries must remain untouched."
  );

  chips = Number.MAX_SAFE_INTEGER;
  await using narrow = new Bun.WebView({ width: 320, height: 900, backend });
  await narrow.navigate(new URL("/host", server.url).href);
  await waitFor(
    narrow,
    `${doc}.querySelector('#balance')?.textContent === '9,007,199,254,740,991'`
  );
  assert.equal(
    await narrow.evaluate(`${doc}.documentElement.scrollWidth <= frames[0].innerWidth`),
    true
  );
  await Bun.write("/tmp/coinflip-narrow.png", await narrow.screenshot());

  denyLogin = true;
  await activity.reload();
  await waitFor(
    activity,
    `${doc}.querySelector('#result-title')?.textContent === "Couldn't connect server chips."`
  );
  assert.equal(
    await activity.evaluate(`${doc}.querySelector('#mode-label').textContent`),
    "PRACTICE · NO SERVER CHIPS"
  );
  console.log(
    "Coinflip browser checks passed: practice, mobile, sound, reduced motion, keyboard, SDK handshake, lost-response reload, token expiry, safe retry, insufficient funds, denied login."
  );
} finally {
  server.stop(true);
}
