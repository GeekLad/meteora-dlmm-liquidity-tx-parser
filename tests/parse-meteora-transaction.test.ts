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
    data?: Record<string, unknown>;
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
    parsedInstruction: { name, data: options?.data ?? {} },
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

  it("derives lower/upper bin IDs from create-position lower_bin_id and width", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position2", undefined, {
        data: { lower_bin_id: 100, width: 21 },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("CreatePosition");
    expect(ix.lower_bin_id).toBe(100);
    expect(ix.upper_bin_id).toBe(120);
    expect(ix.strategy).toBeUndefined();
  });

  it("uses from_bin_id/to_bin_id for remove-liquidity-by-range", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("remove_liquidity_by_range2", [
        { name: "RemoveLiquidity", data: { active_bin_id: 50, amounts: [1, 2] } },
      ], {
        data: { from_bin_id: 40, to_bin_id: 60, bps_to_remove: 10000 },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("RemoveLiquidity");
    expect(ix.lower_bin_id).toBe(40);
    expect(ix.upper_bin_id).toBe(60);
  });

  it("uses min/max bin IDs from an explicit bin-removal list", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("remove_liquidity2", [
        { name: "RemoveLiquidity", data: { active_bin_id: 8, amounts: [3, 4] } },
      ], {
        data: {
          bin_liquidity_removal: [
            { bin_id: 12, bps_to_remove: 10000 },
            { bin_id: 7, bps_to_remove: 5000 },
            { bin_id: 9, bps_to_remove: 10000 },
          ],
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(7);
    expect(ix.upper_bin_id).toBe(12);
  });

  it("reads strategy and bin range from add-liquidity-by-strategy parameters", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy2", [
        { name: "AddLiquidity", data: { active_bin_id: 100, amounts: [10, 20] } },
      ], {
        data: {
          liquidity_parameter: {
            amount_x: 10,
            amount_y: 20,
            active_id: 100,
            strategy_parameters: {
              min_bin_id: 90,
              max_bin_id: 110,
              strategy_type: { SpotImBalanced: {} },
            },
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("AddLiquidity");
    expect(ix.lower_bin_id).toBe(90);
    expect(ix.upper_bin_id).toBe(110);
    expect(ix.strategy).toBe("Spot");
  });

  it.each([
    [{ CurveBalanced: {} }, "Curve"],
    [{ BidAskOneSide: {} }, "BidAsk"],
    [{ spotImBalanced: {} }, "Spot"],
    [{ curveOneSide: {} }, "Curve"],
    [{ bidAskImBalanced: {} }, "BidAsk"],
    [1, "Curve"],
    ["BidAsk", "BidAsk"],
  ] as const)("maps strategy_type %p to %s", (strategyType, expected) => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy", undefined, {
        data: {
          liquidity_parameter: {
            strategy_parameters: {
              min_bin_id: 1,
              max_bin_id: 5,
              strategy_type: strategyType,
            },
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.strategy).toBe(expected);
  });

  it("uses compressed bin IDs for add_liquidity_one_side_precise", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_one_side_precise", undefined, {
        data: {
          parameter: {
            bins: [
              { bin_id: 15, amount: 1 },
              { bin_id: 18, amount: 2 },
            ],
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(15);
    expect(ix.upper_bin_id).toBe(18);
    expect(ix.strategy).toBeUndefined();
  });

  it("uses bin distribution min/max when adding liquidity by weight", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_weight2", undefined, {
        data: {
          liquidity_parameter: {
            bin_liquidity_dist: [
              { bin_id: 4, weight: 1 },
              { bin_id: 10, weight: 2 },
              { bin_id: 6, weight: 1 },
            ],
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(4);
    expect(ix.upper_bin_id).toBe(10);
    expect(ix.strategy).toBeUndefined();
  });

  it("uses claim_fee2 min_bin_id/max_bin_id instruction args", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("claim_fee2", [
        { name: "ClaimFee2", data: { active_bin_id: 9, fee_x: 111, fee_y: 222 } },
      ], {
        data: { min_bin_id: 1, max_bin_id: 30 },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClaimFees");
    expect(ix.lower_bin_id).toBe(1);
    expect(ix.upper_bin_id).toBe(30);
  });

  it("uses the resulting position range from a Rebalancing event", () => {
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
            old_min_id: 80,
            old_max_id: 100,
            new_min_id: 80,
            new_max_id: 120,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("AddLiquidity");
    expect(ix.lower_bin_id).toBe(80);
    expect(ix.upper_bin_id).toBe(120);
  });

  it("prefers rebalance instruction add/remove ranges over the event range", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 50,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 10,
            y_withdrawn_amount: 0,
            old_min_id: 1,
            old_max_id: 100,
            new_min_id: 20,
            new_max_id: 80,
          },
        },
      ], {
        data: {
          params: {
            active_id: 50,
            removes: [{ min_bin_id: 40, max_bin_id: 45, bps: 10000 }],
            adds: [],
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("RemoveLiquidity");
    expect(ix.lower_bin_id).toBe(40);
    expect(ix.upper_bin_id).toBe(45);
  });

  it("omits bin range and strategy when the instruction does not carry them", () => {
    mockedParseInstructions.mockReturnValue([makeIx("close_position2")]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClosePosition");
    expect(ix.lower_bin_id).toBeUndefined();
    expect(ix.upper_bin_id).toBeUndefined();
    expect(ix.strategy).toBeUndefined();
  });
});
