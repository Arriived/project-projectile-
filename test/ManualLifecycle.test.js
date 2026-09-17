const assert=require('node:assert/strict');
const {ethers,network}=require('hardhat');
const helpers=require('../scripts/manual-lifecycle');
const {quoteCrossing,swapInput,spotPrice,poolId,poolKey,receivedTokens,A,KEY,SWAP}=helpers;
describe('Manual lifecycle preparation (offline)',function(){
  let f,token;
  before(async()=>{
    const [owner,treasury,router]=await ethers.getSigners();
    const u=await(await ethers.getContractFactory('MockUSDC')).deploy();
    f=await(await ethers.getContractFactory('LFX1')).deploy(u.target,treasury.address,router.address);
    await(await u.mint(owner.address,10000000n)).wait();
    await(await u.approve(f.target,10000000n)).wait();
    await(await f.setDefaultGraduationThreshold(2000000n)).wait();
    const rc=await(await f.createToken('Local quote','LQUOTE','',await f.currentEconomicsHash(),false)).wait();
    token=rc.logs.map(l=>{try{return f.interface.parseLog(l)}catch{return null}}).find(e=>e?.name==='TokenCreated').args.token;
    await network.provider.send('evm_increaseTime',[30]);await network.provider.send('evm_mine');
  });
  it('finds the first crossing raw input using real contract quotes, including the lower boundary',async()=>{
    const q=await quoteCrossing(x=>f.quoteBuy(token,x),0n,2000000n,2100000n);
    assert.equal(q.input,2020202n);assert.equal(q.actualFee,20202n);
    const below=await f.quoteBuy(token,q.input-1n);assert(below.actualUsdcIn-below.actualFee<2000000n);
    assert(q.reserveAfter>=2000000n);assert(q.tokensOut>0n);
  });
  it('refuses insufficient maximum spend',async()=>{await assert.rejects(quoteCrossing(x=>f.quoteBuy(token,x),0n,2000000n,1000000n),/unreachable/)});
  it('refuses an already-crossed reserve',async()=>{await assert.rejects(quoteCrossing(x=>f.quoteBuy(token,x),2000000n,2000000n,2100000n),/Already/)});
  it('keeps currency order and direction correct on both sides of USDC',()=>{
    const coder=ethers.AbiCoder.defaultAbiCoder();
    for(const t of ['0x1000000000000000000000000000000000000001','0x9000000000000000000000000000000000000001'])for(const buy of [true,false]){
      const [actions,params]=coder.decode(['bytes','bytes[]'],swapInput(t,buy,1000n,900n));
      assert.equal(actions,'0x060c0f');
      const [swap]=coder.decode([SWAP],params[0]);
      const [input,max]=coder.decode(['address','uint256'],params[1]);
      const [output,min]=coder.decode(['address','uint256'],params[2]);
      assert.equal(input.toLowerCase(),(buy?A.usdc:t).toLowerCase());
      assert.equal(output.toLowerCase(),(buy?t:A.usdc).toLowerCase());
      assert.equal(swap.zeroForOne,input.toLowerCase()===swap.poolKey.currency0.toLowerCase());
      assert.equal(swap.amountIn,1000n);assert.equal(swap.amountOutMinimum,900n);
      assert.equal(swap.minHopPriceX36,0n);assert.equal(swap.hookData,'0x');assert.equal(max,1000n);assert.equal(min,900n);
      assert.equal(swap.poolKey.hooks.toLowerCase(),A.hook.toLowerCase());
      assert.equal(swap.poolKey.fee,0n);assert.equal(swap.poolKey.tickSpacing,60n);
      assert.equal(poolId(t),ethers.keccak256(coder.encode([KEY],[poolKey(t)])));
    }
  });
  it('rejects a zero price and converts both orderings without floating point',()=>{
    assert.throws(()=>spotPrice(0n,true),/Uninitialised/);
    assert.equal(spotPrice(2n**96n,false).usdcPerToken,'1000000000000.0');
    assert.equal(spotPrice(2n**97n,false).usdcPerToken,'4000000000000.0');
    assert.equal(spotPrice(2n**97n,true).usdcPerToken,'250000000000.0');
  });
  it('recovers received tokens from receipt transfers and ignores other assets/recipients',()=>{
    const topic=ethers.id('Transfer(address,address,uint256)'),pad=a=>ethers.zeroPadValue(a,32);
    const log=(asset,to,amount)=>({address:asset,topics:[topic,pad(A.manager),pad(to)],data:ethers.toBeHex(amount,32)});
    assert.equal(receivedTokens({logs:[log(token,A.deployer,123n),log(A.usdc,A.deployer,999n),log(token,A.hook,77n)]},token,A.deployer),123n);
  });
  it('refuses non-mainnet task invocations before accessing a provider or key',async()=>{
    await assert.rejects(helpers.run({step:'threshold'},{network:{name:'hardhat'}}),/arcMainnet/);
  });
});
