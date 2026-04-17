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
| `amount_x` | `number \| undefined` | Token X amount |
| `amount_y` | `number \| undefined` | Token Y amount |
| `originalParsedInstruction` | `ParsedInstructionWithEvents \| undefined` | Raw decoded instruction (debug mode only) |

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

> **Note:** Instructions categorized as `"Other"` (swaps, pool setup, governance, etc.) are filtered out and not included in the returned array.

### `IDL_INSTRUCTION_MAP`

A record mapping every Meteora DLMM IDL instruction name to its `DlmmInstructionType`. Useful if you need to inspect or extend the classification logic.

## License

MIT
