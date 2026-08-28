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

    return meteoraInstructions
        .map((ix) => parseMeteoraInstruction(tx, ix, debug))
        .filter((ix) => !!ix);
}

function parseMeteoraInstruction(
    tx: ParsedTransactionWithMeta, 
    originalParsedInstruction: ParsedInstructionWithEvents,
    debug = false,
): DlmmInstruction | undefined {
    const { transaction, slot, blockTime } = tx;
    const signature = transaction.signatures[0];
    const signer = transaction.message.accountKeys[0].pubkey.toString();
    const timestamp = new Date(blockTime! * 1000);
    const fee = tx.meta!.fee;
    const txType = getTxType(originalParsedInstruction);
    if (txType === "Other") {
        return;
    }
    const { pool, position } = getDlmmAccounts(originalParsedInstruction);
    const { active_bin_id, amount_x, amount_y } = getAmounts(originalParsedInstruction);
    const { lower_bin_id, upper_bin_id } = getBinRange(originalParsedInstruction);
    const strategy = getStrategy(originalParsedInstruction);

    const parsed: DlmmInstruction = {
        signature,
        signer,
        slot,
        timestamp,
        fee,
        type: txType,
        pool,
        position,
        active_bin_id,
        lower_bin_id,
        upper_bin_id,
        strategy,
        amount_x,
        amount_y,
    };
    if (debug) {
        parsed.originalParsedInstruction = originalParsedInstruction;
    }
    return parsed;
}

function getTxType(ix: ParsedInstructionWithEvents): DlmmInstructionType {
    const txType = "parsedInstruction" in ix
        && ix.parsedInstruction !== null
        && "name" in ix.parsedInstruction
            ? IDL_INSTRUCTION_MAP[ix.parsedInstruction.name as keyof typeof IDL_INSTRUCTION_MAP] ?? "Other"
            : "Other";
    if (txType !== "RebalanceLiquidity") {
        return txType;
    }
    const event = ix.events?.find((event) => event.name === "Rebalancing");
    if (event) {
        const x_added_amount = Number(event.data.x_added_amount);
        const y_added_amount = Number(event.data.y_added_amount);
        const x_withdrawn_amount = Number(event.data.x_withdrawn_amount);
        const y_withdrawn_amount = Number(event.data.y_withdrawn_amount);
        const added = x_added_amount > 0 || y_added_amount > 0;
        const withdrawn = x_withdrawn_amount > 0 || y_withdrawn_amount > 0;
        if (added && !withdrawn) {
            return "AddLiquidity";
        }
        if (withdrawn && !added) {
            return "RemoveLiquidity";
        }
        return "Other";
    }
    throw new Error("Could not find Rebalancing event in rebalance transaction");
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

function getBinRange(ix: ParsedInstructionWithEvents): {
    lower_bin_id?: number;
    upper_bin_id?: number;
} {
    const data = getInstructionData(ix);

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

    const rebalanceParams = data?.params;
    if (rebalanceParams && typeof rebalanceParams === "object") {
        const ids: number[] = [];
        for (const remove of rebalanceParams.removes ?? []) {
            const min = pickNumber(remove, "min_bin_id", "minBinId");
            const max = pickNumber(remove, "max_bin_id", "maxBinId");
            if (min !== undefined) ids.push(min);
            if (max !== undefined) ids.push(max);
        }
        const activeId = pickNumber(rebalanceParams, "active_id", "activeId");
        if (activeId !== undefined) {
            for (const add of rebalanceParams.adds ?? []) {
                const minDelta = pickNumber(add, "min_delta_id", "minDeltaId");
                const maxDelta = pickNumber(add, "max_delta_id", "maxDeltaId");
                if (minDelta !== undefined) ids.push(activeId + minDelta);
                if (maxDelta !== undefined) ids.push(activeId + maxDelta);
            }
        }
        const rebalanceRange = binRangeFromIds(ids);
        if (rebalanceRange) return rebalanceRange;
    }

    const rebalancingEvent = ix.events?.find((event) => event.name === "Rebalancing");
    if (rebalancingEvent) {
        const newMin = toNumber(rebalancingEvent.data.new_min_id ?? rebalancingEvent.data.newMinId);
        const newMax = toNumber(rebalancingEvent.data.new_max_id ?? rebalancingEvent.data.newMaxId);
        if (newMin !== undefined && newMax !== undefined) {
            return { lower_bin_id: newMin, upper_bin_id: newMax };
        }
        const oldMin = toNumber(rebalancingEvent.data.old_min_id ?? rebalancingEvent.data.oldMinId);
        const oldMax = toNumber(rebalancingEvent.data.old_max_id ?? rebalancingEvent.data.oldMaxId);
        if (oldMin !== undefined && oldMax !== undefined) {
            return { lower_bin_id: oldMin, upper_bin_id: oldMax };
        }
    }

    return {};
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

    const rebalancingEvent = events.find((e) => e.name === "Rebalancing");
    if (rebalancingEvent) {
        const x_added = Number(rebalancingEvent.data.x_added_amount);
        const y_added = Number(rebalancingEvent.data.y_added_amount);
        const x_withdrawn = Number(rebalancingEvent.data.x_withdrawn_amount);
        const y_withdrawn = Number(rebalancingEvent.data.y_withdrawn_amount);
        // getTxType already validated this is either add-only or remove-only
        const isAdd = x_added > 0 || y_added > 0;
        return {
            active_bin_id: rebalancingEvent.data.active_bin_id,
            amount_x: isAdd ? x_added : x_withdrawn,
            amount_y: isAdd ? y_added : y_withdrawn,
        };
    }

    return {};
}