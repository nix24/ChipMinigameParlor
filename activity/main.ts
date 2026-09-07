import { z } from "zod";

type CoinSide = "heads" | "tails";
type Phase = "ready" | "flipping" | "uncertain" | "connecting";
type Table =
  | { mode: "practice"; chips: number }
  | {
      mode: "server";
      chips: number;
      session: string;
      userId: string;
      guildId: string;
      environment: z.infer<typeof configSchema>["environment"];
    };
const roundSchema = z.object({
  roundId: z.string().uuid(),
  amount: z.number().int().positive(),
  choice: z.enum(["heads", "tails"]),
});
type Round = z.infer<typeof roundSchema>;
const configSchema = z.object({
  clientId: z.string().regex(/^\d{17,20}$/),
  maxStake: z.number().int().positive(),
  environment: z.enum(["local", "staging", "production"]),
});
const sessionSchema = z.object({
  accessToken: z.string(),
  session: z.string(),
  userId: z.string(),
  chips: z.number().int().nonnegative(),
});
const resultSchema = z.discriminatedUnion("settled", [
  z.object({
    settled: z.literal(true),
    chips: z.number().int().nonnegative(),
    outcome: z.enum(["heads", "tails"]),
    won: z.boolean(),
    amount: z.number().int().positive(),
  }),
  z.object({
    settled: z.literal(false),
    chips: z.number().int().nonnegative(),
    reason: z.enum(["insufficient-funds", "balance-limit"]),
  }),
]);

function element<T extends HTMLElement>(id: string, constructor: { new (): T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof constructor)) throw new Error(`Missing Coinflip control: ${id}`);
  return found;
}
const form = element("play-form", HTMLFormElement);
const amount = element("amount", HTMLInputElement);
const flip = element("flip", HTMLButtonElement);
const wagerControls = element("wager-controls", HTMLFieldSetElement);
const heads = element("heads", HTMLButtonElement);
const tails = element("tails", HTMLButtonElement);
const connect = element("connect", HTMLButtonElement);
const refill = element("refill", HTMLButtonElement);
const stage = document.querySelector<HTMLElement>(".stage");
if (!stage) throw new Error("Missing Coinflip stage.");
const coin = element("coin", HTMLDivElement);
const lift = element("coin-lift", HTMLDivElement);
const shadow = element("coin-shadow", HTMLDivElement);
const sound = element("sound", HTMLButtonElement);
const motion = element("motion", HTMLButtonElement);
const rules = element("rules", HTMLDialogElement);
const confetti = element("confetti", HTMLDivElement);
const embedded = new URLSearchParams(location.search).has("frame_id");
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = motionPreference.matches;
let soundEnabled = false;
let audio: AudioContext | undefined;
let table: Table = { mode: "practice", chips: 100 };
let phase: Phase = "ready";
let choice: CoinSide = "heads";
let maxStake = Math.floor(Number.MAX_SAFE_INTEGER / 2);
let pending: Round | undefined;
let rounds = 0;
const history: CoinSide[] = [];
let sdk: import("@discord/embedded-app-sdk").DiscordSDK | undefined;

