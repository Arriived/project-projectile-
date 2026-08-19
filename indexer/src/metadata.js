const MAX_DESCRIPTION_LENGTH = 500;
const MAX_STRING_LENGTH = 200;

/// @notice Strips HTML tags from a string. Not a substitute for output-encoding at
///         render time (React/Next.js already auto-escapes text content by default) —
///         this is a second layer, so a raw value that somehow bypassed the frontend's
///         own escaping still can't carry a script tag through the database.
function stripTags(input) {
  return String(input).replace(/<[^>]*>/g, "").trim();
}

function truncate(input, max) {
  return String(input).slice(0, max);
}

/// @notice Fetches metadataURI and returns a sanitized, bounded record. Never throws —
///         a broken/unreachable/malformed IPFS URI must not stop indexing of the
///         on-chain data, which is the source of truth regardless of whether metadata
///         is available. Returns nulls for anything that couldn't be safely resolved.
async function fetchAndSanitizeMetadata(metadataURI) {
  const fallback = { description: null, logoUrl: null };
  if (!metadataURI || typeof metadataURI !== "string") return fallback;

  // Normalize ipfs:// URIs to a public gateway; leave http(s) URIs as-is.
  const url = metadataURI.startsWith("ipfs://")
    ? `https://ipfs.io/ipfs/${metadataURI.slice("ipfs://".length)}`
    : metadataURI;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return fallback;

    const json = await res.json();
    const description =
      typeof json.description === "string"
        ? truncate(stripTags(json.description), MAX_DESCRIPTION_LENGTH)
        : null;

    let logoUrl = null;
    if (typeof json.logo === "string") {
      const candidate = truncate(json.logo, MAX_STRING_LENGTH);
      // Only accept http(s) or ipfs:// — reject javascript:, data:, or anything else
      // that could be used to smuggle something other than an image reference through.
      if (/^(https?:\/\/|ipfs:\/\/)/i.test(candidate)) {
        logoUrl = candidate;
      }
    }

    return { description, logoUrl };
  } catch (err) {
    console.warn(`Metadata fetch/parse failed for ${metadataURI}: ${err.message}`);
    return fallback;
  }
}

module.exports = { fetchAndSanitizeMetadata };
