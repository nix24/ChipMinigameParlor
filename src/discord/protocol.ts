export const InteractionType = { Ping: 1, ApplicationCommand: 2, MessageComponent: 3 } as const;
export const ResponseType = {
  Pong: 1,
  ChannelMessage: 4,
  DeferredChannelMessage: 5,
  UpdateMessage: 7,
} as const;

export interface DiscordUser {
  id: string;
  username?: string;
}
export interface DiscordInteraction {
  id: string;
  token: string;
  type: number;
  guild_id?: string;
  channel_id?: string;
  member?: { user: DiscordUser };
  user?: DiscordUser;
  data?: {
    id?: string;
    name?: string;
    custom_id?: string;
    options?: Array<{ name: string; value: string | number | boolean }>;
  };
}

export interface InteractionResponse {
  type: number;
  data?: { content?: string; flags?: number; components?: DiscordComponent[] };
}

export interface DiscordComponent {
  type: 1 | 2;
  components?: DiscordComponent[];
  style?: 1 | 2 | 3 | 4;
  label?: string;
  custom_id?: string;
  disabled?: boolean;
}

export function userId(interaction: DiscordInteraction): string | undefined {
  return interaction.member?.user.id ?? interaction.user?.id;
}

export function message(content: string, ephemeral = false): InteractionResponse {
  const data: NonNullable<InteractionResponse["data"]> = { content };
  if (ephemeral) data.flags = 64;
  return { type: ResponseType.ChannelMessage, data };
}

export function json(response: InteractionResponse): Response {
  return Response.json(response);
}

function hexBytes(value: string, expectedBytes: number): ArrayBuffer {
  if (!new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`, "i").test(value))
    throw new Error("Discord signature material has an invalid hexadecimal length.");
  const bytes = new Uint8Array(expectedBytes);
  for (let index = 0; index < expectedBytes; index += 1)
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}

function encodedBytes(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export async function verifyDiscordRequest(
  request: Request,
  publicKey: string
): Promise<string | undefined> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) return undefined;
  const body = await request.text();
  const key = await crypto.subtle.importKey("raw", hexBytes(publicKey, 32), "Ed25519", false, [
    "verify",
  ]);
  const signatureBytes = hexBytes(signature, 64);
  const valid = await crypto.subtle.verify(
    "Ed25519",
    key,
    signatureBytes,
    encodedBytes(timestamp + body)
  );
  return valid ? body : undefined;
}