function text(id: string, value: string): void {
  element(id, HTMLElement).textContent = value;
}
function feedback(title: string, detail: string): void {
  text("result-title", title);
  text("result-detail", detail);
}
function currentAmount(): number {
  return amount.valueAsNumber;
}
function validAmount(): boolean {
  const wager = currentAmount();
  return Number.isSafeInteger(wager) && wager >= 1 && wager <= Math.min(table.chips, maxStake);
}
function render(): void {
  const locked = phase !== "ready";
  wagerControls.disabled = locked;
  flip.disabled =
    phase === "flipping" || phase === "connecting" || (phase === "ready" && !validAmount());
  connect.disabled = phase === "flipping" || phase === "connecting";
  connect.hidden = !embedded;
  connect.textContent =
    table.mode === "server" && phase !== "uncertain"
      ? "Switch to practice"
      : "Connect server chips";
  text(
    "flip-label",
    phase === "flipping"
      ? "IN THE AIR…"
      : phase === "connecting"
        ? "CONNECTING…"
        : phase === "uncertain"
          ? "CHECK RESULT"
          : rounds
            ? "FLIP AGAIN"
            : "LET IT FLY"
  );
  text(
    "mode-label",
    table.mode === "practice"
      ? "PRACTICE · NO SERVER CHIPS"
      : table.environment === "production"
        ? "DISCORD · SERVER CHIPS"
        : "TEST · SERVER CHIPS"
  );
  text("wallet-label", table.mode === "practice" ? "PRACTICE CHIPS" : "SERVER CHIPS");
  text("balance", table.chips.toLocaleString("en-US"));
  element("balance", HTMLElement).classList.toggle(
    "long-balance",
    table.chips >= 1_000_000_000_000
  );
  amount.max = String(Math.max(1, Math.min(table.chips, maxStake)));
  text("return", validAmount() ? (currentAmount() * 2).toLocaleString("en-US") : "—");
  element("wager-preview", HTMLSpanElement).hidden = !validAmount();
  element("amount-error", HTMLSpanElement).hidden = validAmount();
  text(
    "amount-error",
    table.chips === 0
      ? "No chips available for a wager."
      : `Choose 1–${Math.min(table.chips, maxStake).toLocaleString("en-US")} whole chips.`
  );
  amount.setAttribute("aria-invalid", String(!validAmount()));
  refill.hidden = table.mode !== "practice" || table.chips > 0 || locked;
  heads.classList.toggle("selected", choice === "heads");
  tails.classList.toggle("selected", choice === "tails");
  heads.setAttribute("aria-pressed", String(choice === "heads"));
  tails.setAttribute("aria-pressed", String(choice === "tails"));
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-amount]")) {
    button.classList.toggle("chosen", Number(button.dataset.amount) === currentAmount());
    button.disabled = Number(button.dataset.amount) > table.chips;
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const proxy = location.hostname.endsWith(".discordsays.com") ? "/.proxy" : "";
  const response = await fetch(`${proxy}/api/activity/${path}`, {
    ...init,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(await response.json());
    throw new ApiError(
      response.status,
      error.success ? error.data.error : "The server couldn't confirm this request."
    );
  }
  return response;
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Discord didn't respond. Try connecting again.")),
          20000
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function pendingKey(server: Extract<Table, { mode: "server" }>): string {
  return `coinflip:pending:${server.environment}:${server.guildId}:${server.userId}`;
}

async function connectServer(): Promise<void> {
  if (phase === "flipping" || phase === "connecting") return;
  phase = "connecting";
  feedback("Pulling up your chair…", "Connecting to your Discord server.");
  render();
  try {
    const config = configSchema.parse(await (await api("config")).json());
    maxStake = config.maxStake;
    if (!sdk) {
      const { DiscordSDK } = await import("@discord/embedded-app-sdk");
      sdk = new DiscordSDK(config.clientId, { disableConsoleLogOverride: true });
    }
    await deadline(sdk.ready());
    if (!sdk.guildId) throw new Error("Server chips need a server. Practice works here in DMs.");
    const { code } = await deadline(
      sdk.commands.authorize({
        client_id: config.clientId,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify", "guilds.members.read"],
      })
    );
    const session = sessionSchema.parse(
      await (
        await api("session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, guildId: sdk.guildId }),
        })
      ).json()
    );
    const authenticated = await deadline(
      sdk.commands.authenticate({ access_token: session.accessToken })
    );
    if (!authenticated || authenticated.user.id !== session.userId)
      throw new Error("Discord identity didn't match. Reopen the Activity to reconnect.");
    if (
      pending &&
      table.mode === "server" &&
      (table.userId !== session.userId ||
        table.guildId !== sdk.guildId ||
        table.environment !== config.environment)
    )
      throw new Error(
        "Reopen this round in its original environment, Discord server, and account."
      );
    const server: Table = {
      mode: "server",
      chips: session.chips,
      session: session.session,
      userId: session.userId,
      guildId: sdk.guildId,
      environment: config.environment,
    };
    // Only the wager and its retry ID persist. Credentials stay in memory.
    const saved = sessionStorage.getItem(pendingKey(server));
    if (saved) {
      const parsed = roundSchema.safeParse(JSON.parse(saved));
      if (!parsed.success)
        throw new Error("Saved round could not be read. Reopen the Activity to recover it.");
      pending = parsed.data;
      choice = pending.choice;
      amount.value = String(pending.amount);
    }
    table = server;
    phase = pending ? "uncertain" : "ready";
    feedback(
      pending ? "A round is waiting for you." : "Your chair is ready.",
      pending
        ? "Check its result before starting another flip."
        : `${config.environment === "production" ? "" : "Test environment. "}Wagers use chips from this Discord server.`
    );
  } catch (error) {
    phase = pending ? "uncertain" : "ready";
    feedback(
      "Couldn't connect server chips.",
      error instanceof Error ? error.message : "Try connecting again."
    );
  }
  render();
}

