import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { parseInstructions, ParsedInstructionWithEvents } from "@geeklad/solana-tx-parser";
import { DlmmInstructionType, DlmmInstruction, DlmmStrategy, IDL_INSTRUCTION_MAP, DlmmAccounts } from "./types";
export type { DlmmInstructionType, DlmmInstruction, DlmmStrategy, DlmmAccounts };
export { IDL_INSTRUCTION_MAP };
import { IdlType } from "@coral-xyz/anchor/dist/cjs/idl";

export function parseMeteoraTransaction(tx: ParsedTransactionWithMeta, debug = false): DlmmInstruction[] {
    const programId = LBCLMM_PROGRAM_IDS["mainnet-beta"];
    const idl = IDL as unknown as Idl;
    const parsedInstructions = parseInstructions([{idl, programId}], tx);
    const meteoraInstructionsAndInnerInstructions = parsedInstructions
        .filter((ix) => 
            ix.programId === programId
            || (ix.parsedInnerInstructions || []).some((innerIx) => innerIx.programId === programId
        ));
    const meteoraInstructions = meteoraInstructionsAndInnerInstructions
        .filter((ix) => ix.programId === programId)
        .concat(
            meteoraInstructionsAndInnerInstructions
                .flatMap((ix) => ix.parsedInnerInstructions || [])
                .filter((innerIx) => innerIx.programId === programId)
            );

    return meteoraInstructions.flatMap((ix) => parseMeteoraInstruction(tx, ix, debug));
}

function parseMeteoraInstruction(
    tx: ParsedTransactionWithMeta, 
    originalParsedInstruction: ParsedInstructionWithEvents,
    debug = false,
): DlmmInstruction[] {
    const { transaction, slot, blockTime } = tx;
    const signature = transaction.signatures[0];
    const signer = transaction.message.accountKeys[0].pubkey.toString();
    const timestamp = new Date(blockTime! * 1000);
    const fee = tx.meta!.fee;
    const txType = getTxType(originalParsedInstruction);
    if (txType === "Other") {
        return [];
    }
    const { pool, position } = getDlmmAccounts(originalParsedInstruction);
    const base = {
        signature,
        signer,
        slot,
        timestamp,
        fee,
        pool,
        position,
    };

    if (txType === "RebalanceLiquidity") {
        return splitRebalance(base, originalParsedInstruction, debug);
    }

    const { active_bin_id, amount_x, amount_y } = getAmounts(originalParsedInstruction);
    const { lower_bin_id, upper_bin_id } = getBinRange(originalParsedInstruction);
    const strategy = getStrategy(originalParsedInstruction);
    return [withDebug({
        ...base,
        type: txType,
        active_bin_id,
        lower_bin_id,
        upper_bin_id,
        strategy,
        amount_x,
        amount_y,
    }, originalParsedInstruction, debug)];
}

function withDebug(
    parsed: DlmmInstruction,
    originalParsedInstruction: ParsedInstructionWithEvents,
    debug: boolean,
): DlmmInstruction {
    if (debug) {
        parsed.originalParsedInstruction = originalParsedInstruction;
    }
    return parsed;
}

function splitRebalance(
    base: Omit<DlmmInstruction, "type">,
    ix: ParsedInstructionWithEvents,
    debug: boolean,
): DlmmInstruction[] {
    const event = ix.events?.find((entry) => entry.name === "Rebalancing");
    if (!event) {
        throw new Error("Could not find Rebalancing event in rebalance transaction");
    }

    const x_added = Number(event.data.x_added_amount);
    const y_added = Number(event.data.y_added_amount);
    const x_withdrawn = Number(event.data.x_withdrawn_amount);
    const y_withdrawn = Number(event.data.y_withdrawn_amount);
    const active_bin_id = event.data.active_bin_id;
    const results: DlmmInstruction[] = [];

    if (x_added > 0 || y_added > 0) {
        results.push(withDebug({
            ...base,
            type: "AddLiquidity",
            active_bin_id,
            ...getBinRange(ix, "add"),
            amount_x: x_added,
            amount_y: y_added,
        }, ix, debug));
    }
    if (x_withdrawn > 0 || y_withdrawn > 0) {
        results.push(withDebug({
            ...base,
            type: "RemoveLiquidity",
            active_bin_id,
            ...getBinRange(ix, "remove"),
            amount_x: x_withdrawn,
            amount_y: y_withdrawn,
        }, ix, debug));
    }
    return results;
}

function getTxType(ix: ParsedInstructionWithEvents): DlmmInstructionType {
    if (
        !("parsedInstruction" in ix)
        || ix.parsedInstruction === null
        || !("name" in ix.parsedInstruction)
    ) {
        return "Other";
    }
    return IDL_INSTRUCTION_MAP[ix.parsedInstruction.name as keyof typeof IDL_INSTRUCTION_MAP] ?? "Other";
}

