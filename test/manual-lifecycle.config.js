// Local-only validation: never loads .env or any configured mainnet account.
require('@nomicfoundation/hardhat-ethers');
module.exports = { solidity:'0.8.24', networks:{hardhat:{hardfork:'cancun'}}, paths:{root:require('path').resolve(__dirname,'..'),artifacts:require('path').resolve(__dirname,'../artifacts'),cache:require('path').resolve(__dirname,'../cache')} };
