// A full address, wrapped for a phone, copied verbatim.
//
// One component for every place a COMPLETE address is shown, so the copy guarantee is
// made once rather than per-site. See `lib/address.ts` for what was measured and why the
// copy path -- not the CSS -- is the thing being defended.
//
// ⚠ THE COPY BUTTON IS NOT OPTIONAL DECORATION. Without it the only way to get the address
// off a phone is to hand-select 42 characters wrapped across four lines, and on iOS a
// long-press on a linked address offers "Copy" that yields the explorer URL instead. The
// button is the difference between a verbatim copy and whatever the platform decides to
// give you.

import { useState } from "react";
import { clipboardTextFor } from "../lib/address";
import { useT } from "../i18n";

export function AddressText({
  address,
  href,
  className = "",
}: {
  address: string;
  /** When given, the address text becomes a link. The copy button still copies the text. */
  href?: string;
  className?: string;
}) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const copy = async () => {
    try {
      // Throws on a malformed address rather than copying it -- see clipboardTextFor.
      await navigator.clipboard.writeText(clipboardTextFor(address));
      setFailed(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context, permission denied) or the address failed its
      // shape check. Say so rather than showing "Copied" for something that did not
      // happen -- the address is on screen in full either way.
      setFailed(true);
      setTimeout(() => setFailed(false), 2500);
    }
  };

  return (
    <span className={`addr-wrap ${className}`}>
      {href ? (
        <a className="addr-full mono" href={href} target="_blank" rel="noreferrer">
          {address}
        </a>
      ) : (
        <code className="addr-full mono">{address}</code>
      )}
      <button className="btn btn-tiny addr-copy" onClick={copy} type="button">
        {failed ? t("common.copyFailed") : copied ? t("common.copied") : t("common.copy")}
      </button>
    </span>
  );
}
