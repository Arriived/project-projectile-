// The Ballista mark: a bow and arrow, as one inline SVG.
//
// ── ⚠ WHY INLINE SVG AND NOT A RASTER ────────────────────────────────────────────────
//
// `stroke="currentColor"` means ONE asset serves both themes and inherits the palette
// automatically. A PNG would need two files — the mark is near-black on the light ground
// and near-white on the dark one — plus a rule to swap them, which is a theme-switch bug
// waiting to happen and a second thing to forget when §11.9's tokens change. It also
// scales without a 2x/3x set.
//
// The supplied raster assets were checked before this was written rather than assumed:
// `public/android-chrome-192x192.png`, `favicon-32x32.png` and `ballista-logo.png` are all
// **94.9%/90.9%/96.0% fully transparent with ZERO opaque white pixels**. They do NOT carry
// a white box — they render on white in a previewer because previewers composite alpha
// onto white. So the favicon set needed no repair and still carries this same drawing;
// the header and the browser tab agree.
//
// ── ⚠ THE STROKE IS HEAVIER THAN THE ORIGINAL DRAWING, ON PURPOSE ────────────────────
//
// The source mark is a fine-line illustration drawn for large display: measured against
// it, matching its line weight in a 24-unit viewBox needs a stroke-width near 0.35, which
// at the 22px header size renders as a THIRD of a pixel and disappears. Icon versions of a
// logo are routinely weighted up; the SHAPE is faithful and the weight is set so the mark
// survives at the size it is actually used. Judged at 22px in the real header, not at
// 340px in isolation, because 340px flatters a weight that vanishes small.
//
// ── ⚠ WHAT NOT TO DO ─────────────────────────────────────────────────────────────────
//
// Do not give this a hardcoded colour, and do not "fix" transparency by painting the
// background to match the page — the dark ground is a token (§11.9) and changes; a matched
// background becomes a visible box the moment it does. `fill="none"` plus `currentColor`
// has neither problem.

/**
 * @param size  rendered px. 22 in the header; larger reads fine, below ~16 the fletching
 *              merges (true of the original drawing too).
 * @param title accessible name. Omitted here because the header wraps it in a link that
 *              already carries `aria-label="Ballista"` — two names on one control is
 *              worse than one. Pass it only when the mark stands alone.
 */
export function Logo({
  size = 22,
  title,
  className,
}: {
  size?: number;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative when the wrapping link names it; a real image when `title` is given.
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {/* the bow */}
      <path d="M5.2 7.2 A 10 10 0 0 1 14.4 21.6" />
      {/* the arrow: shaft, open head, three fletching strokes */}
      <path d="M3.0 21.0 L21.2 2.8" />
      <path d="M15.6 3.2 L21.2 2.8 L20.8 8.4" />
      <path d="M2.1 20.3 L6.7 18.9" />
      <path d="M4.0 18.4 L8.6 17.0" />
      <path d="M5.9 16.5 L10.5 15.1" />
    </svg>
  );
}
