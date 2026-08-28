import { PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { parseInstructions, ParsedInstructionWithEvents } from "@geeklad/solana-tx-parser";
import { parseMeteoraTransaction } from "../src";

jest.mock("@geeklad/solana-tx-parser", () => ({
  parseInstructions: jest.fn(),
}));

const mockedParseInstructions = parseInstructions as jest.MockedFunction<typeof parseInstructions>;

const PROGRAM_ID = LBCLMM_PROGRAM_IDS["mainnet-beta"];
const SIGNER = new PublicKey("11111111111111111111111111111111");
const POOL = "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq";
const POSITION = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const SIGNATURE = "5xA3liquiditySignature111111111111111111111111";

function makeTx(): ParsedTransactionWithMeta {
  return {
    slot: 320456789,
    blockTime: 1_700_000_000,
    meta: {
      fee: 5000,
      err: null,
      innerInstructions: [],
      logMessages: [],
      postBalances: [],
      preBalances: [],
      rewards: [],
    },
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [
          {
            pubkey: SIGNER,
            signer: true,
            writable: true,
            source: "transaction",
          },
        ],
        instructions: [],
        recentBlockhash: "11111111111111111111111111111111",
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

function makeIx(
  name: string,
  events?: ParsedInstructionWithEvents["events"],
  options?: {
    programId?: string;
    includePosition?: boolean;
    includePool?: boolean;
    inner?: ParsedInstructionWithEvents[];
  }
): ParsedInstructionWithEvents {
  const accounts = [];
  if (options?.includePool !== false) {
    accounts.push({
      name: "lb_pair",
      pubkey: POOL,
      isSigner: false,
      isWritable: true,
    });
  }
  if (options?.includePosition !== false) {
    accounts.push({
      name: "position",
      pubkey: POSITION,
      isSigner: false,
      isWritable: true,
    });
  }

  return {
    index: 0,
    programId: options?.programId ?? PROGRAM_ID,
    parsedInstruction: { name, data: {} },
    accounts,
    events,
    parsedInnerInstructions: options?.inner,
  };
}

beforeEach(() => {
  mockedParseInstructions.mockReset();
});

describe("parseMeteoraTransaction", () => {
  it("parses add-liquidity instructions and amounts from the AddLiquidity event", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity2", [
        {
          name: "AddLiquidity",
          data: { active_bin_id: 5432, amounts: [1_000_000, 2_500_000] },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix).toMatchObject({
      signature: SIGNATURE,
      signer: SIGNER.toBase58(),
      slot: 320456789,
      fee: 5000,
      type: "AddLiquidity",
      pool: POOL,
      position: POSITION,
      active_bin_id: 5432,
      amount_x: 1_000_000,
      amount_y: 2_500_000,
    });
    expect(ix.timestamp).toEqual(new Date(1_700_000_000 * 1000));
  });

  it("maps each current liquidity instruction family to the expected type", () => {
    const cases: Array<[string, string]> = [
      ["initialize_position2", "CreatePosition"],
      ["close_position_if_empty", "ClosePosition"],
      ["add_liquidity_by_weight2", "AddLiquidity"],
      ["remove_liquidity_by_range2", "RemoveLiquidity"],
      ["claim_fee2", "ClaimFees"],
      ["claim_reward2", "ClaimRewards"],
    ];

    for (const [name, type] of cases) {
      mockedParseInstructions.mockReturnValue([makeIx(name)]);
      const [ix] = parseMeteoraTransaction(makeTx());
      expect(ix.type).toBe(type);
      expect(ix.position).toBe(POSITION);
    }
  });

  it("classifies add-only rebalance events as AddLiquidity", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 100,
            x_added_amount: 50,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("AddLiquidity");
    expect(ix.amount_x).toBe(50);
    expect(ix.amount_y).toBe(0);
    expect(ix.active_bin_id).toBe(100);
  });

  it("classifies remove-only rebalance events as RemoveLiquidity", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 101,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 25,
            y_withdrawn_amount: 75,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("RemoveLiquidity");
    expect(ix.amount_x).toBe(25);
    expect(ix.amount_y).toBe(75);
  });

  it("filters mixed rebalance events as Other", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 102,
            x_added_amount: 10,
            y_added_amount: 10,
            x_withdrawn_amount: 10,
            y_withdrawn_amount: 10,
          },
        },
      ]),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("prefers ClaimFee2 amounts and active_bin_id over ClaimFee", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("claim_fee2", [
        { name: "ClaimFee", data: { fee_x: 1, fee_y: 2 } },
        { name: "ClaimFee2", data: { active_bin_id: 9, fee_x: 111, fee_y: 222 } },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClaimFees");
    expect(ix.active_bin_id).toBe(9);
    expect(ix.amount_x).toBe(111);
    expect(ix.amount_y).toBe(222);
  });

  it("filters instructions classified as Other, including new limit-order instructions", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("swap2"),
      makeIx("place_limit_order", undefined, { includePosition: false }),
      makeIx("cancel_limit_order", undefined, { includePosition: false }),
      makeIx("close_limit_order_if_empty", undefined, { includePosition: false }),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("treats unknown instruction names as Other instead of throwing", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("not_a_real_instruction"),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("includes inner/CPI DLMM instructions", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("route", undefined, {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        includePosition: false,
        includePool: false,
        inner: [
          makeIx("remove_all_liquidity", [
            {
              name: "RemoveLiquidity",
              data: { active_bin_id: 7, amounts: [8, 9] },
            },
          ]),
        ],
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("RemoveLiquidity");
    expect(ix.amount_x).toBe(8);
    expect(ix.amount_y).toBe(9);
    expect(ix.active_bin_id).toBe(7);
  });

  it("includes originalParsedInstruction in debug mode", () => {
    const original = makeIx("initialize_position");
    mockedParseInstructions.mockReturnValue([original]);

    const [ix] = parseMeteoraTransaction(makeTx(), true);
    expect(ix.originalParsedInstruction).toEqual(original);
  });

  it("throws when a liquidity instruction is missing a position account", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity2", undefined, { includePosition: false }),
    ]);

    expect(() => parseMeteoraTransaction(makeTx())).toThrow(
      "Could not find position account in instruction"
    );
  });
});
