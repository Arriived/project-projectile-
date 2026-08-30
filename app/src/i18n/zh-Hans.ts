// 简体中文 — Simplified Chinese.
//
// NOT YET SHIPPED. Listed in PLANNED_LOCALES, so it is not offered in the UI and the
// build check reports its coverage rather than failing on it. Moving "zh-Hans" into
// SHIPPED_LOCALES turns enforcement on: every key, including all 36 custom-error
// messages, must then be present or the build fails.
//
// Typed as PartialMessages, so any key present here must MATCH English's shape -- a
// misspelled or invented key is a compile error, not a silent fallback.
//
// LAYOUT NOTE: Chinese renders considerably SHORTER than English (commonly 50-70% of the
// character count for the same meaning). Testing a layout against Chinese therefore
// proves nothing about whether it holds. Test against the longest string per key --
// `?pseudo=long` renders exactly that.

import type { PartialMessages } from "./index";

export const zhHans: PartialMessages = {
  common: {
    connectWallet: "连接钱包",
    disconnect: "断开连接",
    copy: "复制",
    copied: "已复制",
    loading: "加载中…",
    retry: "重试",
    explore: "浏览",
  },
  // Everything else falls back to English until translated.
};
