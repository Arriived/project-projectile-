// Toasts.
//
// ⚠ WHAT A SUCCESS TOAST IS ALLOWED TO SAY. The settled amount comes from the RECEIPT'S
// OWN EVENT, never from the quote (trap 6). The snipe tax decays per second and the
// partial-fill clamp can bind between quote and execution, so the two genuinely differ --
// and the quote is the number the user was already shown, which makes echoing it as the
// outcome the most misleading option available.
//
// This provider does not know how to read a receipt and must never learn: callers pass a
// string they have already derived from the log. The type exists to make that boundary
// obvious rather than to enforce it.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastKind = "ok" | "bad";

export type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  body?: string;
};

type ToastApi = {
  /** Success. `body` must be receipt-derived, never a quote. */
  ok: (title: string, body?: string) => void;
  /** Failure. `body` should be a decoded custom error where one exists. */
  bad: (title: string, body?: string) => void;
  dismiss: (id: number) => void;
};

const Ctx = createContext<ToastApi | null>(null);

/** Successes clear themselves; failures do NOT — see below. */
const OK_TTL_MS = 6_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, title: string, body?: string) => {
      const id = nextId.current++;
      setToasts((t) => [...t, { id, kind, title, body }]);
      // ⚠ FAILURES ARE NOT AUTO-DISMISSED. A success is a confirmation the user can
      // afford to miss -- the balance and the position both changed and both are on the
      // page. A failure is the only place the reason exists, and a reason that vanishes
      // after six seconds is a reason nobody reads. They stay until dismissed.
      if (kind === "ok") {
        window.setTimeout(() => dismiss(id), OK_TTL_MS);
      }
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      ok: (title, body) => push("ok", title, body),
      bad: (title, body) => push("bad", title, body),
      dismiss,
    }),
    [push, dismiss]
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {/*
        aria-live="polite" so a screen reader announces the outcome without interrupting,
        and role="status" so the region is recognised before any toast exists -- a live
        region added at the same moment as its content is frequently not announced at all.
      */}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "ok" ? "toast-ok" : "toast-bad"}`}>
            <button
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              ✕
            </button>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast outside ToastProvider");
  return c;
}
