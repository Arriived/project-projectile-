const solc = require('solc');
const fs = require('fs');
const path = require('path');

const contractsDir = path.join(__dirname, 'contracts');

function collectSources(dir, base, sources) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSources(full, path.join(base, entry.name), sources);
    } else if (entry.name.endsWith('.sol')) {
      sources[path.join(base, entry.name)] = { content: fs.readFileSync(full, 'utf8') };
    }
  }
}

const sources = {};
collectSources(contractsDir, '', sources);

function findImports(importPath) {
  const tryPaths = [
    path.resolve(__dirname, 'node_modules', importPath),
    path.resolve(contractsDir, importPath),
  ];
  for (const p of tryPaths) {
    if (fs.existsSync(p)) return { contents: fs.readFileSync(p, 'utf8') };
  }
  return { error: 'File not found: ' + importPath };
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

let hasError = false;
if (output.errors) {
  for (const err of output.errors) {
    console.log(err.severity.toUpperCase() + ': ' + err.formattedMessage);
    if (err.severity === 'error') hasError = true;
  }
}
if (hasError) { console.log('COMPILATION FAILED'); process.exit(1); }

const outDir = path.join(__dirname, 'artifacts-manual');
fs.mkdirSync(outDir, { recursive: true });

for (const file in output.contracts) {
  for (const name in output.contracts[file]) {
    const c = output.contracts[file][name];
    fs.writeFileSync(
      path.join(outDir, name + '.json'),
      JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 2)
    );
  }
}
console.log('✅ Compiled, artifacts written to artifacts-manual/');
