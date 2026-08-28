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
    includeAccounts?: boolean;
    inner?: ParsedInstructionWithEvents[];
    data?: Record<string, unknown> | null;
    parsedInstruction?: ParsedInstructionWithEvents["parsedInstruction"];
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

  let parsedInstruction: ParsedInstructionWithEvents["parsedInstruction"];
  if (options && "parsedInstruction" in options) {
    parsedInstruction = options.parsedInstruction ?? null;
  } else if (options && "data" in options && options.data == null) {
    parsedInstruction = { name, data: undefined } as unknown as ParsedInstructionWithEvents["parsedInstruction"];
  } else {
    parsedInstruction = { name, data: options?.data ?? {} };
  }

  return {
    index: 0,
    programId: options?.programId ?? PROGRAM_ID,
    parsedInstruction,
    accounts: options?.includeAccounts === false ? undefined : accounts,
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

  it("splits mixed rebalance events into add and remove instructions", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 102,
            x_added_amount: 10,
            y_added_amount: 20,
            x_withdrawn_amount: 30,
            y_withdrawn_amount: 40,
            old_min_id: 80,
            old_max_id: 100,
            new_min_id: 90,
            new_max_id: 120,
          },
        },
      ]),
    ]);

    const result = parseMeteoraTransaction(makeTx());
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "AddLiquidity",
      signature: SIGNATURE,
      pool: POOL,
      position: POSITION,
      active_bin_id: 102,
      amount_x: 10,
      amount_y: 20,
      lower_bin_id: 90,
      upper_bin_id: 120,
    });
    expect(result[1]).toMatchObject({
      type: "RemoveLiquidity",
      signature: SIGNATURE,
      pool: POOL,
      position: POSITION,
      active_bin_id: 102,
      amount_x: 30,
      amount_y: 40,
      lower_bin_id: 80,
      upper_bin_id: 100,
    });
    expect(result[0].timestamp).toEqual(result[1].timestamp);
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
    expect(ix.pool).toBe(POOL);
  });

  it("reads unsided rebalance event ranges when no other bin source is present", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("close_position2", [
        {
          name: "Rebalancing",
          data: {
            new_min_id: 21,
            new_max_id: 29,
            old_min_id: 10,
            old_max_id: 40,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClosePosition");
    expect(ix.lower_bin_id).toBe(21);
    expect(ix.upper_bin_id).toBe(29);
  });

  it("falls back to old_min_id/old_max_id on the unsided rebalance event path", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("close_position2", [
        {
          name: "Rebalancing",
          data: {
            old_min_id: 4,
            old_max_id: 8,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(4);
    expect(ix.upper_bin_id).toBe(8);
  });

  it("leaves bin range empty on the unsided path when the rebalance event has no bounds", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("close_position2", [
        { name: "Rebalancing", data: { active_bin_id: 1 } },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBeUndefined();
    expect(ix.upper_bin_id).toBeUndefined();
  });

  it("treats one-sided add or remove rebalances as add/remove, not mixed", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 1,
            x_added_amount: 10,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
          },
        },
      ]),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].type).toBe("AddLiquidity");

    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 1,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 8,
          },
        },
      ]),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].type).toBe("RemoveLiquidity");
  });

  it("splits a cross-token rebalance into add X and remove Y", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 1,
            x_added_amount: 50,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 25,
          },
        },
      ]),
    ]);

    const [add, remove] = parseMeteoraTransaction(makeTx());
    expect(add.type).toBe("AddLiquidity");
    expect(add.amount_x).toBe(50);
    expect(add.amount_y).toBe(0);
    expect(remove.type).toBe("RemoveLiquidity");
    expect(remove.amount_x).toBe(0);
    expect(remove.amount_y).toBe(25);
  });

  it("splits a cross-token rebalance into add Y and remove X", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 2,
            x_added_amount: 0,
            y_added_amount: 7,
            x_withdrawn_amount: 9,
            y_withdrawn_amount: 0,
          },
        },
      ]),
    ]);

    const [add, remove] = parseMeteoraTransaction(makeTx());
    expect(add).toMatchObject({ type: "AddLiquidity", amount_x: 0, amount_y: 7 });
    expect(remove).toMatchObject({ type: "RemoveLiquidity", amount_x: 9, amount_y: 0 });
  });

  it("uses per-side bin ranges when a mixed rebalance has add and remove params", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 50,
            x_added_amount: 5,
            y_added_amount: 6,
            x_withdrawn_amount: 7,
            y_withdrawn_amount: 8,
            old_min_id: 1,
            old_max_id: 100,
            new_min_id: 1,
            new_max_id: 100,
          },
        },
      ], {
        data: {
          params: {
            active_id: 50,
            removes: [{ min_bin_id: 40, max_bin_id: 45 }],
            adds: [{ min_delta_id: -2, max_delta_id: 4 }],
          },
        },
      }),
    ]);

    const [add, remove] = parseMeteoraTransaction(makeTx());
    expect(add.type).toBe("AddLiquidity");
    expect(add.lower_bin_id).toBe(48);
    expect(add.upper_bin_id).toBe(54);
    expect(remove.type).toBe("RemoveLiquidity");
    expect(remove.lower_bin_id).toBe(40);
    expect(remove.upper_bin_id).toBe(45);
  });

  it("splits a mixed rebalance that appears as an inner instruction", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("route", undefined, {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        includePosition: false,
        includePool: false,
        inner: [
          makeIx("rebalance_liquidity", [
            {
              name: "Rebalancing",
              data: {
                active_bin_id: 4,
                x_added_amount: 11,
                y_added_amount: 0,
                x_withdrawn_amount: 12,
                y_withdrawn_amount: 13,
              },
            },
          ]),
        ],
      }),
    ]);

    const result = parseMeteoraTransaction(makeTx());
    expect(result.map((ix) => ix.type)).toEqual(["AddLiquidity", "RemoveLiquidity"]);
    expect(result[0].amount_x).toBe(11);
    expect(result[1].amount_x).toBe(12);
    expect(result[1].amount_y).toBe(13);
  });

  it("returns no instructions when a rebalance event has zero add and withdraw amounts", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 1,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
          },
        },
      ]),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("includes the original instruction on both split rebalance results in debug mode", () => {
    const original = makeIx("rebalance_liquidity", [
      {
        name: "Rebalancing",
        data: {
          active_bin_id: 3,
          x_added_amount: 1,
          y_added_amount: 0,
          x_withdrawn_amount: 2,
          y_withdrawn_amount: 0,
        },
      },
    ]);
    mockedParseInstructions.mockReturnValue([original]);

    const result = parseMeteoraTransaction(makeTx(), true);
    expect(result).toHaveLength(2);
    expect(result[0].originalParsedInstruction).toEqual(original);
    expect(result[1].originalParsedInstruction).toEqual(original);
  });

  it("throws when a rebalance instruction has no Rebalancing event", () => {
    mockedParseInstructions.mockReturnValue([makeIx("rebalance_liquidity")]);

    expect(() => parseMeteoraTransaction(makeTx())).toThrow(
      "Could not find Rebalancing event in rebalance transaction"
    );
  });

  it("reads ClaimFee amounts when ClaimFee2 is absent", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("claim_fee", [{ name: "ClaimFee", data: { fee_x: 3, fee_y: 4 } }]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClaimFees");
    expect(ix.amount_x).toBe(3);
    expect(ix.amount_y).toBe(4);
    expect(ix.active_bin_id).toBeUndefined();
  });

  it("leaves amounts empty when events do not match a known payload", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("claim_reward2", [{ name: "ClaimReward2", data: { active_bin_id: 9, total_reward: 77 } }]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClaimRewards");
    expect(ix.amount_x).toBeUndefined();
    expect(ix.amount_y).toBeUndefined();
  });

  it("leaves amounts empty when the event list is empty", () => {
    mockedParseInstructions.mockReturnValue([makeIx("add_liquidity2", [])]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("AddLiquidity");
    expect(ix.amount_x).toBeUndefined();
    expect(ix.amount_y).toBeUndefined();
    expect(ix.active_bin_id).toBeUndefined();
  });

  it("returns both a top-level DLMM instruction and inner DLMM CPIs", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity2", [
        { name: "AddLiquidity", data: { active_bin_id: 1, amounts: [2, 3] } },
      ], {
        inner: [
          makeIx("claim_fee2", [
            { name: "ClaimFee2", data: { active_bin_id: 1, fee_x: 4, fee_y: 5 } },
          ]),
        ],
      }),
    ]);

    const result = parseMeteoraTransaction(makeTx());
    expect(result.map((ix) => ix.type)).toEqual(["AddLiquidity", "ClaimFees"]);
    expect(result[1].amount_x).toBe(4);
  });

  it("leaves pool undefined when the instruction has no lb_pair account", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("close_position2", undefined, { includePool: false }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.position).toBe(POSITION);
    expect(ix.pool).toBeUndefined();
  });

  it("throws when accounts are missing entirely", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity2", undefined, { includeAccounts: false }),
    ]);

    expect(() => parseMeteoraTransaction(makeTx())).toThrow(
      "Could not find position account in instruction"
    );
  });

  it("filters instructions whose parsed payload has no IDL name", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity2", undefined, {
        parsedInstruction: null,
      }),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("tolerates a missing instruction data payload", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("close_position2", undefined, { data: null }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("ClosePosition");
    expect(ix.lower_bin_id).toBeUndefined();
  });

  it("derives create-position bins from BN-like and string values", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position", undefined, {
        data: {
          lower_bin_id: { toNumber: () => 10 },
          width: "5",
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(10);
    expect(ix.upper_bin_id).toBe(14);
  });

  it("derives remove-by-range bins from bigint values", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("remove_liquidity_by_range", undefined, {
        data: { from_bin_id: BigInt(3), to_bin_id: BigInt(9) },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(3);
    expect(ix.upper_bin_id).toBe(9);
  });

  it("ignores non-numeric bin values instead of inventing a range", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position2", undefined, {
        data: { lower_bin_id: 8, width: "not-a-number" },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBeUndefined();
    expect(ix.upper_bin_id).toBeUndefined();
  });

  it("ignores objects that are not numeric bin IDs", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position2", undefined, {
        data: { lower_bin_id: { nope: true }, width: 5 },
      }),
    ]);

    expect(parseMeteoraTransaction(makeTx())[0].lower_bin_id).toBeUndefined();

    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position2", undefined, {
        data: { lower_bin_id: { toNumber: () => Number.NaN }, width: 5 },
      }),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].lower_bin_id).toBeUndefined();
  });

  it("reads camelCase strategy parameter names", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy_one_side", undefined, {
        data: {
          liquidityParameter: {
            strategyParameters: {
              minBinId: 2,
              maxBinId: 8,
              strategyType: { BidAskBalanced: {} },
            },
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(2);
    expect(ix.upper_bin_id).toBe(8);
    expect(ix.strategy).toBe("BidAsk");
  });

  it("reads bin IDs from a raw numeric list and skips invalid entries", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity", undefined, {
        data: {
          bins: [true, "6", BigInt(2), { binId: 11 }, { foo: 1 }, null],
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(2);
    expect(ix.upper_bin_id).toBe(11);
  });

  it("maps numeric strategy 0 to Spot and ignores unknown strategy types", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy2", undefined, {
        data: {
          liquidity_parameter: {
            strategy_parameters: {
              min_bin_id: 1,
              max_bin_id: 2,
              strategy_type: 0,
            },
          },
        },
      }),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].strategy).toBe("Spot");

    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy2", undefined, {
        data: {
          liquidity_parameter: {
            strategy_parameters: {
              min_bin_id: 1,
              max_bin_id: 2,
              strategy_type: { UnknownStrategy: {} },
            },
          },
        },
      }),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].strategy).toBeUndefined();

    mockedParseInstructions.mockReturnValue([
      makeIx("add_liquidity_by_strategy2", undefined, {
        data: {
          liquidity_parameter: {
            strategy_parameters: {
              min_bin_id: 1,
              max_bin_id: 2,
              strategy_type: {},
            },
          },
        },
      }),
    ]);
    expect(parseMeteoraTransaction(makeTx())[0].strategy).toBeUndefined();
  });

  it("ignores non-finite numeric bin IDs", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("initialize_position2", undefined, {
        data: { lower_bin_id: 8, width: Number.NaN },
      }),
    ]);

    expect(parseMeteoraTransaction(makeTx())[0].upper_bin_id).toBeUndefined();
  });

  it("uses a remove range that only specifies one bound and an add with only max_delta_id", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 20,
            x_added_amount: 1,
            y_added_amount: 0,
            x_withdrawn_amount: 4,
            y_withdrawn_amount: 0,
            new_min_id: 0,
            new_max_id: 100,
          },
        },
      ], {
        data: {
          params: {
            active_id: 20,
            removes: [{ min_bin_id: 15 }],
            adds: [{ max_delta_id: 3 }],
          },
        },
      }),
    ]);

    const [add, remove] = parseMeteoraTransaction(makeTx());
    expect(add.type).toBe("AddLiquidity");
    expect(add.lower_bin_id).toBe(23);
    expect(add.upper_bin_id).toBe(23);
    expect(remove.type).toBe("RemoveLiquidity");
    expect(remove.lower_bin_id).toBe(15);
    expect(remove.upper_bin_id).toBe(15);
  });

  it("falls through add-side params when active_id is missing", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 20,
            x_added_amount: 1,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
            new_min_id: 7,
            new_max_id: 9,
          },
        },
      ], {
        data: {
          params: {
            adds: [{ min_delta_id: -2, max_delta_id: 2 }],
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(7);
    expect(ix.upper_bin_id).toBe(9);
  });

  it("falls through remove-side params when removes is omitted", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 20,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 3,
            y_withdrawn_amount: 0,
            old_min_id: 11,
            old_max_id: 19,
          },
        },
      ], {
        data: { params: { active_id: 20 } },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(11);
    expect(ix.upper_bin_id).toBe(19);
  });

  it("falls through rebalance params that have no add/remove lists", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 20,
            x_added_amount: 1,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
            new_min_id: 7,
            new_max_id: 9,
          },
        },
      ], {
        data: { params: { active_id: 20 } },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.lower_bin_id).toBe(7);
    expect(ix.upper_bin_id).toBe(9);
  });

  it("ignores unrelated programs that have no inner DLMM instructions", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("route", undefined, {
        programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
        includePosition: false,
        includePool: false,
      }),
    ]);

    expect(parseMeteoraTransaction(makeTx())).toEqual([]);
  });

  it("uses rebalance add deltas relative to active_id", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 50,
            x_added_amount: 5,
            y_added_amount: 0,
            x_withdrawn_amount: 0,
            y_withdrawn_amount: 0,
            new_min_id: 1,
            new_max_id: 200,
          },
        },
      ], {
        data: {
          params: {
            active_id: 50,
            removes: [],
            adds: [{ min_delta_id: -4, max_delta_id: 6 }],
          },
        },
      }),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("AddLiquidity");
    expect(ix.lower_bin_id).toBe(46);
    expect(ix.upper_bin_id).toBe(56);
  });

  it("falls back to old_min_id/old_max_id when the rebalance event has no new range", () => {
    mockedParseInstructions.mockReturnValue([
      makeIx("rebalance_liquidity", [
        {
          name: "Rebalancing",
          data: {
            active_bin_id: 50,
            x_added_amount: 0,
            y_added_amount: 0,
            x_withdrawn_amount: 9,
            y_withdrawn_amount: 0,
            old_min_id: 12,
            old_max_id: 18,
          },
        },
      ]),
    ]);

    const [ix] = parseMeteoraTransaction(makeTx());
    expect(ix.type).toBe("RemoveLiquidity");
    expect(ix.lower_bin_id).toBe(12);
    expect(ix.upper_bin_id).toBe(18);
  });
});