function playSound(kind: "pick" | "toss" | "win" | "miss"): void {
  if (!soundEnabled || !audio || audio.state !== "running" || document.hidden) return;
  const context = audio;
  const notes =
    kind === "win"
      ? [523.25, 659.25, 783.99, 1046.5]
      : kind === "miss"
        ? [392, 329.63]
        : kind === "toss"
          ? [330, 660, 990]
          : [660];
  notes.forEach((frequency, index) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const start = context.currentTime + index * 0.075;
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.07, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  });
}

function stopCoinMotion(): void {
  for (const target of [coin, lift, shadow]) {
    for (const animation of target.getAnimations()) animation.cancel();
  }
}

function setMotion(): void {
  document.body.classList.toggle("reduced-motion", reducedMotion);
  motion.setAttribute("aria-pressed", String(reducedMotion));
  motion.textContent = reducedMotion ? "Less motion" : "Motion";
  motion.title = reducedMotion ? "Restore full animation" : "Reduce animation";
  if (reducedMotion) {
    stopCoinMotion();
    confetti.replaceChildren();
  }
}

async function animateToss(): Promise<void> {
  stage?.classList.add("tossing");
  stage?.removeAttribute("data-result");
  text("stage-kicker", "UP, UP, AND…");
  text("stage-line", "A little suspense.");
  playSound("toss");
  if (reducedMotion) return;
  const duration = 1100;
  const toss = lift.animate(
    [
      { transform: "translateY(0) rotate(-12deg)", offset: 0 },
      { transform: "translateY(22px) rotate(-18deg)", offset: 0.12 },
      { transform: "translateY(var(--toss-height, -65px)) rotate(8deg)", offset: 0.48 },
      { transform: "translateY(-12px) rotate(0deg)", offset: 1 },
    ],
    { duration, easing: "ease-in-out", fill: "forwards" }
  );
  coin.animate(
    [{ transform: coin.style.transform || "rotateX(0deg)" }, { transform: "rotateX(1530deg)" }],
    {
      duration,
      easing: "ease-in-out",
      fill: "forwards",
    }
  );
  shadow.animate(
    [
      { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
      { transform: "translate(-50%,-50%) scale(.5)", opacity: 0.3 },
      { transform: "translate(-50%,-50%) scale(1)", opacity: 1 },
    ],
    { duration }
  );
  await toss.finished.catch((error) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  });
  stage?.classList.add("awaiting");
  text("stage-line", "Finding its feet…");
}

async function land(outcome: CoinSide): Promise<void> {
  stage?.classList.remove("tossing", "awaiting");
  stopCoinMotion();
  const rotation = outcome === "heads" ? 0 : 180;
  coin.style.transform = `rotateX(${rotation}deg)`;
  lift.style.transform = "rotate(-8deg)";
  if (reducedMotion) return;
  const landing = coin.animate(
    [{ transform: `rotateX(${rotation - 360}deg)` }, { transform: `rotateX(${rotation}deg)` }],
    { duration: 420, easing: "cubic-bezier(.15,.75,.35,1)" }
  );
  lift.animate(
    [
      { transform: "translateY(-12px) rotate(0deg)" },
      { transform: "translateY(13px) rotate(-8deg)", offset: 0.55 },
      { transform: "translateY(0) rotate(-8deg)" },
    ],
    { duration: 420, easing: "ease-out" }
  );
  await landing.finished.catch((error) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
  });
}

