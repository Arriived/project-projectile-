// Snipe tax display and countdown.
//
// WHY THIS IS PROMINENT RATHER THAN A FOOTNOTE. The table is
// [9800, 9500, 9000, 8000, 6000, 4000, 2000, 0] basis points, indexed by elapsed SECONDS
// since creation. At t=0 the tax is 98% -- in the opening seconds it is most of what a
// buyer pays. Showing a quote and settling at a different number is the worst thing this
// page can do, and the tax is the single largest reason the two can differ.
//
// The DISPLAYED value comes from `currentSnipeTaxBps(token)` on the contract, never from
// evaluating the table here. Same rule as quotes (trap 1): the contract has a view
// function, so call it. The table is read only to say WHEN the next step happens, which
// the contract does not expose.

/** Seconds until the tax next steps down, and what it steps to. */
export type SnipeSchedule = {
  /** Live tax now, in bps. From the contract. */
  currentBps: number;
  /** Whole seconds until the next step. Null once the table is exhausted. */
  secondsToNextStep: number | null;
  /** The bps value after that step. Null once exhausted. */
  nextBps: number | null;
  /** True while any tax is being charged. */
  active: boolean;
};

/**
 * Build the countdown from the published table and the curve's creation timestamp.
 *
 * @param table            snipeTaxTable(version), bps per elapsed second
 * @param creationTimestamp seconds, from curves().creationTimestamp
 * @param nowSeconds        seconds
 * @param currentBps        from currentSnipeTaxBps(token) -- the contract's own answer
 *
 * The contract's value is trusted over anything derived here. If the two disagree the
 * contract wins and the countdown is suppressed rather than shown alongside a figure it
 * contradicts: a countdown that disagrees with the price charged is worse than none.
 */
export function snipeSchedule(
  table: readonly number[],
  creationTimestamp: bigint,
  nowSeconds: bigint,
  currentBps: number
): SnipeSchedule {
  const active = currentBps > 0;

  if (table.length === 0 || nowSeconds < creationTimestamp) {
    return { currentBps, secondsToNextStep: null, nextBps: null, active };
  }

  const elapsed = Number(nowSeconds - creationTimestamp);

  // Past the end of the table the tax is 0 forever; there is nothing to count down to.
  if (elapsed >= table.length - 1) {
    return { currentBps, secondsToNextStep: null, nextBps: null, active };
  }

  const derivedNow = table[elapsed];
  const next = table[elapsed + 1];

  // Disagreement with the contract means our clock or table is wrong. Suppress rather
  // than display a schedule that contradicts what will actually be charged.
  if (derivedNow !== currentBps) {
    return { currentBps, secondsToNextStep: null, nextBps: null, active };
  }

  return {
    currentBps,
    secondsToNextStep: 1, // steps are one second apart by construction of the table
    nextBps: next,
    active,
  };
}

/**
 * Human phrasing for the tax.
 *
 * "up to 98%", never "98%" (CLAUDE.md §7A): the top tier lasts one second and is only
 * reachable by co-located bots, so quoting it flat overstates what a person will pay.
 */
export function describeSnipeTax(bps: number): string {
  if (bps <= 0) return "No snipe tax — the launch window has passed.";
  const pct = (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2);
  return `Snipe tax ${pct}% right now, decaying every second since launch.`;
}
