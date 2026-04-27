import express from "express";
import { paymentMiddleware } from "x402-express";
import { scorewallet, classifyWalletRisk } from "./scoring.js";

const app = express();
const PORT = process.env.PORT || 3002;

const RECEIVING_WALLET = process.env.RECEIVING_WALLET;
const NETWORK = process.env.NETWORK || "base";

if (!RECEIVING_WALLET) {
  console.error("❌  RECEIVING_WALLET env var is required");
  process.exit(1);
}

app.use(express.json());

// ── Pricing tiers ─────────────────────────────────────────────────────────────
const PRICING = {
  credit_basic:    "$0.10",
  credit_standard: "$0.15",
  credit_full:     "$0.25",
  risk_basic:      "$0.08",
  risk_full:       "$0.15",
};

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "onchain-identity-validator",
    version: "2.0.0",
    networks: ["base", "ethereum"],
    pricing: PRICING,
  });
});

// ── Service info ──────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "On-Chain Identity Validator — Node 1",
    description:
      "Two independent on-chain assessment tools. " +
      "Credit Scorer returns creditworthiness (0–850) based on transaction history. " +
      "Wallet Risk Classifier returns risk grade (VERY_LOW to HIGH) based on activity patterns, " +
      "flagged contracts, and engagement history.",
    endpoints: {
      "POST /score":      "Creditworthiness score 0–850 with grade A–F",
      "POST /risk":       "Wallet risk classification: VERY_LOW / LOW / MEDIUM / HIGH",
    },
    tiers: {
      credit: {
        basic:    { price: PRICING.credit_basic,    returns: "score, grade, summary" },
        standard: { price: PRICING.credit_standard, returns: "score, grade, summary, breakdown" },
        full:     { price: PRICING.credit_full,     returns: "score, grade, breakdown, raw signals" },
      },
      risk: {
        basic:    { price: PRICING.risk_basic, returns: "riskGrade, riskScore, summary" },
        full:     { price: PRICING.risk_full,  returns: "riskGrade, riskScore, factors, recommendation" },
      },
    },
    payment: {
      protocol: "x402",
      network: NETWORK,
      asset: "USDC",
      facilitator: "https://x402.org/facilitator",
    },
  });
});

// ── Paid endpoint: POST /score ────────────────────────────────────────────────
app.post(
  "/score",
  paymentMiddleware(
    RECEIVING_WALLET,
    {
      "/score": {
        price: PRICING.credit_standard,
        network: NETWORK,
        config: {
          description: "On-chain credit score — wallet creditworthiness",
        },
      },
      "/score?tier=basic": {
        price: PRICING.credit_basic,
        network: NETWORK,
        config: { description: "On-chain credit score — basic tier" },
      },
      "/score?tier=full": {
        price: PRICING.credit_full,
        network: NETWORK,
        config: { description: "On-chain credit score — full tier" },
      },
    },
    { url: "https://x402.org/facilitator" }
  ),
  async (req, res) => {
    const { address, chain = "both", tier = "standard" } = req.body;

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({
        error: "Valid Ethereum address required (0x + 40 hex chars).",
      });
    }

    if (!["base", "ethereum", "both"].includes(chain)) {
      return res.status(400).json({
        error: "'chain' must be: base | ethereum | both",
      });
    }

    if (!["basic", "standard", "full"].includes(tier)) {
      return res.status(400).json({
        error: "'tier' must be: basic | standard | full",
      });
    }

    try {
      const result = await scorewallet(address, chain, tier);
      res.json(result);
    } catch (err) {
      console.error(`Credit scoring error for ${address}:`, err.message);
      res.status(502).json({
        error: "Failed to retrieve on-chain data.",
        detail: err.message,
      });
    }
  }
);

// ── Paid endpoint: POST /risk ─────────────────────────────────────────────────
app.post(
  "/risk",
  paymentMiddleware(
    RECEIVING_WALLET,
    {
      "/risk": {
        price: PRICING.risk_full,
        network: NETWORK,
        config: {
          description: "Wallet risk classification — flags, activity patterns, flagged contracts",
        },
      },
      "/risk?tier=basic": {
        price: PRICING.risk_basic,
        network: NETWORK,
        config: { description: "Wallet risk classifier — basic tier" },
      },
    },
    { url: "https://x402.org/facilitator" }
  ),
  async (req, res) => {
    const { address, chain = "both", tier = "full" } = req.body;

    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({
        error: "Valid Ethereum address required (0x + 40 hex chars).",
      });
    }

    if (!["base", "ethereum", "both"].includes(chain)) {
      return res.status(400).json({
        error: "'chain' must be: base | ethereum | both",
      });
    }

    if (!["basic", "full"].includes(tier)) {
      return res.status(400).json({
        error: "'tier' must be: basic | full",
      });
    }

    try {
      let result = await classifyWalletRisk(address, chain);

      if (tier === "basic") {
        result = {
          address: result.address,
          riskGrade: result.riskGrade,
          riskScore: result.riskScore,
          riskSummary: result.riskSummary,
          assessedAt: result.assessedAt,
        };
      }

      res.json(result);
    } catch (err) {
      console.error(`Risk classification error for ${address}:`, err.message);
      res.status(502).json({
        error: "Failed to classify wallet risk.",
        detail: err.message,
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`\n📊 On-Chain Identity Validator running on port ${PORT}`);
  console.log(`   Networks : Base + Ethereum`);
  console.log(`   Wallet   : ${RECEIVING_WALLET}`);
  console.log(`   Credit Scoring:`);
  console.log(`     basic    ${PRICING.credit_basic} USDC`);
  console.log(`     standard ${PRICING.credit_standard} USDC`);
  console.log(`     full     ${PRICING.credit_full} USDC`);
  console.log(`   Risk Classification:`);
  console.log(`     basic    ${PRICING.risk_basic} USDC`);
  console.log(`     full     ${PRICING.risk_full} USDC\n`);
});