function getDlmmAccounts(ix: ParsedInstructionWithEvents): DlmmAccounts {
    const accounts = ix.accounts?.reduce((accounts, acccount) => {
        if (acccount.name === "lb_pair") accounts.pool = acccount.pubkey;
        if (acccount.name === "position") accounts.position = acccount.pubkey;
        return accounts;
    }, {} as Partial<DlmmAccounts>);

    if (accounts?.position) {
        return accounts as { pool: string; position: string };
    }
    throw new Error("Could not find position account in instruction");
}

function getInstructionData(ix: ParsedInstructionWithEvents): Record<string, any> | undefined {
    const parsed = ix.parsedInstruction;
    if (!parsed || typeof parsed !== "object" || !("data" in parsed) || parsed.data == null) {
        return;
    }
    return parsed.data as Record<string, any>;
}

function toNumber(value: unknown): number | undefined {
    if (value == null || value === "") return;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "bigint") return Number(value);
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === "object" && "toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
        const parsed = (value as { toNumber: () => number }).toNumber();
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return;
}

function pickNumber(source: Record<string, any> | undefined, ...keys: string[]): number | undefined {
    if (!source) return;
    for (const key of keys) {
        if (key in source) {
            const value = toNumber(source[key]);
            if (value !== undefined) return value;
        }
    }
    return;
}

function binRangeFromIds(ids: number[]): { lower_bin_id: number; upper_bin_id: number } | undefined {
    if (ids.length === 0) return;
    return {
        lower_bin_id: Math.min(...ids),
        upper_bin_id: Math.max(...ids),
    };
}

function binIdsFromList(values: unknown): number[] {
    if (!Array.isArray(values)) return [];
    return values
        .map((entry) => {
            if (typeof entry === "number" || typeof entry === "bigint" || typeof entry === "string") {
                return toNumber(entry);
            }
            if (entry && typeof entry === "object") {
                return pickNumber(entry as Record<string, any>, "bin_id", "binId");
            }
            return;
        })
        .filter((id): id is number => id !== undefined);
}

function collectRebalanceRemoveIds(params: Record<string, any>): number[] {
    const ids: number[] = [];
    for (const remove of params.removes ?? []) {
        const min = pickNumber(remove, "min_bin_id", "minBinId");
        const max = pickNumber(remove, "max_bin_id", "maxBinId");
        if (min !== undefined) ids.push(min);
        if (max !== undefined) ids.push(max);
    }
    return ids;
}

function collectRebalanceAddIds(params: Record<string, any>): number[] {
    const ids: number[] = [];
    const activeId = pickNumber(params, "active_id", "activeId");
    if (activeId === undefined) return ids;
    for (const add of params.adds ?? []) {
        const minDelta = pickNumber(add, "min_delta_id", "minDeltaId");
        const maxDelta = pickNumber(add, "max_delta_id", "maxDeltaId");
        if (minDelta !== undefined) ids.push(activeId + minDelta);
        if (maxDelta !== undefined) ids.push(activeId + maxDelta);
    }
    return ids;
}

function pairRange(min?: number, max?: number): { lower_bin_id: number; upper_bin_id: number } | undefined {
    if (min === undefined || max === undefined) return;
    return { lower_bin_id: min, upper_bin_id: max };
}

function getRebalanceEventRange(
    ix: ParsedInstructionWithEvents,
    side?: "add" | "remove",
): { lower_bin_id?: number; upper_bin_id?: number } {
    const rebalancingEvent = ix.events?.find((event) => event.name === "Rebalancing");
    if (!rebalancingEvent) return {};

    const newRange = pairRange(
        toNumber(rebalancingEvent.data.new_min_id ?? rebalancingEvent.data.newMinId),
        toNumber(rebalancingEvent.data.new_max_id ?? rebalancingEvent.data.newMaxId),
    );
    const oldRange = pairRange(
        toNumber(rebalancingEvent.data.old_min_id ?? rebalancingEvent.data.oldMinId),
        toNumber(rebalancingEvent.data.old_max_id ?? rebalancingEvent.data.oldMaxId),
    );

    if (side === "add") return newRange ?? oldRange ?? {};
    if (side === "remove") return oldRange ?? newRange ?? {};
    return newRange ?? oldRange ?? {};
}

