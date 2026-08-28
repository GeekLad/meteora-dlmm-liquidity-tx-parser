import { BorshInstructionCoder, Idl } from "@coral-xyz/anchor";
import { IDL } from "@meteora-ag/dlmm";
import { IDL_INSTRUCTION_MAP, DlmmInstructionType } from "../src/types";

const idlInstructionNames = IDL.instructions.map((ix) => ix.name);
const mappedNames = Object.keys(IDL_INSTRUCTION_MAP);

function expectedType(name: string): DlmmInstructionType {
  if (name.startsWith("initialize_position")) return "CreatePosition";
  if (name.startsWith("close_position")) return "ClosePosition";
  if (name.startsWith("add_liquidity")) return "AddLiquidity";
  if (name === "remove_all_liquidity" || name.startsWith("remove_liquidity")) {
    return "RemoveLiquidity";
  }
  if (name === "rebalance_liquidity") return "RebalanceLiquidity";
  if (name.startsWith("claim_fee")) return "ClaimFees";
  if (name.startsWith("claim_reward")) return "ClaimRewards";
  return "Other";
}

function accountNames(ixName: string): string[] {
  const ix = IDL.instructions.find((instruction) => instruction.name === ixName);
  if (!ix) return [];
  return (ix.accounts ?? []).map((account) => account.name);
}

function structFieldNames(typeName: string): string[] {
  const typeDef = IDL.types.find((entry) => entry.name === typeName);
  if (!typeDef || typeDef.type.kind !== "struct" || !typeDef.type.fields) return [];
  return typeDef.type.fields.map((field) => field.name);
}

describe("IDL_INSTRUCTION_MAP completeness", () => {
  it("maps every instruction in the current @meteora-ag/dlmm IDL", () => {
    const missing = idlInstructionNames.filter((name) => !(name in IDL_INSTRUCTION_MAP));
    expect(missing).toEqual([]);
  });

  it("does not contain instruction names that are absent from the IDL", () => {
    const extra = mappedNames.filter((name) => !idlInstructionNames.includes(name));
    expect(extra).toEqual([]);
  });

  it("has the same size as the IDL instruction list", () => {
    expect(mappedNames).toHaveLength(idlInstructionNames.length);
    expect(new Set(mappedNames).size).toBe(idlInstructionNames.length);
  });
});

describe("IDL instruction name matching", () => {
  it("uses the exact IDL instruction names as map keys", () => {
    expect([...mappedNames].sort()).toEqual([...idlInstructionNames].sort());
  });

  it("classifies each instruction name consistently with its IDL name", () => {
    const mismatches = idlInstructionNames
      .map((name) => ({
        name,
        mapped: IDL_INSTRUCTION_MAP[name as keyof typeof IDL_INSTRUCTION_MAP],
        expected: expectedType(name),
      }))
      .filter((entry) => entry.mapped !== entry.expected);

    expect(mismatches).toEqual([]);
  });

  it("round-trips zero-arg instruction names through the Anchor instruction coder", () => {
    const coder = new BorshInstructionCoder(IDL as unknown as Idl);
    const zeroArgInstructions = IDL.instructions.filter((ix) => ix.args.length === 0);

    expect(zeroArgInstructions.length).toBeGreaterThan(0);

    for (const ix of zeroArgInstructions) {
      const encoded = coder.encode(ix.name, {});
      const decoded = coder.decode(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.name).toBe(ix.name);
      expect(IDL_INSTRUCTION_MAP[decoded!.name as keyof typeof IDL_INSTRUCTION_MAP]).toBeDefined();
    }
  });
});

describe("account names used by the parser", () => {
  it("uses lb_pair and position account names that exist on liquidity instructions", () => {
    const liquidityInstructions = mappedNames.filter(
      (name) => IDL_INSTRUCTION_MAP[name as keyof typeof IDL_INSTRUCTION_MAP] !== "Other"
    );

    expect(liquidityInstructions.length).toBeGreaterThan(0);

    for (const name of liquidityInstructions) {
      const accounts = accountNames(name);
      expect(accounts).toContain("position");
    }

    const withPool = liquidityInstructions.filter((name) => accountNames(name).includes("lb_pair"));
    expect(withPool.length).toBeGreaterThan(0);
  });
});

describe("event names and fields used by the parser", () => {
  const eventNames = new Set((IDL.events ?? []).map((event) => event.name));

  it("keeps parser event names aligned with the IDL", () => {
    for (const name of [
      "AddLiquidity",
      "RemoveLiquidity",
      "ClaimFee",
      "ClaimFee2",
      "Rebalancing",
    ]) {
      expect(eventNames.has(name)).toBe(true);
    }
  });

  it("keeps parser event field names aligned with IDL types", () => {
    expect(structFieldNames("AddLiquidity")).toEqual(
      expect.arrayContaining(["active_bin_id", "amounts"])
    );
    expect(structFieldNames("RemoveLiquidity")).toEqual(
      expect.arrayContaining(["active_bin_id", "amounts"])
    );
    expect(structFieldNames("ClaimFee")).toEqual(
      expect.arrayContaining(["fee_x", "fee_y"])
    );
    expect(structFieldNames("ClaimFee2")).toEqual(
      expect.arrayContaining(["active_bin_id", "fee_x", "fee_y"])
    );
    expect(structFieldNames("Rebalancing")).toEqual(
      expect.arrayContaining([
        "active_bin_id",
        "x_added_amount",
        "y_added_amount",
        "x_withdrawn_amount",
        "y_withdrawn_amount",
      ])
    );
  });
});
