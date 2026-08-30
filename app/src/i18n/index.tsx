// The i18n runtime. ~1 kB, built on Intl.
//
// Chosen over react-i18next after measuring: react-i18next + i18next added
// +51.5 kB raw / +17.1 kB gzip to this bundle (200.25 -> 217.34 gzip). The two genuinely
// hard parts -- plural selection and locale-aware number formatting -- are
// Intl.PluralRules and Intl.NumberFormat, which are in the platform and which we need
// regardless of library. i18next's real value is its ecosystem (backends, detectors,
// translator platforms), none of which we use, and the key-parity build check is ours to
// write either way.
//
// Revisit that if we pass ~500 strings, need translator-platform integration, or need
// namespace lazy-loading. 17 kB gzip is a fair price for those; it is not for this.

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { en, type Messages } from "./en";
import { zhHans } from "./zh-Hans";
import { ko } from "./ko";
import {
  DEFAULT_LOCALE,
  INTL_TAG,
  SHIPPED_LOCALES,
  isShipped,
  type Locale,
  type ShippedLocale,
} from "./locales";
import * as fmt from "./format";

/**
 * Non-English locales are DEEP-PARTIAL while they are being translated. Any key not yet
 * present falls back to English rather than rendering a key or blank -- a half-translated
 * page is bad, a page showing `trade.priceImpact` is worse.
 *
 * This is why a locale must be moved into SHIPPED_LOCALES explicitly: the fallback makes
 * an incomplete locale *look* fine, so completeness is enforced at build time instead of
 * being noticed by eye.
 */
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type PartialMessages = DeepPartial<Messages>;

const CATALOGUES: Record<Locale, Messages | PartialMessages> = {
  en,
  "zh-Hans": zhHans,
  ko,
};

/** Dotted key paths into Messages, derived so a typo is a compile error. */
type Paths<T, Prefix extends string = ""> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : Paths<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

export type MessageKey = Paths<Messages>;

function lookup(cat: unknown, path: string): string | undefined {
  const v = path.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], cat);
  return typeof v === "string" ? v : undefined;
}

/** `{name}` interpolation. Values are inserted verbatim; React escapes on render. */
function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, k: string) =>
    k in vars ? String(vars[k]) : whole
  );
}


// ── Pseudo-locales, for LAYOUT testing ─────────────────────────────────────────
//
// Chinese renders considerably SHORTER than English and Korean usually LONGER, so a
// layout that survives its English label proves nothing about either. The requirement is
// to test against the longest expected string, and there are two useful senses of that:
//
//   ?pseudo=long    the longest string ACTUALLY present across all locale files for each
//                   key. Truthful, and becomes more useful as translations land -- but
//                   near-useless today, because zh and ko are 5% translated and English
//                   is longest for almost everything.
//
//   ?pseudo=expand  English padded to ~1.4x with visible filler. A synthetic stand-in for
//                   Korean expansion that WORKS TODAY, before any Korean exists. This is
//                   the one to use for sizing buttons and table cells now.
//
// Both are opt-in via query string and never affect a real user.
export type PseudoMode = "long" | "expand" | null;

function readPseudo(): PseudoMode {
  try {
    const v = new URLSearchParams(window.location.search).get("pseudo");
    return v === "long" || v === "expand" ? v : null;
  } catch {
    return null;
  }
}

/** Widest characters first, so the padding costs real horizontal space. */
const PAD = "█▓▒░";

function pseudoString(key: string, mode: PseudoMode): string | undefined {
  const base = lookup(en, key);
  if (base === undefined) return undefined;
  if (mode === "long") {
    let longest = base;
    for (const cat of Object.values(CATALOGUES)) {
      const v = lookup(cat, key);
      if (typeof v === "string" && v.length > longest.length) longest = v;
    }
    return longest;
  }
  // expand: keep every {placeholder} intact so interpolation still works, and append
  // filler proportional to the original length.
  const extra = Math.max(3, Math.round(base.length * 0.4));
  return `${base} ${PAD.repeat(Math.ceil(extra / PAD.length)).slice(0, extra)}`;
}

type Ctx = {
  locale: ShippedLocale;
  setLocale: (l: ShippedLocale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** Plural selection via Intl.PluralRules -- correct for en (2 forms), zh and ko (1). */
  plural: (n: number, forms: Partial<Record<Intl.LDMLPluralRule, string>>) => string;
  fmt: {
    usdc: (usdc6: bigint, dp?: number) => string;
    usd: (usdc6: bigint) => string;
    token: (token18: bigint) => string;
    pct: (pct: number, dp?: number) => string;
    bps: (bps: number) => string;
    age: (when: string | number | bigint) => string;
  };
};

const I18nCtx = createContext<Ctx | null>(null);

const STORAGE_KEY = "ballista.locale";

function detectInitial(): ShippedLocale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved && isShipped(saved)) return saved;
  } catch {
    /* storage blocked; fall through to navigator */
  }
  for (const nav of navigator.languages ?? []) {
    const base = nav.toLowerCase();
    // Only offer what is actually SHIPPED. A browser set to Korean gets English until
    // the Korean catalogue is complete, rather than a half-translated page.
    for (const l of SHIPPED_LOCALES) {
      if (base === l.toLowerCase() || base.startsWith(`${l.toLowerCase()}-`)) return l;
    }
    if (base.startsWith("zh") && isShipped("zh-Hans")) return "zh-Hans" as ShippedLocale;
  }
  return DEFAULT_LOCALE;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<ShippedLocale>(detectInitial);
  const pseudo = useMemo(readPseudo, []);

  const value = useMemo<Ctx>(() => {
    const setLocale = (l: ShippedLocale) => {
      setLocaleState(l);
      try {
        window.localStorage.setItem(STORAGE_KEY, l);
      } catch {
        /* storage blocked; the choice simply does not persist */
      }
      document.documentElement.lang = INTL_TAG[l];
    };

    const t = (key: MessageKey, vars?: Record<string, string | number>) => {
      const hit = pseudo
        ? pseudoString(key, pseudo)
        : (lookup(CATALOGUES[locale], key) ?? lookup(en, key));
      // A missing key in English is a bug the type system should have caught. Surface the
      // key rather than an empty string so it is obvious rather than invisible.
      return interpolate(hit ?? key, vars);
    };

    const pr = new Intl.PluralRules(INTL_TAG[locale]);
    const plural: Ctx["plural"] = (n, forms) =>
      forms[pr.select(n)] ?? forms.other ?? "";

    return {
      locale,
      setLocale,
      t,
      plural,
      fmt: {
        usdc: (v, dp) => fmt.formatUsdc(locale, v, dp),
        usd: (v) => fmt.formatUsd(locale, v),
        token: (v) => fmt.formatToken(locale, v),
        pct: (v, dp) => fmt.formatPct(locale, v, dp),
        bps: (v) => fmt.formatBps(locale, v),
        age: (v) => fmt.formatAge(locale, v),
      },
    };
  }, [locale, pseudo]);

  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export function useT(): Ctx {
  const v = useContext(I18nCtx);
  if (!v) throw new Error("useT must be used inside <I18nProvider>");
  return v;
}
