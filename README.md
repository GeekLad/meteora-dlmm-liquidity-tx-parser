# @geeklad/meteora-dlmm-liquidity-tx-parser

Parse [Meteora DLMM](https://www.meteora.ag/) liquidity transactions on Solana into structured, typed data. Given a parsed Solana transaction, this library extracts position management operations (add/remove liquidity, open/close positions, claim fees/rewards) along with token amounts and account addresses.

## Installation

```bash
npm install @geeklad/meteora-dlmm-liquidity-tx-parser
```

## Usage

```typescript
import { Connection } from "@solana/web3.js";
import { parseMeteoraTransaction } from "@geeklad/meteora-dlmm-liquidity-tx-parser";

const connection = new Connection("https://api.mainnet-beta.solana.com");

const tx = await connection.getParsedTransaction(
  "YOUR_TX_SIGNATURE",
  { maxSupportedTransactionVersion: 0 }
);

if (tx) {
  const instructions = parseMeteoraTransaction(tx);
  console.log(instructions);
}
```

### Example output

```json
[
  {
    "signature": "5xA3...",
    "signer": "4tsd85k5...",
    "slot": 320456789,
    "timestamp": "2024-11-01T12:34:56.000Z",
    "fee": 5000,
    "type": "AddLiquidity",
    "pool": "7Bxi6...",
    "position": "9Kzm2...",
    "active_bin_id": 5432,
    "lower_bin_id": 5400,
    "upper_bin_id": 5460,
    "strategy": "Spot",
    "amount_x": 1000000,
    "amount_y": 2500000
  }
]
```

## API

### `parseMeteoraTransaction(tx, debug?)`

Parses a Solana transaction and returns all Meteora DLMM liquidity instructions found within it (including inner/CPI instructions). Returns an empty array if the transaction contains no relevant DLMM instructions.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tx` | `ParsedTransactionWithMeta` | — | Parsed transaction from `@solana/web3.js` |
| `debug` | `boolean` | `false` | When `true`, includes the raw `originalParsedInstruction` in each result |

**Returns:** `DlmmInstruction[]`

### Types

#### `DlmmInstruction`

| Field | Type | Description |
|-------|------|-------------|
| `signature` | `string` | Transaction signature |
| `signer` | `string` | Wallet that signed the transaction |
| `slot` | `number` | Solana slot number |
| `timestamp` | `Date` | Block timestamp |
| `fee` | `number` | Transaction fee in lamports |
| `type` | `DlmmInstructionType` | Instruction category |
| `position` | `string` | Position account public key |
| `pool` | `string \| undefined` | Liquidity pool public key |
| `active_bin_id` | `number \| undefined` | Active bin at time of instruction |
| `lower_bin_id` | `number \| undefined` | Lowest bin ID in the instruction's range, when the instruction or event carries one |
| `upper_bin_id` | `number \| undefined` | Highest bin ID in the instruction's range, when the instruction or event carries one |
| `strategy` | `DlmmStrategy \| undefined` | Liquidity shape used for strategy deposits: `Spot`, `Curve`, or `BidAsk` |
| `amount_x` | `number \| undefined` | Token X amount |
| `amount_y` | `number \| undefined` | Token Y amount |
| `originalParsedInstruction` | `ParsedInstructionWithEvents \| undefined` | Raw decoded instruction (debug mode only) |

Bin range and strategy are omitted unless the instruction or event actually provides them:

| Source | `lower_bin_id` / `upper_bin_id` | `strategy` |
|--------|----------------------------------|------------|
| Create position (`initialize_position*`) | `lower_bin_id` and `width` (`upper = lower + width - 1`) | — |
| Add liquidity by strategy | `strategy_parameters.min_bin_id` / `max_bin_id` | `strategy_parameters.strategy_type` mapped to `Spot`, `Curve`, or `BidAsk` |
| Add liquidity by bin list / weights | min/max `bin_id` in the distribution | — |
| Remove liquidity by range | `from_bin_id` / `to_bin_id` | — |
| Remove liquidity by bin list | min/max `bin_id` in `bin_liquidity_removal` | — |
| Claim fee/reward v2 | `min_bin_id` / `max_bin_id` | — |
| Rebalance | add side: add ranges from instruction args, else `new_min_id` / `new_max_id`; remove side: remove ranges, else `old_min_id` / `old_max_id` | — |

A `rebalance_liquidity` instruction that both adds and withdraws is emitted as two results: `AddLiquidity` then `RemoveLiquidity`, sharing the same signature, pool, and position.

#### `DlmmStrategy`

```typescript
type DlmmStrategy = "Spot" | "Curve" | "BidAsk";
```

On-chain `StrategyType` variants such as `SpotImBalanced` and `BidAskOneSide` are collapsed into these three names.

#### `DlmmInstructionType`

```typescript
type DlmmInstructionType =
  | "CreatePosition"
  | "ClosePosition"
  | "AddLiquidity"
  | "RemoveLiquidity"
  | "RebalanceLiquidity"
  | "ClaimFees"
  | "ClaimRewards"
  | "Other";
```

> **Note:** Instructions categorized as `"Other"` (swaps, pool setup, governance, etc.) are filtered out and not included in the returned array. Mixed rebalances are not `"Other"`; they are split into add and remove results as described above.

### `IDL_INSTRUCTION_MAP`

A record mapping every Meteora DLMM IDL instruction name to its `DlmmInstructionType`. Useful if you need to inspect or extend the classification logic.

## License

MIT
