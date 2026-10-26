import { listen } from "@tauri-apps/api/event";
import { api, QuickEvent } from "./api";

export type ChatHost = "claude" | "gemini" | "chatgpt";
export const CHAT_NAME: Record<ChatHost, string> = { claude: "Claude", gemini: "Gemini", chatgpt: "ChatGPT" };

export class ChatError extends Error {
  constructor(
    readonly code: string,
    readonly url: string | null,
    host: ChatHost,
  ) {
    super(chatErrorText(code, CHAT_NAME[host]));
  }
}

function chatErrorText(code: string, name: string): string {
  if (code === "signin") return `Sign in to ${name} once in the Ask panel (Ctrl+J); quick questions use the same login.`;
  if (code === "nobox") return `${name}'s page didn't show a message box. Open the Ask panel to see why.`;
  if (code === "noreply") return `${name} didn't answer. Open the Ask panel to see what happened.`;
  if (code === "unsaved") return "This note isn't saved yet, so it can't be attached.";
  return code;
}

/** A path the chat can attach: a saved `.note` file, not a blank path or a folder. */
export function savableNotePath(path: string): boolean {
  const p = path.trim();
  if (!p || p.includes("\0")) return false;
  return /[\\/]/.test(p) && /\.note$/i.test(p);
}

/** New background conversations use the site's private mode (kept out of its history). */
export function privateChats(): boolean {
  return localStorage.getItem("pl.quick.private") !== "off";
}

export function setPrivateChats(on: boolean) {
  localStorage.setItem("pl.quick.private", on ? "on" : "off");
}

/**
 * Asks a supported chat site through your web login, in a view the app keeps out of sight, and
 * streams the reply as Markdown. `fresh` starts a new conversation, private when
 * `privateChats()` is on. Aborting stops the reply and resolves with what arrived.
 */
export async function askInBackground(opts: {
  host: ChatHost;
  text: string;
  fresh: boolean;
  signal?: AbortSignal;
  notePaths?: string[];
  onText: (soFar: string) => void;
}): Promise<{ text: string; url: string | null }> {
  let notePaths = opts.notePaths;
  if (notePaths?.length) {
    const ok = notePaths.map((p) => p.trim()).filter(savableNotePath);
    if (!ok.length) throw new ChatError("unsaved", null, opts.host);
    notePaths = ok;
  }
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  let off: (() => void) | null = null;
  const done = new Promise<{ text: string; url: string | null }>((resolve, reject) => {
    void listen<QuickEvent>("quick", ({ payload }) => {
      if (payload.id !== id) return;
      if (payload.text) opts.onText(payload.text);
      if (!payload.done) return;
      off?.();
      if (payload.error) reject(new ChatError(payload.error, payload.url, opts.host));
      else resolve({ text: payload.text, url: payload.url });
    }).then((unlisten) => {
      off = unlisten;
      opts.signal?.addEventListener("abort", () => void api.quickStop());
      api.quickAsk(id, opts.host, opts.text, opts.fresh, privateChats(), notePaths).catch((e) => {
        unlisten();
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  });
  return done;
}
