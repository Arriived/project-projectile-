// 한국어 — Korean.
//
// NOT YET SHIPPED. Listed in PLANNED_LOCALES, so it is not offered in the UI and the
// build check reports its coverage rather than failing on it. Moving "ko" into
// SHIPPED_LOCALES turns enforcement on: every key, including all 36 custom-error
// messages, must then be present or the build fails.
//
// Typed as PartialMessages, so any key present here must MATCH English's shape.
//
// LAYOUT NOTE: Korean commonly renders LONGER than English -- it is the locale that
// breaks layouts, and it is what buttons and table cells must be sized against. Do not
// size a control to its English label. `?pseudo=long` renders the longest string
// available per key so the worst case is visible without reading Korean.

import type { PartialMessages } from "./index";

export const ko: PartialMessages = {
  common: {
    connectWallet: "지갑 연결",
    disconnect: "연결 해제",
    copy: "복사",
    copied: "복사됨",
    loading: "불러오는 중…",
    retry: "다시 시도",
    explore: "둘러보기",
  },
  // Everything else falls back to English until translated.
};
