const { expect } = require('chai');
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { build, OUT } = require('../scripts/gen-indexer-abi');

// The indexer previously carried a hand-maintained ABI listing the Curve struct as 16
// fields while it had grown to 22. ethers decoded it WITHOUT error -- the struct is
// all-static, so the offsets lined up and the extra fields were silently dropped.
// creatorLaunchPurchased was one of them, which is why "creator bought X% at launch"
// could not be rendered.
//
// These tests exist so that failure mode cannot recur silently. Regenerating the tuple
// by hand would fix it until the next struct change; failing the build is what makes it
// permanent.
describe('indexer ABI is generated, not hand-maintained', function () {
  it('the committed ABI matches what the current artifact generates', function () {
    const fresh = build();
    const committed = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : null;
    expect(committed, `${path.relative(process.cwd(), OUT)} is missing -- run: node scripts/gen-indexer-abi.js`)
      .to.not.equal(null);
    expect(
      committed,
      'the committed indexer ABI has drifted from the build artifact. ' +
      'Run: node scripts/gen-indexer-abi.js'
    ).to.equal(fresh);
  });

  it('the ABI decodes every field of the on-chain Curve struct', async function () {
    const abi = JSON.parse(build());
    const iface = new ethers.Interface(abi);
    const components = iface.getFunction('curves').outputs[0].components;

    // Ground truth: what the compiled contract actually returns, taken from the
    // artifact rather than from a list written out here -- a list here would be the
    // same hand-maintained trap one layer up.
    const artifact = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'artifacts', 'contracts', 'LFX1.sol', 'LFX1.json'), 'utf8'
    ));
    const onChain = artifact.abi.find((e) => e.type === 'function' && e.name === 'curves')
      .outputs[0].components;

    expect(components.length, 'field count must match the compiled struct')
      .to.equal(onChain.length);
    expect(components.map((c) => `${c.name}:${c.type}`))
      .to.deep.equal(onChain.map((c) => `${c.name}:${c.type}`));
  });

  // The specific field the truncation hid, named explicitly. If a future struct change
  // ever drops it, this says why it mattered rather than just that a count changed.
  it('creatorLaunchPurchased is decodable -- it is the buyer-protection disclosure', async function () {
    const abi = JSON.parse(build());
    const iface = new ethers.Interface(abi);
    const names = iface.getFunction('curves').outputs[0].components.map((c) => c.name);
    expect(names, 'the "creator bought X%" disclosure depends on this field')
      .to.include('creatorLaunchPurchased');
    expect(names).to.include('lpRecipient');
  });

  it('a truncated ABI really does decode silently -- the failure being guarded against', async function () {
    const [, treasury] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    const ballista = await (await ethers.getContractFactory('LFX1'))
      .deploy(await usdc.getAddress(), treasury.address, ethers.ZeroAddress);

    const full = JSON.parse(build());
    const curves = full.find((e) => e.type === 'function' && e.name === 'curves');
    const truncated = JSON.parse(JSON.stringify(curves));
    truncated.outputs[0].components = truncated.outputs[0].components.slice(0, 16);

    const stale = new ethers.Contract(await ballista.getAddress(), [truncated], ethers.provider);
    const decoded = await stale.curves(ethers.ZeroAddress);

    // No throw. That is the whole problem: a stale ABI is not loud, it is quiet.
    expect(decoded.length, 'the stale shape decodes without error, dropping 6 fields')
      .to.equal(16);
  });
});
