// Explicit opt-in config; the normal Hardhat configuration is unchanged.
const config = require('./hardhat.config');
const { task } = require('hardhat/config');
task('rehearsal', 'Manual, journaled Arc rehearsal; one operation per invocation')
  .addParam('step', 'threshold | approve | create | buy | read | pool-buy | pool-sell | sweep | claim-usdc | claim-token')
  .addFlag('graduationConfirmed', 'Operator has reviewed the graduation readback')
  .setAction(async (args, hre) => require('./scripts/manual-lifecycle').run(args, hre));
module.exports = config;
