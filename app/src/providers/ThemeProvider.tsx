// Light/dark theme.
//
// ⚠ localStorage HERE, sessionStorage FOR SLIPPAGE, AND THE INCONSISTENCY IS DELIBERATE.
//
// A theme is a preference about how the app LOOKS. Someone who picks dark wants it dark
// tomorrow, and having to re-pick it every morning is the bug. So it survives a browser
// restart.
//
// Slippage tolerance is a decision about how a TRADE EXECUTES, and lib/slippage.ts stores
// it in sessionStorage on purpose: a user who set 5% to chase one launch must not find it
// silently still set a week later, because the cost of forgetting is money rather than
// aesthetics. Same mechanism, opposite lifetime, for a reason that is about consequence
// and not about convenience.
//
// If these ever converge on one store, that is a bug in whichever one moved.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "ballista.theme";

/** The OS preference. Only ever the INITIAL value -- the toggle overrides it. */
function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    // Private mode, storage disabled, or a sandboxed frame. Falling back to the system
    // preference is correct; throwing here would take the whole app down over a colour.
    return null;
  }
}

type Ctx = { theme: Theme; toggle: () => void };
const ThemeCtx = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => storedTheme() ?? systemTheme());

  // Stamp the attribute the CSS keys on. `data-theme` on <html> rather than a class, and
  // rather than relying on the media query alone, because the toggle has to be able to
  // override the OS preference in BOTH directions -- a media query can only say "the OS
  // wants dark", never "the user chose light despite that".
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    // Keep the browser chrome in step with the page ground, or the notch area on iOS
    // stays off-white above a dark page.
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#14140f" : "#f3f3f0");
  }, [theme]);

  // Follow the OS only while the user has not chosen. Once they have, their choice wins
  // and this listener must not undo it.
  useEffect(() => {
    if (storedTheme() !== null) return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (storedTheme() === null) setTheme(e.matches ? "dark" : "light");
    };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const toggle = () => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* the choice simply does not persist; the app still switches */
      }
      return next;
    });
  };

  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Ctx {
  const v = useContext(ThemeCtx);
  // A default rather than a throw: the chart reads this and a missing provider must not
  // blank the primary element of the page.
  return v ?? { theme: "light", toggle: () => {} };
}