function getBinRange(
    ix: ParsedInstructionWithEvents,
    side?: "add" | "remove",
): {
    lower_bin_id?: number;
    upper_bin_id?: number;
} {
    const data = getInstructionData(ix);

    if (!side) {
        const lowerBinId = pickNumber(data, "lower_bin_id", "lowerBinId");
        const width = pickNumber(data, "width");
        if (lowerBinId !== undefined && width !== undefined) {
            return { lower_bin_id: lowerBinId, upper_bin_id: lowerBinId + width - 1 };
        }

        const fromBinId = pickNumber(data, "from_bin_id", "fromBinId");
        const toBinId = pickNumber(data, "to_bin_id", "toBinId");
        if (fromBinId !== undefined && toBinId !== undefined) {
            return { lower_bin_id: fromBinId, upper_bin_id: toBinId };
        }

        const liquidityParameter = data?.liquidity_parameter ?? data?.liquidityParameter ?? data?.parameter;
        const strategyParameters = liquidityParameter?.strategy_parameters ?? liquidityParameter?.strategyParameters;
        const strategyMin = pickNumber(strategyParameters, "min_bin_id", "minBinId");
        const strategyMax = pickNumber(strategyParameters, "max_bin_id", "maxBinId");
        if (strategyMin !== undefined && strategyMax !== undefined) {
            return { lower_bin_id: strategyMin, upper_bin_id: strategyMax };
        }

        const distributionRange = binRangeFromIds(binIdsFromList(
            liquidityParameter?.bin_liquidity_dist
            ?? liquidityParameter?.binLiquidityDist
            ?? liquidityParameter?.bins
            ?? data?.bins
            ?? data?.bin_liquidity_removal
            ?? data?.binLiquidityRemoval
        ));
        if (distributionRange) return distributionRange;

        const minBinId = pickNumber(data, "min_bin_id", "minBinId");
        const maxBinId = pickNumber(data, "max_bin_id", "maxBinId");
        if (minBinId !== undefined && maxBinId !== undefined) {
            return { lower_bin_id: minBinId, upper_bin_id: maxBinId };
        }
    }

    const rebalanceParams = data?.params;
    if (side && rebalanceParams && typeof rebalanceParams === "object") {
        const ids = side === "add"
            ? collectRebalanceAddIds(rebalanceParams)
            : collectRebalanceRemoveIds(rebalanceParams);
        const rebalanceRange = binRangeFromIds(ids);
        if (rebalanceRange) return rebalanceRange;
    }

    return getRebalanceEventRange(ix, side);
}

function parseStrategy(value: unknown): DlmmStrategy | undefined {
    if (value == null) return;

    let raw: string | undefined;
    if (typeof value === "string") {
        raw = value;
    } else if (typeof value === "number") {
        raw = ["Spot", "Curve", "BidAsk"][value];
    } else if (typeof value === "object") {
        raw = Object.keys(value as object)[0];
    }
    if (!raw) return;

    const normalized = raw.toLowerCase();
    if (normalized.includes("spot")) return "Spot";
    if (normalized.includes("curve")) return "Curve";
    if (normalized.includes("bid")) return "BidAsk";
    return;
}

function getStrategy(ix: ParsedInstructionWithEvents): DlmmStrategy | undefined {
    const data = getInstructionData(ix);
    const liquidityParameter = data?.liquidity_parameter ?? data?.liquidityParameter;
    const strategyParameters = liquidityParameter?.strategy_parameters ?? liquidityParameter?.strategyParameters;
    return parseStrategy(strategyParameters?.strategy_type ?? strategyParameters?.strategyType);
}

function getAmounts(ix: ParsedInstructionWithEvents): {
    active_bin_id?: number;
    amount_x?: number;
    amount_y?: number;
} {
    const events = ix.events;
    if (!events) return {};

    const addEvent = events.find((e) => e.name === "AddLiquidity");
    if (addEvent) {
        return {
            active_bin_id: addEvent.data.active_bin_id,
            amount_x: Number(addEvent.data.amounts[0]),
            amount_y: Number(addEvent.data.amounts[1]),
        };
    }

    const removeEvent = events.find((e) => e.name === "RemoveLiquidity");
    if (removeEvent) {
        return {
            active_bin_id: removeEvent.data.active_bin_id,
            amount_x: Number(removeEvent.data.amounts[0]),
            amount_y: Number(removeEvent.data.amounts[1]),
        };
    }

    // ClaimFee2 takes priority as it also carries active_bin_id
    const claimFee2Event = events.find((e) => e.name === "ClaimFee2");
    if (claimFee2Event) {
        return {
            active_bin_id: claimFee2Event.data.active_bin_id,
            amount_x: Number(claimFee2Event.data.fee_x),
            amount_y: Number(claimFee2Event.data.fee_y),
        };
    }

    const claimFeeEvent = events.find((e) => e.name === "ClaimFee");
    if (claimFeeEvent) {
        return {
            amount_x: Number(claimFeeEvent.data.fee_x),
            amount_y: Number(claimFeeEvent.data.fee_y),
        };
    }

    return {};
}