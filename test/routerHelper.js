const { ethers } = require('hardhat');

/// Router activation is a three-step, timelocked flow now: propose, wait 24h, activate.
/// Every fixture needs a live router (createToken is gated on one), so this collapses
/// the dance into one call rather than repeating it at ~40 call sites.
///
/// NOTE: this advances chain time by ROUTER_TIMELOCK. Fixtures call it BEFORE launching
/// any token, so no token's creationTimestamp -- and therefore no snipe tax window -- is
/// affected. A test that swaps routers mid-run also jumps 24h, which is fine because by
/// then the tokens under test are long past their snipe window.
async function activateRouter(ballista, routerAddress) {
  await ballista.proposeRouter(routerAddress);
  await ethers.provider.send('evm_increaseTime', [24 * 3600 + 1]);
  await ethers.provider.send('evm_mine');
  await ballista.activateRouter(routerAddress);
}

module.exports = { activateRouter, ROUTER_TIMELOCK: 24 * 3600 };
