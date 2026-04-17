import { Connection } from "@solana/web3.js";
import {
  parseMeteoraTransaction,
  DlmmInstruction,
  DlmmInstructionType,
} from "@geeklad/meteora-dlmm-liquidity-tx-parser";

const RPC_URL = "https://api.mainnet-beta.solana.com";

async function main() {
  const connection = new Connection(RPC_URL);

  // Replace with a real transaction signature
  const signature =
    "24uLAdS72y27B6AyL53by1GrDTfPie1zHEZR8QPfRwyxRQ4gCQpSXSP5fDat4V8DPmwZiR2CKz6tP9oopFZoM3Wf";

  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });

  if (!tx) {
    console.error("Transaction not found");
    process.exit(1);
  }

  const instructions = parseMeteoraTransaction(tx);

  if (instructions.length === 0) {
    console.log("No Meteora DLMM liquidity instructions found");
    return;
  }

  for (const ix of instructions) {
    printInstruction(ix);
  }
}

function printInstruction(ix: DlmmInstruction) {
  const labels: Record<DlmmInstructionType, string> = {
    AddLiquidity: "➕ Add Liquidity",
    RemoveLiquidity: "➖ Remove Liquidity",
    CreatePosition: "🆕 Create Position",
    ClosePosition: "❌ Close Position",
    RebalanceLiquidity: "🔄 Rebalance Liquidity",
    ClaimFees: "💰 Claim Fees",
    ClaimRewards: "🎁 Claim Rewards",
    Other: "❓ Other",
  };

  console.log(`\n${labels[ix.type]}`);
  console.log(`  Signature : ${ix.signature}`);
  console.log(`  Signer    : ${ix.signer}`);
  console.log(`  Slot      : ${ix.slot}`);
  console.log(`  Time      : ${ix.timestamp.toISOString()}`);
  console.log(`  Fee       : ${ix.fee} lamports`);
  console.log(`  Position  : ${ix.position}`);
  if (ix.pool) console.log(`  Pool      : ${ix.pool}`);
  if (ix.active_bin_id !== undefined)
    console.log(`  Active Bin: ${ix.active_bin_id}`);
  if (ix.amount_x !== undefined) console.log(`  Amount X  : ${ix.amount_x}`);
  if (ix.amount_y !== undefined) console.log(`  Amount Y  : ${ix.amount_y}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