function celebrate(): void {
  if (reducedMotion) return;
  confetti.replaceChildren();
  for (let index = 0; index < 20; index += 1) {
    const piece = document.createElement("i");
    const angle = (index / 20) * Math.PI * 2;
    piece.style.setProperty("--x", `${Math.cos(angle) * (100 + (index % 3) * 35)}px`);
    piece.style.setProperty("--y", `${Math.sin(angle) * 125 + 65}px`);
    piece.style.setProperty("--spin", `${index * 71}deg`);
    piece.style.setProperty(
      "--confetti-color",
      ["#ec7247", "#78a879", "#e7b439", "#fff8d8"][index % 4]
    );
    piece.addEventListener("animationend", () => piece.remove(), { once: true });
    confetti.append(piece);
  }
}

function record(outcome: CoinSide): void {
  rounds += 1;
  history.unshift(outcome);
  history.splice(6);
  text("round-number", String(rounds + 1).padStart(2, "0"));
  text("history-summary", `${rounds} ${rounds === 1 ? "flip" : "flips"} this visit.`);
  const list = element("history", HTMLOListElement);
  list.replaceChildren();
  for (let index = 0; index < 6; index += 1) {
    const entry = document.createElement("li");
    const side = history[index];
    entry.className = side ?? "empty-slot";
    entry.textContent = side ? (side === "heads" ? "H" : "T") : "·";
    entry.setAttribute(
      "aria-label",
      side ? `${index === 0 ? "Latest: " : ""}${side}` : "No flip yet"
    );
    list.append(entry);
  }
}

