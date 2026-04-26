import { ethers } from "ethers";

// ── RPC Providers ─────────────────────────────────────────────────────────────
const providers = {
  base: new ethers.JsonRpcProvider(
    process.env.BASE_RPC_URL || "https://mainnet.base.org"
  ),
  ethereum: new ethers.JsonRpcProvider(
    process.env.ETH_RPC_URL || "https://eth.llamarpc.com"
  ),
};

// ── Known DeFi protocol addresses ─────────────────────────────────────────────
const DEFI_CONTRACTS = {
  ethereum: {
    "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9": "Aave v2",
    "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2": "Aave v3",
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f": "Uniswap v2",
    "0x1F98431c8aD98523631AE4a59f267346ea31F984": "Uniswap v3",
    "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3b": "Compound",
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": "WETH",
    "0x6B175474E89094C44Da98b954EedeAC495271d0F": "DAI",
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC",
  },
  base: {
    "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5": "Aave v3 Base",
    "0x33128a8fC17869897dcE68Ed026d694621f6FDfD": "Uniswap v3 Base",
    "0x4200000000000000000000000000000000000006": "WETH Base",
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "USDC Base",
    "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": "DAI Base",
  },
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// ─────────────────────────────────────────────────────────────────────────────
// WALLET RISK CLASSIFIER
// ─────────────────────────────────────────────────────────────────────────────

const MIXER_PATTERNS = [
  "tornado", "mixer", "coinjoin", "anonymous", "privacy",
];

const HIGH_VOLUME_THRESHOLD = 1000;
const DORMANT_THRESHOLD_DAYS = 180;

export async function classifyWalletRisk(address, chain) {
  const chains = chain === "both" ? ["ethereum", "base"] : [chain];
  const chainSignals = {};
  for (const c of chains) {
    chainSignals[c] = await fetchChainSignals(address, c);
  }

  const riskFactors = [];
  let riskScore = 0;

  // ── Factor 1: Flagged protocol interactions ──────────────────────────────
  for (const c of chains) {
    const signals = chainSignals[c];
    if (signals && signals.defiProtocols) {
      for (const protocol of signals.defiProtocols) {
        if (protocol.toLowerCase().includes("exploit") ||
            protocol.toLowerCase().includes("hack")) {
          riskFactors.push({
            factor: "Flagged Protocol",
            risk: "HIGH",
            detail: `Interacted with ${protocol}`,
          });
          riskScore += 25;
        }
      }
    }
  }

  // ── Factor 2: Wallet age ──────────────────────────────────────────────────
  const maxAge = Math.max(
    chainSignals.base?.estimatedFirstBlockAge || 0,
    chainSignals.ethereum?.estimatedFirstBlockAge || 0
  );
  if (maxAge < 30) {
    riskFactors.push({
      factor: "New Wallet",
      risk: "MEDIUM",
      detail: `Only ${maxAge} days old`,
    });
    riskScore += 15;
  }

  // ── Factor 3: Low transaction count ──────────────────────────────────────
  const totalTx = (chainSignals.base?.txCount || 0) + (chainSignals.ethereum?.txCount || 0);
  if (totalTx < 10) {
    riskFactors.push({
      factor: "Low Activity",
      risk: "MEDIUM",
      detail: `Only ${totalTx} lifetime transactions`,
    });
    riskScore += 10;
  }

  // ── Factor 4: High concentration ─────────────────────────────────────────
  const balances = [
    chainSignals.base?.nativeBalance || 0,
    chainSignals.ethereum?.nativeBalance || 0,
  ];
  const totalBalance = balances.reduce((a, b) => a + b, 0);
  if (totalBalance > 0) {
    const maxBalance = Math.max(...balances);
    const concentration = maxBalance / totalBalance;
    if (concentration > 0.95) {
      riskFactors.push({
        factor: "High Concentration",
        risk: "LOW",
        detail: `95%+ balance in single asset`,
      });
      riskScore += 5;
    }
  }

  // ── Factor 5: No DeFi interactions ───────────────────────────────────────
  const hasDeFi = (chainSignals.base?.defiProtocols?.length > 0) ||
                  (chainSignals.ethereum?.defiProtocols?.length > 0);
  if (!hasDeFi) {
    riskFactors.push({
      factor: "No DeFi History",
      risk: "LOW",
      detail: "Never interacted with lending/swapping protocols",
    });
    riskScore += 5;
  }

  // ── Factor 6: Dormant wallet ─────────────────────────────────────────────
  if (maxAge > DORMANT_THRESHOLD_DAYS && totalTx > 0) {
    const txPerDay = (totalTx / maxAge).toFixed(2);
    if (txPerDay < 0.1) {
      riskFactors.push({
        factor: "Dormant Activity",
        risk: "LOW",
        detail: `Last active ${maxAge} days ago`,
      });
      riskScore += 3;
    }
  }

  riskScore = Math.min(100, Math.max(0, riskScore));

  const riskGrade = riskScore >= 70 ? "HIGH" :
                    riskScore >= 40 ? "MEDIUM" :
                    riskScore >= 15 ? "LOW" : "VERY_LOW";

  const riskSummary =
    riskGrade === "HIGH"      ? "Significant risk indicators. Exercise caution." :
    riskGrade === "MEDIUM"    ? "Moderate risk. Monitor interactions." :
    riskGrade === "LOW"       ? "Minor risk indicators." :
    "Minimal risk detected. Good trust signal.";

  return {
    address,
    chainsChecked: chains,
    riskScore,
    riskGrade,
    riskSummary,
    riskFactors,
    chainSignals: chainSignals,
    recommendation:
      riskGrade === "HIGH" ? "Consider additional verification before high-value transaction" :
      riskGrade === "MEDIUM" ? "Standard due diligence recommended" :
      "Low-risk wallet. Safe for standard interactions",
    assessedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CREDIT SCORING
// ─────────────────────────────────────────────────────────────────────────────

async function fetchChainSignals(address, chainName) {
  const provider = providers[chainName];
  const signals = { chain: chainName };

  try {
    const currentBlock = await provider.getBlockNumber();

    const balance = await provider.getBalance(address);
    signals.nativeBalance = parseFloat(ethers.formatEther(balance));

    const txCount = await provider.getTransactionCount(address);
    signals.txCount = txCount;

    const code = await provider.getCode(address);
    signals.isContract = code !== "0x";
    signals.hasDeployedContracts = code !== "0x";

    signals.estimatedFirstBlockAge = await estimateWalletAge(
      provider, address, currentBlock
    );

    signals.defiProtocols = await detectDefiInteractions(
      provider, address, chainName, currentBlock
    );

    signals.knownTokensHeld = await checkTokenDiversity(
      provider, address, chainName
    );

    return signals;
  } catch (err) {
    return { chain: chainName, error: err.message, txCount: 0, nativeBalance: 0 };
  }
}

async function estimateWalletAge(provider, address, currentBlock) {
  try {
    const txCount = await provider.getTransactionCount(address);
    if (txCount === 0) return 0;

    const latestBlock = await provider.getBlock(currentBlock);
    const nowSeconds = latestBlock.timestamp;

    const checkpoints = [
      Math.floor(currentBlock * 0.1),
      Math.floor(currentBlock * 0.25),
      Math.floor(currentBlock * 0.5),
      Math.floor(currentBlock * 0.75),
    ].filter(b => b > 0);

    let oldestActivityBlock = currentBlock;

    for (const blockNum of checkpoints) {
      try {
        const count = await provider.getTransactionCount(address, blockNum);
        if (count > 0) {
          oldestActivityBlock = blockNum;
          break;
        }
      } catch { /* skip */ }
    }

    const oldBlock = await provider.getBlock(oldestActivityBlock);
    const ageSeconds = nowSeconds - oldBlock.timestamp;
    return Math.floor(ageSeconds / 86400);
  } catch {
    return 0;
  }
}

async function detectDefiInteractions(provider, address, chainName, currentBlock) {
  const protocols = new Set();
  const knownContracts = DEFI_CONTRACTS[chainName] || {};

  try {
    const fromBlock = Math.max(0, currentBlock - 500);

    for (const [contractAddr, protocolName] of Object.entries(knownContracts)) {
      try {
        const logs = await provider.getLogs({
          fromBlock,
          toBlock: currentBlock,
          address: contractAddr,
          topics: [null, ethers.zeroPadValue(address, 32)],
        });

        if (logs.length > 0) protocols.add(protocolName);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return [...protocols];
}

async function checkTokenDiversity(provider, address, chainName) {
  const tokens = [];
  const knownContracts = DEFI_CONTRACTS[chainName] || {};

  for (const [contractAddr, tokenName] of Object.entries(knownContracts)) {
    try {
      const contract = new ethers.Contract(contractAddr, ERC20_ABI, provider);
      const balance = await contract.balanceOf(address);
      if (balance > 0n) tokens.push(tokenName);
    } catch { /* skip */ }
  }

  return tokens;
}

async function checkEnsOwnership(address) {
  try {
    const provider = providers.ethereum;
    const name = await provider.lookupAddress(address);
    return name !== null;
  } catch {
    return false;
  }
}

function computeScore(signals) {
  const breakdown = {};
  let total = 0;

  const ageDays = Math.max(
    signals.base?.estimatedFirstBlockAge || 0,
    signals.ethereum?.estimatedFirstBlockAge || 0
  );
  const ageScore = Math.min(150, Math.floor((ageDays / 1095) * 150));
  breakdown.walletAge = { score: ageScore, max: 150, detail: `${ageDays} days old` };
  total += ageScore;

  const totalTx = (signals.base?.txCount || 0) + (signals.ethereum?.txCount || 0);
  const txScore = Math.min(150, Math.floor(Math.log10(totalTx + 1) * 50));
  breakdown.transactionVolume = { score: txScore, max: 150, detail: `${totalTx} total transactions` };
  total += txScore;

  const bothChainActivity = (signals.base?.txCount > 0 ? 40 : 0) +
                            (signals.ethereum?.txCount > 0 ? 40 : 0);
  breakdown.consistency = { score: bothChainActivity, max: 80, detail: `Active on ${bothChainActivity / 40} chain(s)` };
  total += bothChainActivity;

  const allProtocols = new Set([
    ...(signals.base?.defiProtocols || []),
    ...(signals.ethereum?.defiProtocols || []),
  ]);
  const defiScore = Math.min(150, allProtocols.size * 30);
  breakdown.defiInteractions = { score: defiScore, max: 150, detail: `${allProtocols.size} DeFi protocols: ${[...allProtocols].join(", ") || "none detected"}` };
  total += defiScore;

  const allTokens = new Set([
    ...(signals.base?.knownTokensHeld || []),
    ...(signals.ethereum?.knownTokensHeld || []),
  ]);
  const tokenScore = Math.min(80, allTokens.size * 16);
  breakdown.tokenDiversity = { score: tokenScore, max: 80, detail: `${allTokens.size} known tokens held` };
  total += tokenScore;

  const ensScore = signals.hasEns ? 70 : 0;
  breakdown.ensOwnership = { score: ensScore, max: 70, detail: signals.hasEns ? "ENS name found" : "No ENS name" };
  total += ensScore;

  const totalBalance = (signals.base?.nativeBalance || 0) + (signals.ethereum?.nativeBalance || 0);
  const balanceScore = Math.min(100, Math.floor(Math.log10(totalBalance * 1000 + 1) * 20));
  breakdown.nativeBalance = { score: balanceScore, max: 100, detail: `${totalBalance.toFixed(4)} ETH across chains` };
  total += balanceScore;

  const deployScore =
    (signals.base?.hasDeployedContracts ? 35 : 0) +
    (signals.ethereum?.hasDeployedContracts ? 35 : 0);
  breakdown.contractDeployments = { score: deployScore, max: 70, detail: deployScore > 0 ? "Contract deployer detected" : "No contract deployments" };
  total += deployScore;

  return { total: Math.min(850, total), breakdown };
}

function gradeScore(score) {
  if (score >= 750) return { grade: "A", label: "Excellent", description: "Strong on-chain history. High creditworthiness." };
  if (score >= 650) return { grade: "B", label: "Good",      description: "Solid activity. Generally creditworthy." };
  if (score >= 550) return { grade: "C", label: "Fair",      description: "Moderate history. Moderate risk." };
  if (score >= 400) return { grade: "D", label: "Poor",      description: "Limited history. Higher risk." };
  return                     { grade: "F", label: "Insufficient", description: "Too little on-chain history to assess." };
}

export async function scorewallet(address, chain, tier) {
  const scoredAt = new Date().toISOString();
  const chains = chain === "both" ? ["base", "ethereum"] : [chain];

  const [baseSignals, ethSignals, hasEns] = await Promise.all([
    chains.includes("base")     ? fetchChainSignals(address, "base")     : Promise.resolve(null),
    chains.includes("ethereum") ? fetchChainSignals(address, "ethereum") : Promise.resolve(null),
    checkEnsOwnership(address),
  ]);

  const aggregated = {
    ...(baseSignals     && { base: baseSignals }),
    ...(ethSignals      && { ethereum: ethSignals }),
    hasEns,
  };

  const { total, breakdown } = computeScore(aggregated);
  const { grade, label, description } = gradeScore(total);

  const base = {
    address,
    score: total,
    grade,
    label,
    summary: description,
    scoredAt,
    chainsChecked: chains,
  };

  if (tier === "basic") return base;

  if (tier === "standard") {
    return {
      ...base,
      breakdown: Object.fromEntries(
        Object.entries(breakdown).map(([k, v]) => [k, { score: v.score, max: v.max, detail: v.detail }])
      ),
    };
  }

  return {
    ...base,
    breakdown,
    rawSignals: {
      ...(baseSignals && { base: baseSignals }),
      ...(ethSignals  && { ethereum: ethSignals }),
      hasEns,
    },
  };
}
