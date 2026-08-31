import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { parseInstructions, ParsedInstructionWithEvents } from "@geeklad/solana-tx-parser";
import {
    DlmmInstructionType,
    DlmmInstruction,
    DlmmStrategy,
    DlmmBin,
    DlmmRebalanceAdd,
    DlmmRebalanceRemove,
    IDL_INSTRUCTION_MAP,
    DlmmAccounts,
} from "./types";
export type {
    DlmmInstructionType,
    DlmmInstruction,
    DlmmStrategy,
    DlmmBin,
    DlmmRebalanceAdd,
    DlmmRebalanceRemove,
    DlmmAccounts,
};
export type { DlmmRebalance } from "./types";
export { IDL_INSTRUCTION_MAP };

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
    const strategy_parameters = getStrategyParametersBlob(originalParsedInstruction);
    const bins = getBins(originalParsedInstruction);
    return [withDebug({
        ...base,
        type: txType,
        active_bin_id,
        lower_bin_id,
        upper_bin_id,
        strategy,
        amount_x,
        amount_y,
        strategy_parameters,
        bins,
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
    const params = getRebalanceParams(ix);
    const adds = getRebalanceAdds(params);
    const removes = getRebalanceRemoves(params);

    const x_added = event ? (toNumber(event.data.x_added_amount ?? event.data.xAddedAmount) ?? 0) : 0;
    const y_added = event ? (toNumber(event.data.y_added_amount ?? event.data.yAddedAmount) ?? 0) : 0;
    const x_withdrawn = event ? (toNumber(event.data.x_withdrawn_amount ?? event.data.xWithdrawnAmount) ?? 0) : 0;
    const y_withdrawn = event ? (toNumber(event.data.y_withdrawn_amount ?? event.data.yWithdrawnAmount) ?? 0) : 0;
    const active_bin_id = event
        ? toNumber(event.data.active_bin_id ?? event.data.activeBinId)
        : pickNumber(params, "active_id", "activeId");

    const shouldEmitAdd = x_added > 0 || y_added > 0 || adds.length > 0;
    const shouldEmitRemove = x_withdrawn > 0 || y_withdrawn > 0 || removes.length > 0;

    const results: DlmmInstruction[] = [];

    // Physical order: remove, then add
    if (shouldEmitRemove) {
        results.push(withDebug({
            ...base,
            type: "RemoveLiquidity",
            active_bin_id,
            ...getBinRange(ix, "remove"),
            amount_x: event ? x_withdrawn : undefined,
            amount_y: event ? y_withdrawn : undefined,
            rebalance: removes.length > 0 ? { removes } : undefined,
        }, ix, debug));
    }
    if (shouldEmitAdd) {
        const strategy = inferRebalanceStrategy(adds);
        results.push(withDebug({
            ...base,
            type: "AddLiquidity",
            active_bin_id,
            ...getBinRange(ix, "add"),
            strategy,
            amount_x: event ? x_added : undefined,
            amount_y: event ? y_added : undefined,
            rebalance: adds.length > 0 ? { adds } : undefined,
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

function getRebalanceParams(ix: ParsedInstructionWithEvents): Record<string, any> | undefined {
    const data = getInstructionData(ix);
    const params = data?.params;
    if (params && typeof params === "object") return params as Record<string, any>;
    return;
}

/**
 * Normalize decoded amounts to finite numbers.
 * Handles decimals, hex strings (e.g. "cef047ee"), BN-like objects, and little-endian byte arrays.
 */
function toNumber(value: unknown): number | undefined {
    if (value == null || value === "") return;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "bigint") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return;
        const asDecimal = Number(trimmed);
        if (Number.isFinite(asDecimal) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
            return asDecimal;
        }
        if (/^[0-9a-fA-F]+$/.test(trimmed)) {
            const asHex = Number.parseInt(trimmed, 16);
            return Number.isFinite(asHex) ? asHex : undefined;
        }
        return;
    }
    if (Array.isArray(value) || value instanceof Uint8Array) {
        const bytes = Array.from(value as ArrayLike<number>);
        if (bytes.length === 0 || bytes.some((b) => typeof b !== "number" || b < 0 || b > 255)) return;
        let result = 0;
        for (let i = bytes.length - 1; i >= 0; i--) {
            result = result * 256 + bytes[i];
        }
        return Number.isFinite(result) ? result : undefined;
    }
    if (typeof value === "object") {
        if ("toNumber" in value && typeof (value as { toNumber?: unknown }).toNumber === "function") {
            const parsed = (value as { toNumber: () => number }).toNumber();
            return Number.isFinite(parsed) ? parsed : undefined;
        }
        if ("toString" in value && typeof (value as { toString?: unknown }).toString === "function") {
            const asString = (value as { toString: (base?: number) => string }).toString(10);
            if (asString && asString !== "[object Object]") {
                return toNumber(asString);
            }
        }
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

function pickBoolean(source: Record<string, any> | undefined, ...keys: string[]): boolean | undefined {
    if (!source) return;
    for (const key of keys) {
        if (key in source) {
            const value = source[key];
            if (typeof value === "boolean") return value;
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

function getStrategyParametersBlob(ix: ParsedInstructionWithEvents): number[] | undefined {
    const data = getInstructionData(ix);
    const liquidityParameter = data?.liquidity_parameter ?? data?.liquidityParameter;
    const strategyParameters = liquidityParameter?.strategy_parameters ?? liquidityParameter?.strategyParameters;
    if (!strategyParameters) return;

    const raw = strategyParameters.parameteres ?? strategyParameters.parameters;
    if (!Array.isArray(raw) && !(raw instanceof Uint8Array)) return;

    const bytes = Array.from(raw as ArrayLike<number>);
    if (bytes.length === 0) return;
    if (bytes.some((b) => typeof b !== "number" || !Number.isInteger(b) || b < 0 || b > 255)) return;
    return bytes;
}

function mapBinEntry(entry: unknown): DlmmBin | undefined {
    if (entry == null || typeof entry !== "object") {
        if (typeof entry === "number" || typeof entry === "bigint" || typeof entry === "string") {
            const bin_id = toNumber(entry);
            return bin_id === undefined ? undefined : { bin_id };
        }
        return;
    }
    const record = entry as Record<string, any>;
    const bin_id = pickNumber(record, "bin_id", "binId");
    if (bin_id === undefined) return;

    const bin: DlmmBin = { bin_id };
    const weight = pickNumber(record, "weight");
    if (weight !== undefined) bin.weight = weight;

    const amount_x = pickNumber(
        record,
        "amount_x",
        "amountX",
        "distribution_x",
        "distributionX",
        "amount",
    );
    const amount_y = pickNumber(record, "amount_y", "amountY", "distribution_y", "distributionY");
    if (amount_x !== undefined) bin.amount_x = amount_x;
    if (amount_y !== undefined) bin.amount_y = amount_y;

    const bps = pickNumber(record, "bps", "bps_to_remove", "bpsToRemove");
    if (bps !== undefined) bin.bps = bps;

    return bin;
}

function getBins(ix: ParsedInstructionWithEvents): DlmmBin[] | undefined {
    const data = getInstructionData(ix);
    const liquidityParameter = data?.liquidity_parameter ?? data?.liquidityParameter ?? data?.parameter;
    const list =
        liquidityParameter?.bin_liquidity_dist
        ?? liquidityParameter?.binLiquidityDist
        ?? liquidityParameter?.bins
        ?? data?.bins
        ?? data?.bin_liquidity_removal
        ?? data?.binLiquidityRemoval;

    if (!Array.isArray(list) || list.length === 0) return;

    const bins = list.map(mapBinEntry).filter((bin): bin is DlmmBin => bin !== undefined);
    return bins.length > 0 ? bins : undefined;
}

function getRebalanceAdds(params: Record<string, any> | undefined): DlmmRebalanceAdd[] {
    if (!params || !Array.isArray(params.adds)) return [];
    const adds: DlmmRebalanceAdd[] = [];
    for (const entry of params.adds) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, any>;
        const min_delta_id = pickNumber(record, "min_delta_id", "minDeltaId");
        const max_delta_id = pickNumber(record, "max_delta_id", "maxDeltaId");
        if (min_delta_id === undefined || max_delta_id === undefined) continue;

        adds.push({
            min_delta_id,
            max_delta_id,
            x0: pickNumber(record, "x0") ?? 0,
            y0: pickNumber(record, "y0") ?? 0,
            delta_x: pickNumber(record, "delta_x", "deltaX") ?? 0,
            delta_y: pickNumber(record, "delta_y", "deltaY") ?? 0,
            favor_x_in_active_id: pickBoolean(record, "favor_x_in_active_id", "favorXInActiveId") ?? false,
            bit_flag: pickNumber(record, "bit_flag", "bitFlag") ?? 0,
        });
    }
    return adds;
}

function getRebalanceRemoves(params: Record<string, any> | undefined): DlmmRebalanceRemove[] {
    if (!params || !Array.isArray(params.removes)) return [];
    const removes: DlmmRebalanceRemove[] = [];
    for (const entry of params.removes) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, any>;
        const bps = pickNumber(record, "bps");
        if (bps === undefined) continue;
        const remove: DlmmRebalanceRemove = { bps };
        const min_bin_id = pickNumber(record, "min_bin_id", "minBinId");
        const max_bin_id = pickNumber(record, "max_bin_id", "maxBinId");
        if (min_bin_id !== undefined) remove.min_bin_id = min_bin_id;
        if (max_bin_id !== undefined) remove.max_bin_id = max_bin_id;
        removes.push(remove);
    }
    return removes;
}

function applyBitFlagSign(value: number, bitFlag: number, bit: number): number {
    return (bitFlag & bit) !== 0 ? -Math.abs(value) : value;
}

/**
 * Infer Spot/Curve/BidAsk from rebalance add params.
 * Spot: both deltas zero. Curve/BidAsk: signed delta slope toward/away from active.
 * Returns undefined when adds disagree or the shape is ambiguous.
 */
function inferRebalanceStrategy(adds: DlmmRebalanceAdd[]): DlmmStrategy | undefined {
    if (adds.length === 0) return;

    const inferred = adds.map(inferStrategyFromAdd);
    const known = inferred.filter((value): value is DlmmStrategy => value !== undefined);
    if (known.length === 0) return;
    if (known.every((value) => value === known[0])) return known[0];
    return;
}

function inferStrategyFromAdd(add: DlmmRebalanceAdd): DlmmStrategy | undefined {
    const deltaX = applyBitFlagSign(add.delta_x, add.bit_flag, 4);
    const deltaY = applyBitFlagSign(add.delta_y, add.bit_flag, 8);

    if (deltaX === 0 && deltaY === 0) return "Spot";

    const votes: DlmmStrategy[] = [];
    // Bid side (Y): amountY ≈ y0 + deltaY * (active - binId).
    // Negative deltaY → more near active (Curve); positive → more at edge (BidAsk).
    if (deltaY !== 0 || add.y0 !== 0) {
        if (deltaY < 0) votes.push("Curve");
        else if (deltaY > 0) votes.push("BidAsk");
    }
    // Ask side (X, pre-price): amountX ≈ x0 + deltaX * (binId - active).
    // Negative deltaX → more near active (Curve); positive → more at edge (BidAsk).
    if (deltaX !== 0 || add.x0 !== 0) {
        if (deltaX < 0) votes.push("Curve");
        else if (deltaX > 0) votes.push("BidAsk");
    }

    if (votes.length === 0) return;
    if (votes.every((value) => value === votes[0])) return votes[0];
    return;
}

function getAmounts(ix: ParsedInstructionWithEvents): {
    active_bin_id?: number;
    amount_x?: number;
    amount_y?: number;
} {
    const events = ix.events;

    if (events) {
        const addEvent = events.find((e) => e.name === "AddLiquidity");
        if (addEvent) {
            return {
                active_bin_id: toNumber(addEvent.data.active_bin_id ?? addEvent.data.activeBinId),
                amount_x: toNumber(addEvent.data.amounts?.[0]),
                amount_y: toNumber(addEvent.data.amounts?.[1]),
            };
        }

        const removeEvent = events.find((e) => e.name === "RemoveLiquidity");
        if (removeEvent) {
            return {
                active_bin_id: toNumber(removeEvent.data.active_bin_id ?? removeEvent.data.activeBinId),
                amount_x: toNumber(removeEvent.data.amounts?.[0]),
                amount_y: toNumber(removeEvent.data.amounts?.[1]),
            };
        }

        // ClaimFee2 takes priority as it also carries active_bin_id
        const claimFee2Event = events.find((e) => e.name === "ClaimFee2");
        if (claimFee2Event) {
            return {
                active_bin_id: toNumber(claimFee2Event.data.active_bin_id ?? claimFee2Event.data.activeBinId),
                amount_x: toNumber(claimFee2Event.data.fee_x ?? claimFee2Event.data.feeX),
                amount_y: toNumber(claimFee2Event.data.fee_y ?? claimFee2Event.data.feeY),
            };
        }

        const claimFeeEvent = events.find((e) => e.name === "ClaimFee");
        if (claimFeeEvent) {
            return {
                amount_x: toNumber(claimFeeEvent.data.fee_x ?? claimFeeEvent.data.feeX),
                amount_y: toNumber(claimFeeEvent.data.fee_y ?? claimFeeEvent.data.feeY),
            };
        }
    }

    return getAmountsFromArgs(ix);
}

function getAmountsFromArgs(ix: ParsedInstructionWithEvents): {
    active_bin_id?: number;
    amount_x?: number;
    amount_y?: number;
} {
    const data = getInstructionData(ix);
    const liquidityParameter = data?.liquidity_parameter ?? data?.liquidityParameter ?? data?.parameter;
    if (!liquidityParameter || typeof liquidityParameter !== "object") return {};

    const amount_x = pickNumber(liquidityParameter, "amount_x", "amountX");
    const amount_y = pickNumber(liquidityParameter, "amount_y", "amountY");
    const active_bin_id = pickNumber(liquidityParameter, "active_id", "activeId");
    if (amount_x === undefined && amount_y === undefined && active_bin_id === undefined) return {};
    return { active_bin_id, amount_x, amount_y };
}
