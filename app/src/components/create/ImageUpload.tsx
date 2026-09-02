// Pick an image, upload it, get an `ipfs://` URI back.
//
// Sits alongside the URL field rather than replacing it: a creator who already has a
// hosted image should not be forced to re-upload it, and a creator with a picture on
// their phone should not be asked to go and find hosting. Both paths write the same
// `imageUri` state, so everything downstream is unchanged.
//
// ⚠ NO WALLET GATE, DELIBERATELY. Requiring a signature to pick an image asks the user to
// approve a cryptographic prompt for something that is not a transaction -- the exact
// pattern users are correctly taught to treat as phishing. It also buys nothing: a
// connected address costs nothing to acquire, so it gates no attacker, and it moves the
// connect step in front of a creator who is still deciding whether to launch at all.

import { useRef, useState } from "react";
import { useT } from "../../i18n";
import { resolveMediaUri } from "../../lib/ipfs";
import {
  ALLOWED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  uploadImage,
  validateImageFile,
  type UploadIssue,
} from "../../lib/upload";

type State =
  | { kind: "idle" }
  | { kind: "busy"; phase: "signing" | "uploading"; preview: string }
  | { kind: "done"; uri: string; preview: string }
  | { kind: "failed"; message: string };

export function ImageUpload({
  value,
  onChange,
}: {
  value: string;
  onChange: (uri: string) => void;
}) {
  const { t, fmt } = useT();
  const [state, setState] = useState<State>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  // Abort an in-flight upload if a second file is picked, so a slow first upload cannot
  // land after a faster second one and overwrite it.
  const abortRef = useRef<AbortController | null>(null);

  function issueMessage(issue: UploadIssue): string {
    switch (issue.kind) {
      case "tooLarge":
        return t("create.uploadTooLarge", {
          size: fmt.bytes(issue.bytes),
          max: fmt.bytes(issue.max),
        });
      case "badType":
        return t("create.uploadBadType", { type: issue.type });
      case "empty":
        return t("create.uploadEmpty");
    }
  }

  /**
   * ⚠ Every branch here produces a DISTINCT message. An earlier version of the create
   * flow collapsed several failures into one silent `catch {}`, and CLAUDE.md §11.15 is
   * explicit about what that cost: "an error we swallow is a bug we cannot see". The two
   * hops fail for unrelated reasons -- ours means the deployment is misconfigured,
   * Pinata's means the file was rejected -- and the creator can act on exactly one of them.
   */
  function errorMessage(e: unknown): string {
    const code = e instanceof UploadError ? e.code : "";
    if (code === "sign:not_configured") return t("create.uploadNotConfigured");
    if (code === "sign:too_large") return t("create.uploadTooLargeServer");
    if (code.startsWith("sign:")) return t("create.uploadSignFailed");
    if (code === "pinata:no_cid" || code === "pinata:http_401" || code === "pinata:http_403") {
      return t("create.uploadRejected");
    }
    if (code.startsWith("pinata:")) return t("create.uploadFailed");
    return t("create.uploadFailed");
  }

  async function onPick(file: File | undefined) {
    if (!file) return;

    const issue = validateImageFile(file);
    if (issue) {
      setState({ kind: "failed", message: issueMessage(issue) });
      return;
    }

    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    // A local object URL renders instantly, so the creator sees their picture during the
    // upload rather than a spinner over an empty box.
    const preview = URL.createObjectURL(file);
    setState({ kind: "busy", phase: "signing", preview });

    try {
      const { uri } = await uploadImage(file, {
        signal: ctl.signal,
        onPhase: (phase) => setState({ kind: "busy", phase, preview }),
      });
      onChange(uri);
      setState({ kind: "done", uri, preview });
    } catch (e) {
      if (ctl.signal.aborted) return; // superseded by a newer pick; not a failure
      URL.revokeObjectURL(preview);
      setState({ kind: "failed", message: errorMessage(e) });
    }
  }

  // Once uploaded we show the LOCAL preview, not the gateway URL. The gateway may not
  // serve a just-pinned CID for a little while (see lib/ipfs.ts), and a broken image
  // immediately after a successful upload reads as a failed upload.
  const localPreview = state.kind === "busy" || state.kind === "done" ? state.preview : null;
  const remotePreview = resolveMediaUri(value);
  const shown = localPreview ?? remotePreview;

  const busy = state.kind === "busy";

  return (
    <div className="field">
      <span className="field-label">{t("create.image")}</span>

      <div className="upload-row">
        {shown ? (
          <img className="upload-preview" src={shown} alt={t("create.imagePreviewAlt")} />
        ) : (
          <div className="upload-preview upload-preview-empty" aria-hidden="true">
            <span>◈</span>
          </div>
        )}

        <div className="upload-controls">
          <input
            ref={inputRef}
            type="file"
            className="upload-input"
            accept={ALLOWED_MIME_TYPES.join(",")}
            onChange={(e) => {
              void onPick(e.target.files?.[0]);
              // Reset so picking the SAME file again re-fires change (after a failure,
              // re-selecting the identical file is the obvious retry and must work).
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy
              ? state.phase === "signing"
                ? t("create.uploadPreparing")
                : t("create.uploadUploading")
              : shown
                ? t("create.uploadReplace")
                : t("create.uploadChoose")}
          </button>

          <span className="hint">
            {t("create.uploadHint", { max: fmt.bytes(MAX_UPLOAD_BYTES) })}
          </span>
        </div>
      </div>

      {state.kind === "failed" && (
        // Not auto-dismissed. A reason that disappears is a reason nobody reads.
        <span className="upload-error" role="alert">
          {state.message}
        </span>
      )}

      {/* The URL field stays reachable. After an upload it holds the ipfs:// URI, which is
          exactly what goes on chain -- shown rather than hidden so the creator can see and
          copy what they are about to publish. */}
      <input
        className="input upload-uri"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (state.kind !== "idle") setState({ kind: "idle" });
        }}
        placeholder={t("create.uriPlaceholder")}
        aria-label={t("create.imageUriLabel")}
      />
    </div>
  );
}
