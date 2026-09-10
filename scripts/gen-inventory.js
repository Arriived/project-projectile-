// Generates CONTRACT_INVENTORY.md from the compiled artifacts and the source.
//
// WHY THIS EXISTS. A five-minute symbol lock lived in LFX1.sol and appeared nowhere in
// CLAUDE.md: a 437-line rewrite of a hand-maintained document dropped a real contract
// feature, silently, and nothing could have caught it. A hand-maintained inventory rots
// the moment someone edits the contract. A generated one cannot: it is rebuilt from the
// ABI and the source every time, and `npm run inventory` is wired into `npm run build`.
//
// It also reports COVERAGE: every identifier the contract exposes that CLAUDE.md never
// mentions. That list is the thing to look at after any contract change.
//
//   node scripts/gen-inventory.js          # write CONTRACT_INVENTORY.md
//   node scripts/gen-inventory.js --check  # exit 1 if the file is out of date
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "CONTRACT_INVENTORY.md");
// ⚠ ALL FIVE PRODUCTION CONTRACTS. This listed only LFX1 and LFX1Token until 10 September
// 2026, so the adapter, the hook and the corrector -- the hook above all, immutable and
// ownerless and on every swap for ever -- sat outside the one mechanism that exists to
// catch an exposed identifier CLAUDE.md never explains (CLAUDE.md §21.10 item 6).
// GraduationHelper is deliberately absent: inert on testnet and not in the v4 stack.
const TARGETS = [
  ["LFX1", "contracts/LFX1.sol", "artifacts/contracts/LFX1.sol/LFX1.json"],
  ["LFX1Token", "contracts/LFX1Token.sol", "artifacts/contracts/LFX1Token.sol/LFX1Token.json"],
  ["BallistaV4Adapter", "contracts/BallistaV4Adapter.sol", "artifacts/contracts/BallistaV4Adapter.sol/BallistaV4Adapter.json"],
  ["BallistaFeeHook", "contracts/BallistaFeeHook.sol", "artifacts/contracts/BallistaFeeHook.sol/BallistaFeeHook.json"],
  ["BallistaPoolCorrector", "contracts/BallistaPoolCorrector.sol", "artifacts/contracts/BallistaPoolCorrector.sol/BallistaPoolCorrector.json"],
];

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function sigOf(item) {
  const args = (item.inputs || []).map((i) => `${i.type} ${i.name}`.trim()).join(", ");
  const rets = (item.outputs || []).map((o) => o.type).join(", ");
  return `${item.name}(${args})${rets ? ` -> (${rets})` : ""}`;
}

// Source-derived facts the ABI cannot give: owner gating, declared defaults, constants.
function sourceFacts(src) {
  const ownerOnly = new Set();
  const fnRe = /function\s+(\w+)\s*\(([^)]*)\)([^{;]*)/g;
  let m;
  while ((m = fnRe.exec(src))) {
    if (/onlyOwner/.test(m[3])) ownerOnly.add(m[1]);
  }

  const consts = new Map();
  const constRe = /^\s*(?:uint\d*|int\d*|address|bool|bytes\d*|string)\s+(?:public\s+)?constant\s+(\w+)\s*=\s*([^;]+);/gm;
  while ((m = constRe.exec(src))) consts.set(m[1], m[2].trim());

  const defaults = new Map();
  const varRe = /^\s*(uint\d*|int\d*|address|bool|bytes\d*|string)\s+public\s+(?!constant|immutable)(\w+)\s*=\s*([^;]+);/gm;
  while ((m = varRe.exec(src))) defaults.set(m[2], { type: m[1], value: m[3].trim() });

  const noDefault = new Map();
  const bareRe = /^\s*(uint\d*|int\d*|address|bool|bytes\d*|string|mapping\([^)]*\)[^ ]*)\s+public\s+(?:immutable\s+)?(\w+)\s*;/gm;
  while ((m = bareRe.exec(src))) noDefault.set(m[2], m[1]);

  // Which state vars feed currentEconomicsHash()?
  const hashBody = (src.match(/function currentEconomicsHash\(\)[\s\S]*?\n    \}/) || [""])[0];
  const hashed = new Set(
    [...hashBody.matchAll(/^\s{12}(\w+),?$/gm)].map((x) => x[1])
  );

  // ⚠ ACCESS, AS FAR AS THIS FILE CAN SEE -- AND NO FURTHER.
  //
  // This reads ONE source file. A function, error or event inherited from another file has
  // its gate, its revert and its emit THERE: Ownable's `transferOwnership` is onlyOwner in
  // Ownable.sol, and BaseHook's ten IHooks callbacks are onlyPoolManager in BaseHook.sol.
  // Until 10 September 2026 anything without `onlyOwner` in this file was printed
  // "Permissionless" -- which called transferOwnership permissionless (R17's unguarded
  // path) and would have called every hook callback permissionless too -- and any error or
  // event not raised in this file was printed "never thrown" / "never emitted". So: report
  // what this file shows, its modifiers and any inline `msg.sender` comparison, and say
  // "inherited" for the rest.
  const declared = new Map();
  const NOT_MODIFIERS = new Set([
    "external", "public", "internal", "private", "view", "pure", "payable", "virtual",
    "override", "returns",
  ]);
  const declRe = /function\s+(\w+)\s*\(([^)]*)\)([^{;]*)\{/g;
  while ((m = declRe.exec(src))) {
    const tail = m[3].replace(/returns\s*\([^)]*\)/g, "").replace(/override\s*\([^)]*\)/g, "");
    const modifiers = (tail.match(/[A-Za-z_]\w*/g) || []).filter((t) => !NOT_MODIFIERS.has(t));
    let depth = 0;
    let end = m.index + m[0].length - 1; // the opening brace
    for (; end < src.length; end++) {
      if (src[end] === "{") depth++;
      else if (src[end] === "}" && --depth === 0) break;
    }
    const body = src
      .slice(m.index + m[0].length, end)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const checksSender = /msg\.sender\s*[!=]=|[!=]=\s*msg\.sender/.test(body);
    declared.set(m[1], { modifiers, checksSender });
  }
  const declaresHere = (kind, name) => new RegExp(`\\b${kind}\\s+${name}\\s*\\(`).test(src);

  return { ownerOnly, consts, defaults, noDefault, hashed, declared, declaresHere };
}

