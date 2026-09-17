// Manual execution only. See docs/MANUAL_LIFECYCLE.md. No action runs on import.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'deployments', 'manual-lifecycle.json');
const A = {
  factory: '0x1629a7449f5F799eE0Ac04313a1A61D9FF43eA7f',
  deployer: '0x0162C048740aF730c3a20F18A1B8E7B505198cFE',
  usdc: '0x3600000000000000000000000000000000000000',
  adapter: '0xA2C27DbC84b602d9496799096a133043B81d5799',
  hook: '0xAd1286D1c8Cb5359334B084ACB4dbB6879462044',
  manager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  position: '0x6049c9a0e26405c0985f9e3685c87d0ae917f82b',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  protocol: '0x64140EAa0a3B6E4682C98e440837bd3d5482B4cb',
  // Uniswap/sdks: universal-router-sdk/src/utils/constants.ts, ARC 5042, V2_1_1.
  router: '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1',
  view: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
};
const ERC20 = ['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function decimals() view returns(uint8)'];
const KEY = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
// UR 2.1.1 includes minHopPriceX36. The repo's older periphery struct omits it!
const SWAP = `(${KEY} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`;
const abi = ethers.AbiCoder.defaultAbiCoder();
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
function check(ok, message) { if (!ok) throw new Error(message); }
function named(result, fragment) { return Object.fromEntries(fragment.inputs.map((v, i) => [v.name || String(i), result[i]])); }
function poolKey(token) { return [...[A.usdc, token].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1), 0, 60, A.hook]; }
function poolId(token) { return ethers.keccak256(abi.encode([KEY], [poolKey(token)])); }
function spotPrice(sqrt, usdcIs0) {
  // v4 slot0 price conversion only; never a bonding-curve quote.
  const square = BigInt(sqrt) ** 2n;
  check(square > 0n, 'Uninitialised pool price');
  const numerator = usdcIs0 ? (1n << 192n) * 10n ** 12n : square * 10n ** 12n;
  const denominator = usdcIs0 ? square : 1n << 192n;
  return { usdcPerToken: ethers.formatUnits(numerator * 10n ** 36n / denominator, 36), numerator, denominator };
}
async function quoteCrossing(quote, reserves, threshold, maxInput) {
  check(reserves < threshold, 'Already at threshold');
  const reaches = q => reserves + q.actualUsdcIn - q.actualFee >= threshold;
  check(reaches(await quote(maxInput)), 'Threshold unreachable within 2.10 USDC buy cap');
  let low = 1n, high = maxInput;
  while (low < high) {
    const middle = (low + high) / 2n;
    if (reaches(await quote(middle))) high = middle; else low = middle + 1n;
  }
  const q = await quote(low);
  check(reaches(q) && q.tokensOut > 0n, 'Crossing quote invalid');
  if (low > 1n) check(!reaches(await quote(low - 1n)), 'Quote search boundary invalid');
  return { input: low, tokensOut: q.tokensOut, actualUsdcIn: q.actualUsdcIn, actualFee: q.actualFee, reserveAfter: reserves + q.actualUsdcIn - q.actualFee };
}
function swapInput(token, buy, amount, minimum) {
  const key = poolKey(token), input = buy ? A.usdc : token, output = buy ? token : A.usdc;
  return abi.encode(['bytes','bytes[]'], ['0x060c0f', [
    abi.encode([SWAP], [[key, equal(input,key[0]), amount, minimum, 0n, '0x']]),
    abi.encode(['address','uint256'], [input,amount]),
    abi.encode(['address','uint256'], [output,minimum]),
  ]]);
}
function receivedTokens(receipt, token, recipient) {
  const topic=ethers.id('Transfer(address,address,uint256)');
  return receipt.logs.filter(l=>equal(l.address,token)&&l.topics[0]===topic&&l.topics.length===3&&equal('0x'+l.topics[2].slice(-40),recipient)).reduce((sum,l)=>sum+BigInt(l.data),0n);
}
async function run(args, hre) {
  check(equal(ROOT, 'C:\\dev\\arc-launch'), 'Run only the canonical C:\\dev\\arc-launch checkout');
  check(hre.network.name === 'arcMainnet', 'Explicit --network arcMainnet required');
  const steps = ['threshold','approve','create','buy','read','pool-buy','pool-sell','sweep','claim-usdc','claim-token'];
  check(steps.includes(args.step), 'Unknown step');
  const p = new ethers.JsonRpcProvider(hre.network.config.url, undefined, { batchMaxCount: 1 });
  let locked = false;
  const lock = FILE + '.lock';
  try {
    check((await p.getNetwork()).chainId === 5042n, 'Wrong live chain ID');
    const fd = fs.openSync(lock, 'wx'); fs.closeSync(fd); locked = true;
    const j = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE,'utf8')) : { chainId: 5042, factory: A.factory, deployer: A.deployer, transactions: {}, results: {} };
    check(j.chainId === 5042 && equal(j.factory,A.factory) && equal(j.deployer,A.deployer), 'Wrong journal identity');
    const save = () => { fs.writeFileSync(FILE+'.tmp',json(j)+'\n'); fs.renameSync(FILE+'.tmp',FILE); };
    const report = (name, value) => { j.results[name] = value; save(); console.log(name+'\n'+json(value)); };
    const make = (address, contractAbi) => new ethers.Contract(address,contractAbi,p);
    const f = make(A.factory,(await hre.artifacts.readArtifact('LFX1')).abi);
    const h = make(A.hook,(await hre.artifacts.readArtifact('BallistaFeeHook')).abi);
    const ad = make(A.adapter,(await hre.artifacts.readArtifact('BallistaV4Adapter')).abi);
    const u = make(A.usdc,ERC20);
    const pos = make(A.position,['function ownerOf(uint256) view returns(address)','function getPositionLiquidity(uint256) view returns(uint128)']);
    const view = make(A.view,['function poolManager() view returns(address)','function getSlot0(bytes32) view returns(uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)']);
    const interfaces = { [A.factory.toLowerCase()]: f.interface, [A.hook.toLowerCase()]: h.interface, [A.adapter.toLowerCase()]: ad.interface };
    function events(rc) {
      return rc.logs.flatMap(l => { try { const e = interfaces[l.address.toLowerCase()]?.parseLog(l); return e ? [{address:l.address,name:e.name,args:named(e.args,e.fragment)}] : []; } catch { return []; } });
    }
    async function code(address) { check((await p.getCode(address)) !== '0x','No code at '+address); }
    // Fail closed on a failed RPC or any stack mismatch before signing.
    for (const address of [A.factory,A.usdc,A.adapter,A.hook,A.manager,A.position,A.permit2]) await code(address);
    for (const [label,actual,expected] of [
      ['factory.owner',await f.owner(),A.deployer], ['factory.router',await f.router(),A.adapter],
      ['factory.usdc',await f.usdc(),A.usdc], ['hook.adapter',await h.adapter(),A.adapter],
      ['hook.lfx1',await h.lfx1(),A.factory], ['hook.usdc',await h.usdc(),A.usdc],
      ['hook.protocolRecipient',await h.protocolRecipient(),A.protocol], ['hook.poolManager',await h.poolManager(),A.manager],
      ['adapter.hook',await ad.hook(),A.hook], ['adapter.lfx1',await ad.lfx1(),A.factory],
      ['adapter.poolManager',await ad.poolManager(),A.manager], ['adapter.positionManager',await ad.positionManager(),A.position],
      ['adapter.permit2',await ad.permit2(),A.permit2],
    ]) check(equal(actual,expected),label+' mismatch');
    check(await u.decimals() === 6n, 'Wrong USDC decimals');
    report('preflight',{step:args.step,chainId:5042,factory:A.factory,deployer:A.deployer,balanceUsdc:ethers.formatUnits(await u.balanceOf(A.deployer),6)});
    let wallet;
    if (args.step !== 'read') {
      check(process.env.MAINNET_DEPLOYER_PRIVATE_KEY,'Missing MAINNET_DEPLOYER_PRIVATE_KEY in local environment/.env');
      wallet = new ethers.Wallet(process.env.MAINNET_DEPLOYER_PRIVATE_KEY,p);
      check(equal(wallet.address,A.deployer),'Wrong deployer key');
    }
    async function recordReceipt(label,rc) {
      const entry = j.transactions[label];
      entry.receipt = {hash:rc.hash,blockNumber:rc.blockNumber,status:rc.status,gasUsed:rc.gasUsed.toString(),effectiveGasPriceWei:rc.gasPrice.toString(),costUsdc:ethers.formatEther(rc.gasUsed*rc.gasPrice),events:events(rc)};
      save(); console.log(label+' receipt\n'+json(entry.receipt));
      check(rc.status === 1,'Transaction reverted; receipt retained; do not clear journal or resend blindly');
      return rc;
    }
    async function recover(label) {
      if (!j.transactions[label]) return null;
      const hash = j.transactions[label].hash;
      const rc = await p.getTransactionReceipt(hash) || await p.waitForTransaction(hash,1,45000);
      check(rc,'No receipt yet for '+hash+'; no replacement was sent. Preserve journal.');
      return recordReceipt(label,rc);
    }
    async function send(label,contract,method,params,usdcSpend=0n,gasFloor=0n) {
      if (j.transactions[label]) return recover(label);
      const tx = await contract[method].populateTransaction(...params);
      const gasPrice = BigInt(await p.send('eth_gasPrice',[]));
      const feeCap = 50_000_000_000n;
      check(gasPrice <= feeCap,'Current gas price exceeds 50-gwei cap');
      const estimated = await p.estimateGas({...tx,from:A.deployer});
      const gasLimit = estimated*130n/100n > gasFloor ? estimated*130n/100n : gasFloor;
      const paid = Object.values(j.transactions).reduce((sum,t)=>sum+(t.receipt ? BigInt(t.receipt.gasUsed)*BigInt(t.receipt.effectiveGasPriceWei) : 0n),0n);
      check(paid+gasLimit*feeCap <= ethers.parseEther('0.3'),'Run would exceed 0.30 USDC gas budget');
      const balance = await p.getBalance(A.deployer);
      check(balance >= usdcSpend*10n**12n+gasLimit*feeCap+ethers.parseEther('0.20'),'Insufficient balance including 0.20 USDC headroom');
      const nonce = await p.getTransactionCount(A.deployer,'pending');
      check(nonce === await p.getTransactionCount(A.deployer,'latest'),'Pending deployer transaction; resolve it first');
      const full = {...tx,chainId:5042,nonce,type:2,gasLimit,maxFeePerGas:feeCap,maxPriorityFeePerGas:1n,value:0n};
      // Store the deterministic hash BEFORE broadcasting. Never store signed bytes or keys.
      const signed = await wallet.signTransaction(full);
      const hash = ethers.keccak256(signed);
      j.transactions[label] = {hash,nonce,to:tx.to,data:tx.data,estimatedGas:estimated.toString(),gasLimit:gasLimit.toString(),maxFeePerGasWei:feeCap.toString()};
      save(); console.log('Submitting '+label+' '+hash);
      try { await p.broadcastTransaction(signed); } catch { throw new Error('Broadcast outcome uncertain for '+hash+'. Journal preserved; inspect receipt before any retry.'); }
      return recover(label);
    }
    // Resolve every uncertain prior send before permitting any new nonce.
    for(const [label,t] of Object.entries(j.transactions)) if(!t.receipt) await recover(label);
    async function curve() {
      check(j.token,'Run create first; token address is retained in the journal');
      const c = await f.curves(j.token);
      check(equal(c.token,j.token) && equal(c.creator,A.deployer),'Wrong token/creator');
      check(c.graduationThresholdUsdc === 2000000n,'Wrong token threshold snapshot');
      check(!c.poolBoostEnabled,'Unexpected pool boost');
      return c;
    }
    async function feeState() {
      const id = poolId(j.token);
      const launch = await h.launches(id);
      return {poolId:id,registered:launch.registered,creatorRecipient:launch.feeRecipient,protocolRecipient:A.protocol,pendingUsdc:await h.pendingUsdc(id),pendingToken:await h.pendingToken(id),creatorOwedUsdc:await h.owedUsdc(A.deployer),creatorOwedToken:await h.owedToken(A.deployer,j.token),protocolOwedUsdc:await h.owedUsdc(A.protocol),protocolOwedToken:await h.owedToken(A.protocol,j.token)};
    }
    async function readback() {
      const c = await curve(), id = poolId(j.token), token = make(j.token,ERC20);
      const result = {token:j.token,curveState:['ACTIVE','GRADUATION_READY','GRADUATED'][Number(c.state)],thresholdUsdc:ethers.formatUnits(c.graduationThresholdUsdc,6),realUsdcReservesRaw:c.realUsdcReserves,tokenReservesRaw:c.tokenReserves,expectedPoolId:id,lpRecipient:c.lpRecipient,adapterUsdcBalanceRaw:await u.balanceOf(A.adapter),adapterTokenBalanceRaw:await token.balanceOf(A.adapter),factoryTokenBalanceRaw:await token.balanceOf(A.factory),fees:await feeState()};
      const crossing = j.transactions.buy?.receipt;
      if (crossing) {
        result.crossingBuy = crossing;
        const seeded = crossing.events.find(e=>e.name==='PoolSeeded');
        check(Number(c.state)!==2 || seeded, 'GRADUATED without this run’s PoolSeeded receipt; inspect manually');
        if (seeded) {
          await code(A.view); check(equal(await view.poolManager(),A.manager),'StateView manager mismatch');
          const slot = await view.getSlot0(id);
          const positionId = seeded.args.tokenId;
          result.pool = {poolId:id,tokenId:positionId,sqrtPriceX96:slot.sqrtPriceX96,tick:slot.tick,lpFee:slot.lpFee,protocolFee:slot.protocolFee,...spotPrice(slot.sqrtPriceX96,equal(poolKey(j.token)[0],A.usdc)),owner:await pos.ownerOf(positionId),liquidity:await pos.getPositionLiquidity(positionId),seeded:seeded.args};
          const prep = j.results.buyQuote;
          if (prep) {
            const usdcIs0 = equal(poolKey(j.token)[0],A.usdc);
            result.graduationDust = {usdcRaw:BigInt(prep.usdcOffered)-BigInt(usdcIs0?seeded.args.consumed0:seeded.args.consumed1),tokenRaw:BigInt(prep.tokenOffered)-BigInt(usdcIs0?seeded.args.consumed1:seeded.args.consumed0),note:'Per-graduation offered minus consumed; adapter balances above may include earlier dust.'};
          }
          check(Number(c.state)===2 && result.pool.liquidity>0n && equal(result.pool.owner,c.lpRecipient),'Graduation receipt/readback mismatch');
          check(result.fees.registered && equal(result.fees.creatorRecipient,A.deployer),'Hook registration mismatch');
        }
        // A receipt reports total transaction gas, not the internal graduation segment.
        result.graduationGas = {transactionGas:crossing.gasUsed,adapterCallGas:null,note:'Graduation is inside the crossing buy; do not add a second receipt gas charge.'};
        try {
          const trace = await p.send('debug_traceTransaction',[crossing.hash,{tracer:'callTracer'}]);
          const calls=[];
          const walk = n => {if(equal(n.to,A.adapter)&&String(n.input||'').startsWith(ad.interface.getFunction('addLiquidity').selector))calls.push({gasUsed:n.gasUsed,error:n.error||null});for(const child of n.calls||[])walk(child);};
          walk(trace); result.graduationGas.adapterCallGas=calls; result.graduationGas.note+=' Adapter subcall gas excludes factory setup/cleanup.';
        } catch { result.graduationGas.note+=' callTracer unavailable; separate graduation gas cannot be measured here.'; }
      }
      report('readback',result); return result;
    }
    if (args.step === 'threshold') {
      if (await f.defaultGraduationThresholdUsdc() !== 2000000n) await send('threshold',f,'setDefaultGraduationThreshold',[2000000n]);
      else if(j.transactions.threshold) await recover('threshold');
      check(await f.defaultGraduationThresholdUsdc()===2000000n,'Threshold readback failed');
      report('threshold',{raw:2000000,usdc:'2.000000'});
    } else if (args.step === 'approve') {
      check(await f.creationFeeUsdc()===500000n,'Creation fee changed');
      check(!j.token,'Factory approval is a pre-create step');
      if(await u.allowance(A.deployer,A.factory)!==2600000n) await send('approve',u,'approve',[A.factory,2600000n]);
      else if(j.transactions.approve) await recover('approve');
      report('approve',{allowanceRaw:await u.allowance(A.deployer,A.factory),purpose:'0.50 creation + at most 2.10 buy; no unlimited approval'});
    } else if (args.step === 'create') {
      let rc;
      if(j.transactions.create) rc=await recover('create');
      else {
        check(await f.defaultGraduationThresholdUsdc()===2000000n,'Run threshold first');
        check(await f.creationFeeUsdc()===500000n,'Creation fee changed');
        check(await u.allowance(A.deployer,A.factory)>=2600000n,'Run approve first');
        const suffix = String(Date.now()).slice(-8);
        const name='Ballista Lifecycle '+suffix, symbol='LIFE'+suffix;
        const economicsHash=await f.currentEconomicsHash();
        report('createPlan',{name,symbol,economicsHash,poolBoost:false});
        rc=await send('create',f,'createToken',[name,symbol,'',economicsHash,false],500000n);
      }
      const created=events(rc).find(e=>e.name==='TokenCreated'); check(created,'Missing TokenCreated');
      j.token=created.args.token;save();const c=await curve();
      report('create',{token:j.token,thresholdRaw:c.graduationThresholdUsdc,creationTimestamp:c.creationTimestamp});
    } else if (args.step === 'buy') {
      if(j.transactions.buy) {await recover('buy');await readback();return;}
      const c=await curve();check(Number(c.state)===0,'Curve not ACTIVE');
      const block=await p.getBlock('latest');
      const taxTable=await f.snipeTaxTable(c.snipeTaxTableVersion);
      check(BigInt(block.timestamp)>=c.creationTimestamp+BigInt(taxTable.length),'Snipe window open: wait then rerun this command');
      const blockTag=block.number;
      const pinned=await f.curves(j.token,{blockTag});
      const q=await quoteCrossing(x=>f.quoteBuy(j.token,x,{blockTag}),pinned.realUsdcReserves,pinned.graduationThresholdUsdc,2100000n);
      check(await u.allowance(A.deployer,A.factory)>=q.actualUsdcIn,'Factory allowance insufficient');
      const current=await f.curves(j.token);
      check(current.virtualUsdcReserves===pinned.virtualUsdcReserves&&current.virtualTokenReserves===pinned.virtualTokenReserves,'Curve changed during quote search; rerun');
      report('buyQuote',{...q,blockTag,minTokensOut:q.tokensOut*995n/1000n,usdcOffered:q.reserveAfter+current.poolBoost,tokenOffered:await f.LP_TOKEN_RESERVE()+current.tokenReserves-q.tokensOut});
      await send('buy',f,'buy',[j.token,q.input,q.tokensOut*995n/1000n],q.actualUsdcIn,1500000n);
      const result=await readback();
      check(result.curveState!=='ACTIVE','Buy confirmed but curve remains ACTIVE; inspect changing reserves before another buy');
    } else if (args.step === 'read') {
      // Recover a receipt after a timeout without signing or rebroadcasting.
      for(const [label,t] of Object.entries(j.transactions)) if(!t.receipt) await recover(label);
      if(!j.token && j.transactions.create?.receipt) { j.token=j.transactions.create.receipt.events.find(e=>e.name==='TokenCreated')?.args.token;save(); }
      await readback();
    } else {
      check(args.graduationConfirmed,'Review readback, then supply --graduation-confirmed');
      const r=await readback();check(r.curveState==='GRADUATED'&&r.pool&&r.fees.registered,'Graduation not verified; pool actions blocked');
      if(args.step==='sweep') {
        check(j.transactions['pool-buy']?.receipt?.status===1 && j.transactions['pool-sell']?.receipt?.status===1,'Complete both swaps before sweep');
        report('beforeSweep',await feeState());await send('sweep',h,'sweep',[poolId(j.token)]);report('afterSweep',await feeState());
      } else if(args.step.startsWith('claim-')) {
        check(j.transactions.sweep?.receipt?.status===1,'Run sweep first');
        const isUsdc=args.step==='claim-usdc',currency=isUsdc?A.usdc:j.token,erc=make(currency,ERC20);
        if(!j.transactions[args.step]) {
          const owed=isUsdc?await h.owedUsdc(A.deployer):await h.owedToken(A.deployer,j.token);
          check(owed>0n,'Nothing owed; no transaction sent');
          report(args.step+'Before',{currency,owed,balance:await erc.balanceOf(A.deployer)});
        }
        const rc=await send(args.step,h,isUsdc?'claim':'claimToken',isUsdc?[]:[j.token]);
        const e=events(rc).find(e=>e.name==='Claimed');check(e&&equal(e.args.recipient,A.deployer)&&equal(e.args.currency,currency),'Missing/mismatched Claimed');
        report(args.step,{payout:e.args,remainingOwed:isUsdc?await h.owedUsdc(A.deployer):await h.owedToken(A.deployer,j.token),balanceAfter:await erc.balanceOf(A.deployer),note:'USDC native balance also pays gas; Claimed is gross payout.'});
      } else {
        const buy=args.step==='pool-buy';
        if(j.transactions[args.step]) {
          const rc=await recover(args.step);
          if(buy)report('pool-buyAfter',{netTokenReceived:receivedTokens(rc,j.token,A.deployer),feeEvents:events(rc).filter(e=>e.name==='FeeAccrued'),note:'Recovered directly from receipt Transfer logs.'});
          report(args.step+'Fees',await feeState());return;
        }
        if(!buy)check(j.transactions['pool-buy']?.receipt?.status===1,'Run pool-buy first');
        await code(A.router);await code(A.quoter);
        const router=make(A.router,['function poolManager() view returns(address)','function execute(bytes,bytes[],uint256) payable']);
        check(equal(await router.poolManager(),A.manager),'Universal Router manager mismatch');
        const quoter=make(A.quoter,[`function quoteExactInputSingle((${KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns(uint256 amountOut,uint256 gasEstimate)`,'function poolManager() view returns(address)']);
        check(equal(await quoter.poolManager(),A.manager),'Quoter manager mismatch');
        const input=buy?A.usdc:j.token,output=buy?j.token:A.usdc,erc=make(input,ERC20),out=make(output,ERC20);
        // Sell only tokens received in the pool buy; retain the original curve purchase.
        const amount=buy?100000n:BigInt(j.results['pool-buyAfter'].netTokenReceived);
        check(amount>0n&&await erc.balanceOf(A.deployer)>=amount,'Insufficient swap input');
        const permit=make(A.permit2,['function allowance(address,address,address) view returns(uint160 amount,uint48 expiration,uint48 nonce)','function approve(address,address,uint160,uint48)']);
        if(await erc.allowance(A.deployer,A.permit2)<amount)await send(args.step+'-erc20-approve',erc,'approve',[A.permit2,amount]);
        const now=(await p.getBlock('latest')).timestamp;
        const allowance=await permit.allowance(A.deployer,input,A.router);
        if(allowance.amount<amount||allowance.expiration<BigInt(now+120))await send(args.step+'-permit2-approve',permit,'approve',[input,A.router,amount,now+1800]);
        const key=poolKey(j.token);
        const q=await quoter.quoteExactInputSingle.staticCall([key,equal(input,key[0]),amount,'0x']);
        const minimum=q.amountOut*995n/1000n;check(minimum>0n,'Zero swap minimum');
        const payload=swapInput(j.token,buy,amount,minimum),deadline=(await p.getBlock('latest')).timestamp+300;
        // eth_call the full router path (including both approvals) before submission.
        await router.execute.staticCall('0x10',[payload],deadline,{from:A.deployer});
        const before=await out.balanceOf(A.deployer);
        report(args.step+'Quote',{input,output,amount,quotedNetOut:q.amountOut,minimum,slippageBps:50,deadline,beforeOutputBalance:before});
        const rc=await send(args.step,router,'execute',['0x10',[payload],deadline],buy?amount:0n);
        const fee=events(rc).filter(e=>e.name==='FeeAccrued');check(fee.length>0,'No FeeAccrued; inspect receipt');
        const after=await out.balanceOf(A.deployer);
        report(args.step+'After',{feeEvents:fee,outputBalanceAfter:after,...(buy?{netTokenReceived:receivedTokens(rc,j.token,A.deployer)}:{}),note:buy?'Token balance delta excludes no gas; saved for reverse swap.':'USDC balance delta includes gas; FeeAccrued records gross deltas and fee.',fees:await feeState()});
      }
    }
    console.log('Saved '+FILE);
  } finally { if(locked)fs.unlinkSync(lock);p.destroy(); }
}
module.exports = { run, quoteCrossing, swapInput, spotPrice, poolKey, poolId, receivedTokens, A, KEY, SWAP };