async function submitRound(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (phase === "flipping" || phase === "connecting" || (!pending && !validAmount())) return;
  const round = pending ?? { roundId: crypto.randomUUID(), amount: currentAmount(), choice };
  const recovering = phase === "uncertain";
  if (table.mode === "server") {
    try {
      sessionStorage.setItem(pendingKey(table), JSON.stringify(round));
    } catch {
      feedback(
        "This browser can't save a retry ID.",
        "Allow session storage, then reconnect before wagering server chips."
      );
      return;
    }
  }
  pending = round;
  phase = "flipping";
  feedback(
    recovering ? "Checking your round…" : "Here we go!",
    recovering
      ? "Same wager. Same result. No second charge."
      : `You called ${round.choice}. ${round.amount} chips on the table.`
  );
  render();
  const animation = recovering ? Promise.resolve() : animateToss();
  try {
    let result: z.infer<typeof resultSchema>;
    if (table.mode === "practice") {
      const outcome: CoinSide =
        crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0 ? "heads" : "tails";
      const won = outcome === round.choice;
      result = {
        settled: true,
        chips: table.chips + (won ? round.amount : -round.amount),
        outcome,
        won,
        amount: round.amount,
      };
    } else {
      result = resultSchema.parse(
        await (
          await api("flip", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${table.session}`,
            },
            body: JSON.stringify(round),
          })
        ).json()
      );
    }
    await animation;
    table.chips = result.chips;
    if (!result.settled) {
      stopCoinMotion();
      feedback(
        "That one's still in your pocket.",
        result.reason === "insufficient-funds"
          ? "Not enough chips. Lower your wager, or claim /daily in Discord."
          : "Your balance is too close to the chip limit for this wager."
      );
      text("stage-kicker", "NO WAGER PLACED");
      text("stage-line", "Let's adjust that call.");
    } else {
      await land(result.outcome);
      record(result.outcome);
      stage?.setAttribute("data-result", result.won ? "win" : "miss");
      text("stage-kicker", `${result.outcome.toUpperCase()} IT IS!`);
      text("stage-line", result.won ? "Now that's a good call." : "The coin had other plans.");
      feedback(
        result.won
          ? `Nice call! +${round.amount.toLocaleString("en-US")} chips`
          : `It's ${result.outcome}. −${round.amount.toLocaleString("en-US")} chips`,
        result.won
          ? `${round.amount * 2} returned, including your wager.`
          : "A fair flip. A fresh start whenever you're ready."
      );
      playSound(result.won ? "win" : "miss");
      if (result.won) celebrate();
    }
    if (table.mode === "server") sessionStorage.removeItem(pendingKey(table));
    pending = undefined;
    phase = "ready";
    if (table.chips === 0)
      feedback(
        "Out of chips for now.",
        table.mode === "practice"
          ? "Refill practice chips to keep playing."
          : "Claim /daily in Discord, then reconnect to refresh your balance."
      );
  } catch (error) {
    await animation;
    phase = "uncertain";
    text("stage-kicker", "YOUR ROUND IS SAVED");
    text("stage-line", "Let's check that landing.");
    feedback(
      error instanceof ApiError && error.status === 401
        ? "Reconnect, then check your result."
        : "The result hasn't arrived yet.",
      "Check this same round safely. A retry never places a second wager."
    );
  } finally {
    stage?.classList.remove("tossing", "awaiting");
    render();
  }
}

heads.addEventListener("click", () => {
  choice = "heads";
  playSound("pick");
  render();
});
tails.addEventListener("click", () => {
  choice = "tails";
  playSound("pick");
  render();
});
amount.addEventListener("input", () => {
  if (!validAmount())
    feedback(
      "Pick a whole-number wager.",
      `Choose between 1 and ${Math.min(table.chips, maxStake)} chips.`
    );
  else feedback("Your call. The coin's move.", "Pick a side, send it skyward.");
  render();
});
element("less", HTMLButtonElement).addEventListener("click", () => {
  amount.value = String(Math.max(1, (Number.isFinite(currentAmount()) ? currentAmount() : 1) - 5));
  render();
});
element("more", HTMLButtonElement).addEventListener("click", () => {
  amount.value = String(
    Math.min(table.chips, maxStake, (Number.isFinite(currentAmount()) ? currentAmount() : 0) + 5)
  );
  render();
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-amount]"))
  button.addEventListener("click", () => {
    amount.value = button.dataset.amount ?? "10";
    playSound("pick");
    render();
  });
form.addEventListener("submit", submitRound);
connect.addEventListener("click", () => {
  if (table.mode === "server" && phase === "ready") {
    table = { mode: "practice", chips: 100 };
    feedback(
      "Practice table is open.",
      "These chips are only for fun. Your server balance is separate."
    );
    render();
  } else void connectServer();
});
refill.addEventListener("click", () => {
  if (table.mode === "practice" && phase === "ready") {
    table.chips = 100;
    amount.value = "10";
    feedback("A fresh pocket of practice chips.", "Ready when you are.");
    render();
  }
});
sound.addEventListener("click", async () => {
  soundEnabled = !soundEnabled;
  try {
    if (soundEnabled) {
      audio ??= new AudioContext();
      await audio.resume();
    } else if (audio) await audio.suspend();
  } catch {
    soundEnabled = false;
    feedback("Sound isn't available here.", "You can still enjoy every flip.");
  }
  sound.setAttribute("aria-pressed", String(soundEnabled));
  sound.setAttribute("aria-label", soundEnabled ? "Turn sound off" : "Turn sound on");
  sound.title = soundEnabled ? "Turn sound off" : "Turn sound on";
  playSound("pick");
});
motion.addEventListener("click", () => {
  reducedMotion = !reducedMotion;
  setMotion();
});
motionPreference.addEventListener("change", () => {
  reducedMotion = motionPreference.matches;
  setMotion();
});
element("help", HTMLButtonElement).addEventListener("click", () => rules.showModal());
element("close-rules", HTMLButtonElement).addEventListener("click", () => rules.close());
window.addEventListener("offline", () => {
  if (table.mode === "server")
    feedback(
      "You're offline.",
      pending
        ? "Reconnect, then check your saved round."
        : "Reconnect before wagering server chips."
    );
});
setMotion();
render();
if (embedded) void connectServer();
