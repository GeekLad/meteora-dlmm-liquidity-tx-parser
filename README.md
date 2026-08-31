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
    "amount_y": 2500000,
    "strategy_parameters": [0, 0, 0]
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
| `strategy` | `DlmmStrategy \| undefined` | Liquidity shape: `Spot`, `Curve`, or `BidAsk` |
| `amount_x` | `number \| undefined` | Token X amount |
| `amount_y` | `number \| undefined` | Token Y amount |
| `strategy_parameters` | `number[] \| undefined` | Raw 64-byte strategy parameter blob from `add_liquidity_by_strategy*` (`StrategyParameters.parameteres`) |
| `bins` | `DlmmBin[] \| undefined` | Explicit per-bin list when the instruction carries one (weight / bin-list add or bin-list remove) |
| `rebalance` | `DlmmRebalance \| undefined` | Rebalance add/remove segments on split rebalance sides |
| `originalParsedInstruction` | `ParsedInstructionWithEvents \| undefined` | Raw decoded instruction (debug mode only) |

Optional fields are omitted unless present. Amounts are normalized to finite numbers (including hex-like BN encodings such as `"cef047ee"`).

Bin range, strategy, and distribution details by source:

| Source | `lower_bin_id` / `upper_bin_id` | `strategy` | Extra |
|--------|----------------------------------|------------|--------|
| Create position (`initialize_position*`) | `lower_bin_id` and `width` (`upper = lower + width - 1`) | — | — |
| Add liquidity by strategy | `strategy_parameters.min_bin_id` / `max_bin_id` | `strategy_parameters.strategy_type` mapped to `Spot`, `Curve`, or `BidAsk` | `strategy_parameters` blob when present |
| Add liquidity by bin list / weights | min/max `bin_id` in the distribution | — | `bins` with `weight` and/or amounts |
| Remove liquidity by range | `from_bin_id` / `to_bin_id` | — | — |
| Remove liquidity by bin list | min/max `bin_id` in `bin_liquidity_removal` | — | `bins` with `bps` |
| Claim fee/reward v2 | `min_bin_id` / `max_bin_id` | — | — |
| Rebalance | add side: add ranges from instruction args, else `new_min_id` / `new_max_id`; remove side: remove ranges, else `old_min_id` / `old_max_id` | Inferred from `params.adds[]` when possible; omitted when ambiguous | `rebalance.adds` / `rebalance.removes` on the matching side |

A `rebalance_liquidity` instruction that both adds and withdraws is emitted as two results in **physical order: `RemoveLiquidity` then `AddLiquidity`**, sharing the same signature, pool, and position.

If the `Rebalancing` event is missing, sides are still emitted from `params.adds` / `params.removes` when present (amounts may be omitted). If neither event amounts nor params produce a side, the result is an empty array (no throw).

When liquidity events are missing, amounts fall back to instruction args such as `liquidity_parameter.amount_x` / `amount_y` when available.

#### `DlmmStrategy`

```typescript
type DlmmStrategy = "Spot" | "Curve" | "BidAsk";
```

On-chain `StrategyType` variants such as `SpotImBalanced` and `BidAskOneSide` are collapsed into these three names.

For rebalance adds, strategy is **inferred** from `x0` / `y0` / `delta_x` / `delta_y` / `bit_flag`:

- both deltas zero → `Spot`
- signed deltas that concentrate toward the active bin → `Curve`
- signed deltas that weight the edges → `BidAsk`
- mixed or ambiguous shapes → `strategy` omitted

#### `DlmmBin`

```typescript
interface DlmmBin {
  bin_id: number;
  weight?: number;
  amount_x?: number;
  amount_y?: number;
  bps?: number;
}
```

`bins` is only populated when the instruction already carries an explicit per-bin list. It is not synthesized for strategy deposits or rebalances.

#### `DlmmRebalance`

```typescript
interface DlmmRebalanceAdd {
  min_delta_id: number;
  max_delta_id: number;
  x0: number;
  y0: number;
  delta_x: number;
  delta_y: number;
  favor_x_in_active_id: boolean;
  bit_flag: number;
}

interface DlmmRebalanceRemove {
  min_bin_id?: number;
  max_bin_id?: number;
  bps: number;
}

interface DlmmRebalance {
  adds?: DlmmRebalanceAdd[];
  removes?: DlmmRebalanceRemove[];
}
```

On split results, the add side gets `rebalance.adds` and the remove side gets `rebalance.removes`.

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

> **Note:** Instructions categorized as `"Other"` (swaps, pool setup, governance, etc.) are filtered out and not included in the returned array. Mixed rebalances are not `"Other"`; they are split into remove and add results as described above. The `RebalanceLiquidity` type remains for IDL classification but split results use `AddLiquidity` / `RemoveLiquidity`.

### `IDL_INSTRUCTION_MAP`

A record mapping every Meteora DLMM IDL instruction name to its `DlmmInstructionType`. Useful if you need to inspect or extend the classification logic.

## License

MIT
