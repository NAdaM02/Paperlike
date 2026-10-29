import { listen } from "@tauri-apps/api/event";
import { api, QuickEvent } from "./api";

export type ChatHost = "claude" | "gemini" | "chatgpt";
export const CHAT_NAME: Record<ChatHost, string> = { claude: "Claude", gemini: "Gemini", chatgpt: "ChatGPT" };
export const CHAT_HOSTS: readonly ChatHost[] = ["claude", "chatgpt", "gemini"];

/* The model new questions go to. The header picker, the quick card and the Ask pane share it. */
const HOST_KEY = "pl.ask.host";
const hostListeners = new Set<() => void>();

export function defaultHost(): ChatHost {
  const saved = localStorage.getItem(HOST_KEY);
  return saved === "gemini" || saved === "chatgpt" ? saved : "claude";
}

export function setDefaultHost(host: ChatHost) {
  if (localStorage.getItem(HOST_KEY) === host) return;
  localStorage.setItem(HOST_KEY, host);
  hostListeners.forEach((fn) => fn());
}

export function subscribeDefaultHost(fn: () => void): () => void {
  hostListeners.add(fn);
  return () => {
    hostListeners.delete(fn);
  };
}

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
  if (code === "noupload")
    return `${name} isn't taking pictures right now, so nothing was sent. You've probably reached its daily upload limit; open ${name} in the Ask panel (Ctrl+J) to check, or switch to another model.`;
  if (code === "nobox") return `${name}'s page didn't show a message box. Open the Ask panel to see why.`;
  if (code === "noreply") return `${name} didn't answer. Open the Ask panel to see what happened.`;
  if (code.startsWith("pageerror:")) {
    const msg = code.slice(10).trim();
    if (/cloudflare|challenge|captcha|verify you are human/i.test(msg)) {
      return `${name} asked for a security check. Open the Ask panel to finish it, then ask again.`;
    }
    return `${name} showed an error: "${msg}". Open the Ask panel to retry there.`;
  }
  if (code === "unsaved") return "This note isn't saved yet, so it can't be attached.";
  // Internal Tauri race — never show the raw "webview already exists" string.
  if (/already exists/i.test(code) || /webview with label/i.test(code)) {
    return `${name} is still opening. Close this card and try again in a moment.`;
  }
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
  /** Extra files (e.g. Analyze PNGs) attached with the question. */
  filePaths?: string[];
  onText: (soFar: string) => void;
  /** The model's visible reasoning so far, when the site shows it. */
  onThinking?: (soFar: string) => void;
}): Promise<{ text: string; url: string | null; thinking: string | null }> {
  let notePaths = opts.notePaths;
  if (notePaths?.length) {
    const ok = notePaths.map((p) => p.trim()).filter(savableNotePath);
    if (!ok.length) throw new ChatError("unsaved", null, opts.host);
    notePaths = ok;
  }
  const filePaths = opts.filePaths?.map((p) => p.trim()).filter(Boolean);
  const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  let off: (() => void) | null = null;
  const cleanReply = (raw: string) =>
    raw
      .replace(/\n*(Just now|Edited|\d+\s*(sec|secs?|seconds?|min|mins?|minutes?|hr|hrs?|hours?)\s*ago)\s*$/gi, "")
      .replace(/\n*Just now\s*$/gi, "")
      .replace(/\n*(?:(?:\S+\s+){0,3}is (?:responding|thinking|typing|writing)|responding|thinking)[.…]*\s*$/gi, "")
      .trim();
  let thinking: string | null = null;
  const done = new Promise<{ text: string; url: string | null; thinking: string | null }>((resolve, reject) => {
    void listen<QuickEvent>("quick", ({ payload }) => {
      if (payload.id !== id) return;
      if (payload.thinking && payload.thinking !== thinking) {
        thinking = payload.thinking;
        opts.onThinking?.(thinking);
      }
      if (payload.text) opts.onText(cleanReply(payload.text));
      if (!payload.done) return;
      off?.();
      if (payload.error) reject(new ChatError(payload.error, payload.url, opts.host));
      else resolve({ text: cleanReply(payload.text), url: payload.url, thinking });
    }).then((unlisten) => {
      off = unlisten;
      opts.signal?.addEventListener("abort", () => void api.quickStop());
      api.quickAsk(id, opts.host, opts.text, opts.fresh, privateChats(), notePaths, filePaths).catch((e) => {
        unlisten();
        const raw = e instanceof Error ? e.message : String(e);
        // Invoke failures (e.g. webview race) should use the same friendly copy as ChatError.
        if (/already exists|webview with label/i.test(raw)) {
          reject(new ChatError(raw, null, opts.host));
        } else {
          reject(e instanceof Error ? e : new Error(raw));
        }
      });
    });
  });
  return done;
}
