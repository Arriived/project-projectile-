# Frontend build — hard rules

Requirements the frontend must satisfy because of something in the contract, not because
of taste. Each one has a reason attached. **If you are about to remove one of these as a
needless restriction, read the reason first** — every entry here exists because removing it
costs a user money.

The broader frontend requirements (price impact as a headline number, `minTokensOut` never
defaulting to zero, "creator bought X% at launch", stale quotes inside the snipe window)
live in `CLAUDE.md` §8. They are not duplicated here, because two copies of a number go
stale at different rates.

---

## 1. The create flow must approve EXACTLY the creation fee. Never `MaxUint256`.

**Rule.** Before `createToken`, approve the launchpad for exactly the `creationFeeUsdc`
read in the same page load, and no more. Never an unlimited approval, never a rounded-up
buffer, never a standing approval reused across launches.

**Reason — register entry R13.** `creationFeeUsdc` is **not** covered by
`currentEconomicsHash()`. The economics hash pins the buy fee, sell fee, graduation
threshold, creator fee split, creator launch cap and window, LP recipient, snipe tax
version and split, and symbol policy — but not the creation fee. So `createToken` checks
the hash the creator signed up to, passes, and *then* pulls whatever `creationFeeUsdc`
happens to be at execution time:

```solidity
if (!(expectedEconomicsHash == currentEconomicsHash())) revert EconomicsChanged();  // passes
...
usdc.safeTransferFrom(msg.sender, address(this), creationFeeUsdc);                   // current value
```

Proven in `test/ActorPhase.adversarial.test.js`: a creator pinned the terms at 0.5 USDC,
the owner raised the fee 1000x, the pinned hash was unchanged so the guard could not fire,
and the creator paid 500 USDC. The economics-pinning guarantee does not extend to this
fee.

**The approval is the only thing bounding it.** With an exact approval the worst case is a
reverted transaction — annoying, safe. With `MaxUint256` the worst case is the entire USDC
balance of the creator's wallet, taken by a single owner transaction front-running the
launch. This is the difference between a failed launch and a drained wallet, and it is
decided entirely in the frontend.

**This is not defence against a hypothetical.** The owner is a single EOA by deliberate
decision (R8, and not to be re-raised). A compromised owner key is the threat model this
approval bound is sized for.

**If the contract later pins `creationFeeUsdc` in the economics hash, this rule can be
relaxed — and not before.** Check `currentEconomicsHash()` in `contracts/LFX1.sol` before
concluding that it has been.
