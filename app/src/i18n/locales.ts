// Which locales exist, and which are actually SHIPPED.
//
// The distinction is the whole safety property. A locale in SHIPPED_LOCALES is offered to
// users and MUST be complete: the build check (scripts/gen-revert-copy.js --check, via
// verify:i18n) fails if any key -- including every custom error's copy -- is missing from
// it. A locale in PLANNED_LOCALES has a file, may be partially translated, and is not
// offered anywhere in the UI.
//
// Moving a locale from PLANNED to SHIPPED is the single switch that turns enforcement on,
// which is what makes "translated in one language and missing in another" impossible to
// ship rather than merely unlikely. Nobody has to remember to check.

export const SHIPPED_LOCALES = ["en"] as const;

/** Files exist and can be worked on; not offered until moved to SHIPPED_LOCALES. */
export const PLANNED_LOCALES = ["zh-Hans", "ko"] as const;

export const ALL_LOCALES = [...SHIPPED_LOCALES, ...PLANNED_LOCALES] as const;

export type Locale = (typeof ALL_LOCALES)[number];
export type ShippedLocale = (typeof SHIPPED_LOCALES)[number];

export const DEFAULT_LOCALE: ShippedLocale = "en";

/** What each locale is called IN THAT LOCALE, for a language picker. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  "zh-Hans": "简体中文",
  ko: "한국어",
};

/**
 * BCP-47 tags handed to Intl. Distinct from our keys because Intl wants a region for
 * correct compact-notation units -- `zh-Hans` alone is accepted, but `zh-Hans-CN` is
 * unambiguous, and the 万/亿 forms are what we are relying on.
 */
export const INTL_TAG: Record<Locale, string> = {
  en: "en-US",
  "zh-Hans": "zh-Hans-CN",
  ko: "ko-KR",
};

export function isShipped(l: string): l is ShippedLocale {
  return (SHIPPED_LOCALES as readonly string[]).includes(l);
}