function build() {
  const claude = read("CLAUDE.md");
  const missing = [];
  let md = `# Contract inventory — GENERATED, DO NOT HAND-EDIT

Regenerate with \`npm run inventory\`. It runs as part of \`npm run build\`.

This file exists because a five-minute symbol lock lived in \`LFX1.sol\` and appeared
nowhere in \`CLAUDE.md\` — a rewrite of a hand-maintained document dropped a real feature
and nothing caught it. Everything below is read from the compiled ABI and the source at
generation time, so it cannot drift from the contract. **\`CLAUDE.md\` explains WHY things
are the way they are; this file is the exhaustive WHAT.**

The coverage section at the end lists every exposed identifier that \`CLAUDE.md\` does not
mention. That list is what to read after any contract change.

`;

  for (const [name, srcPath, artPath] of TARGETS) {
    const src = read(srcPath);
    const abi = JSON.parse(read(artPath)).abi;
    const f = sourceFacts(src);

    const fns = abi.filter((x) => x.type === "function");
    const getters = fns.filter(
      (x) => x.stateMutability === "view" && (x.inputs || []).length <= 1 &&
        (f.consts.has(x.name) || f.defaults.has(x.name) || f.noDefault.has(x.name))
    );
    const getterNames = new Set(getters.map((g) => g.name));
    const writes = fns.filter((x) => !getterNames.has(x.name) &&
      x.stateMutability !== "view" && x.stateMutability !== "pure");
    const views = fns.filter((x) => !getterNames.has(x.name) &&
      (x.stateMutability === "view" || x.stateMutability === "pure"));

    md += `\n---\n\n## ${name}\n\n`;

    md += `### Constants (immutable by construction — changing one is a redeploy)\n\n`;
    md += `| name | value |\n|---|---|\n`;
    for (const [k, v] of f.consts) md += `| \`${k}\` | \`${v}\` |\n`;

    md += `\n### State variables that govern behaviour\n\n`;
    md += `| name | type | declared default | owner-settable via | in economics hash |\n|---|---|---|---|---|\n`;
    const setters = new Map();
    for (const w of writes) {
      if (!f.ownerOnly.has(w.name)) continue;
      const m = w.name.match(/^set(?:Default)?(.+)$/);
      if (m) setters.set(m[1].toLowerCase().replace(/bps$/, ""), w.name);
    }
    const allVars = new Map([...f.defaults].map(([k, v]) => [k, v]));
    for (const [k, t] of f.noDefault) if (!allVars.has(k)) allVars.set(k, { type: t, value: "—" });
    for (const [k, v] of allVars) {
      const key = k.toLowerCase().replace(/bps$/, "").replace(/^default/, "");
      const setter = setters.get(key) || [...setters.values()].find(
        (s) => s.toLowerCase().includes(k.toLowerCase().replace(/^default/, "").slice(0, 10))
      ) || "—";
      md += `| \`${k}\` | \`${v.type}\` | \`${v.value}\` | ${setter === "—" ? "**no setter — redeploy**" : `\`${setter}\``} | ${f.hashed.has(k) ? "yes" : "no"} |\n`;
    }

    md += `\n### Owner-gated functions\n\n`;
    md += `| function | what it changes |\n|---|---|\n`;
    for (const w of writes.filter((x) => f.ownerOnly.has(x.name))) {
      md += `| \`${sigOf(w)}\` | owner only |\n`;
    }

    // ⚠ NOT "Permissionless" -- see `declared` in sourceFacts. A function can be gated by a
    // modifier or an inline check that this file shows, or by one in a parent it does not.
    md += `\n### State-changing functions without \`onlyOwner\` in this file\n\n`;
    md += `Not the same as permissionless. **inherited** means the function is declared in a parent\n`;
    md += `contract, so its gate lives there and is not read here.\n\n`;
    md += `| function | mutability | modifiers here | compares \`msg.sender\` here |\n|---|---|---|---|\n`;
    for (const w of writes.filter((x) => !f.ownerOnly.has(x.name))) {
      const d = f.declared.get(w.name);
      md += d
        ? `| \`${sigOf(w)}\` | ${w.stateMutability} | ${d.modifiers.length ? d.modifiers.map((x) => `\`${x}\``).join(", ") : "—"} | ${d.checksSender ? "**yes**" : "no"} |\n`
        : `| \`${sigOf(w)}\` | ${w.stateMutability} | **inherited** | **inherited** |\n`;
    }

    md += `\n### Views\n\n`;
    md += `| function |\n|---|\n`;
    for (const v of views) md += `| \`${sigOf(v)}\` |\n`;

    md += `\n### Public getters (state and constants)\n\n`;
    md += getters.map((g) => `\`${g.name}\``).join(", ") + "\n";

    // "never thrown" / "never emitted" only for what THIS file declares. An inherited error or
    // event is raised in its parent -- OZ's Transfer on every token transfer, BaseHook's
    // NotPoolManager on every foreign callback -- and calling it dead would be false.
    const errors = abi.filter((x) => x.type === "error");
    md += `\n### Custom errors (${errors.length})\n\n`;
    md += `| error | thrown where |\n|---|---|\n`;
    for (const e of errors) {
      const lines = src.split("\n")
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => l.includes(`revert ${e.name}(`))
        .map(([i]) => i);
      md += `| \`${sigOf(e)}\` | ${lines.length ? lines.map((l) => `L${l}`).join(", ") : f.declaresHere("error", e.name) ? "**declared here, never thrown here**" : "inherited — not in this file"} |\n`;
    }

    const events = abi.filter((x) => x.type === "event");
    md += `\n### Events (${events.length})\n\n`;
    md += `| event | emitted at |\n|---|---|\n`;
    for (const e of events) {
      const lines = src.split("\n")
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => l.includes(`emit ${e.name}(`))
        .map(([i]) => i);
      md += `| \`${sigOf(e)}\` | ${lines.length ? lines.map((l) => `L${l}`).join(", ") : f.declaresHere("event", e.name) ? "**declared here, never emitted here**" : "inherited — not in this file"} |\n`;
    }

    // Coverage: what CLAUDE.md never mentions.
    const ids = [
      ...fns.map((x) => x.name),
      ...errors.map((x) => x.name),
      ...events.map((x) => x.name),
      ...f.consts.keys(),
      ...allVars.keys(),
    ];
    for (const id of new Set(ids)) {
      if (!claude.includes(id)) missing.push(`${name}.${id}`);
    }
  }

  md += `\n---\n\n## CLAUDE.md coverage\n\n`;
  md += `Identifiers exposed by the contracts that \`CLAUDE.md\` never mentions: **${missing.length}**.\n\n`;
  md += `Not every one needs prose — a getter for a constant that is already described by\n`;
  md += `its constant does not. But anything here that changes BEHAVIOUR and is unexplained\n`;
  md += `is the shape of the symbol-lock gap, and should be read as a candidate.\n\n`;
  md += missing.map((m) => `- \`${m}\``).join("\n") + "\n";

  return { md, missing };
}

const { md, missing } = build();
if (process.argv.includes("--check")) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (current !== md) {
    console.error("CONTRACT_INVENTORY.md is out of date. Run: npm run inventory");
    process.exit(1);
  }
  console.log("CONTRACT_INVENTORY.md is up to date");
} else {
  fs.writeFileSync(OUT, md);
  console.log(`wrote CONTRACT_INVENTORY.md — ${missing.length} identifiers unmentioned in CLAUDE.md`);
}
