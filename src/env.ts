// oxlint-disable-next-line typescript/triple-slash-reference -- Wrangler emits global Worker declarations.
/// <reference path="../worker-configuration.d.ts" />

export interface Env extends Cloudflare.Env {
  GEMINI_API_KEY?: string;
  NODE_ENV?: string;
}
