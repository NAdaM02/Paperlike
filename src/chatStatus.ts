import { useSyncExternalStore } from "react";
import { api } from "./api";
import type { ChatHost } from "./chat";

/* Last known sign-in state per chat site. Answers and sign-in errors from any quick question
   update it; the Study menu can also look at the page (chat_status) on request. */

export type SignIn = "in" | "out" | "unknown" | "checking";

const KEY = "pl.chat.signin";
type Saved = Partial<Record<ChatHost, { s: "in" | "out"; at: number }>>;

let state: Record<ChatHost, SignIn> = (() => {
  const base: Record<ChatHost, SignIn> = { claude: "unknown", chatgpt: "unknown", gemini: "unknown" };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved;
    for (const h of Object.keys(base) as ChatHost[]) {
      const v = saved[h];
      // A remembered state goes stale: sessions end. Two weeks, then it shows as not checked.
      if (v && (v.s === "in" || v.s === "out") && Date.now() - v.at < 14 * 86400_000) base[h] = v.s;
    }
  } catch {
    /* nothing saved */
  }
  return base;
})();
const listeners = new Set<() => void>();

export function setSignIn(host: ChatHost, s: SignIn) {
  if (state[host] === s) return;
  state = { ...state, [host]: s };
  if (s === "in" || s === "out") {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Saved;
      saved[host] = { s, at: Date.now() };
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      /* storage full or blocked: the in-memory state still shows */
    }
  }
  listeners.forEach((fn) => fn());
}

export function signInState(): Record<ChatHost, SignIn> {
  return state;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useSignIn(): Record<ChatHost, SignIn> {
  return useSyncExternalStore(subscribe, signInState);
}

/** Look at the chat page now. Opens the hidden view when the Ask pane is not showing that site. */
export async function checkSignIn(host: ChatHost): Promise<SignIn> {
  const before = state[host];
  setSignIn(host, "checking");
  try {
    const s = await api.chatStatus(host);
    setSignIn(host, s === "in" || s === "out" ? s : before === "checking" ? "unknown" : before);
    return state[host];
  } catch {
    setSignIn(host, before === "checking" ? "unknown" : before);
    return state[host];
  } finally {
    void api.quickRelease();
  }
}

export const SIGNIN_LABEL: Record<SignIn, string> = {
  in: "Signed in",
  out: "Sign-in needed",
  unknown: "Not checked yet",
  checking: "Checking…",
};
