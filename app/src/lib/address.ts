// The address string, and the guarantee that what is copied is what was given.
//
// ── WHY THIS MODULE EXISTS ────────────────────────────────────────────────────
//
// A report came back from a real iPhone: an address copied from the token page and pasted
// into Notes contained `-` characters that are not in the address. An Arc address is `0x`
// plus 40 hex characters -- 42 exactly -- and a corrupted one sends funds nowhere, or
// worse, somewhere.
//
// ⚠ THE PROPOSED CAUSE WAS CSS HYPHENATION, AND THAT IS RULED OUT. Measured in a real
// browser engine, not reasoned about:
//
//   * No `hyphens` rule exists anywhere in the app's CSS, and the computed value on both
//     address elements is `manual` (the initial value), not `auto`.
//   * There is no U+00AD anywhere in the source.
//   * With `hyphens: auto` FORCIBLY injected and confirmed applied (computed value read
//     back as `auto` while live), the element re-wrapped -- and a real `Selection`
//     serialised to 42 characters matching /^0x[0-9a-fA-F]{40}$/ with zero hyphens.
//
// That last point is the general rule and the reason this file leads with it: **a
// CSS-inserted hyphen is a rendering artifact and is not part of the text.** It is absent
// from `textContent`, absent from a `Selection`, and absent from the clipboard. So CSS
// hyphenation cannot produce the reported symptom even when it is switched on.
//
// ── WHAT THIS MODULE ACTUALLY DEFENDS ─────────────────────────────────────────
//
// Since the corruption cannot come from CSS, the remaining surface is the *copy path*.
// The header address had a copy button that writes the raw string; the CREATOR field had
// NO copy affordance at all, so the only way to get it was to hand-select 42 characters
// wrapped across four lines on a phone -- and on iOS, long-pressing a link offers "Copy"
// which yields the HREF (an explorer URL), not the address text.
//
// So the fix is to make a verbatim copy always available, and to pin -- in a test -- that
// what the button writes is character-identical to what it was given. That is the property
// that actually protects a user, and unlike a CSS assertion it can be checked without a
// layout engine.

/** `0x` plus exactly 40 hex characters. Nothing else is an address. */
export const EXACT_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export const ADDRESS_LENGTH = 42;

/**
 * Characters that must never appear in a rendered or copied address.
 *
 * Soft hyphen and zero-width space are the invisible ones -- they survive a paste and are
 * undetectable by eye, which is what makes them dangerous rather than merely wrong. The
 * visible dashes are here because the bug report described seeing them.
 */
export const FORBIDDEN_IN_ADDRESS = [
  "­", // soft hyphen
  "​", // zero-width space
  "‌", // zero-width non-joiner
  "‍", // zero-width joiner
  "‐", // hyphen
  "‑", // non-breaking hyphen
  "‒", // figure dash
  "–", // en dash
  "—", // em dash
  "-", // ASCII hyphen-minus
  " ", // any whitespace at all
  "\n",
] as const;

export function isExactAddress(s: string): boolean {
  return EXACT_ADDRESS_RE.test(s);
}

/** Every forbidden character present in `s`, as U+XXXX labels. Empty when clean. */
export function forbiddenCharsIn(s: string): string[] {
  const found = new Set<string>();
  for (const ch of s) {
    if ((FORBIDDEN_IN_ADDRESS as readonly string[]).includes(ch)) {
      found.add("U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"));
    }
  }
  return [...found];
}

/**
 * What goes on the clipboard for `addr`.
 *
 * ⚠ THIS IS DELIBERATELY AN IDENTITY FUNCTION, AND IT MUST STAY ONE. It exists as a named
 * seam so a test can assert -- against the real code path, not a copy of it -- that the
 * copy button writes the address unmodified. Any "helpful" transformation here (lower-
 * casing, checksumming, grouping into chunks, inserting separators for readability) is a
 * bug that ships a different address than the one displayed, which is the exact failure
 * this module was created to rule out.
 *
 * It throws rather than returning something wrong: a copy button that silently puts a
 * malformed address on the clipboard is worse than one that does nothing, because the user
 * has already looked away by the time they paste.
 */
export function clipboardTextFor(addr: string): string {
  if (!isExactAddress(addr)) {
    throw new Error(
      `refusing to copy a malformed address (${addr.length} chars, expected ${ADDRESS_LENGTH})`
    );
  }
  return addr;
}
