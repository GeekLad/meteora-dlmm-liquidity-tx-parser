import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { Idl } from "@coral-xyz/anchor";
import { IDL, LBCLMM_PROGRAM_IDS } from "@meteora-ag/dlmm";
import { parseInstructions, ParsedInstructionWithEvents } from "@geeklad/solana-tx-parser";
import { DlmmInstructionType, DlmmInstruction, IDL_INSTRUCTION_MAP, DlmmAccounts } from "./types";
export type { DlmmInstructionType, DlmmInstruction, DlmmAccounts };
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

    if (debug) {
        return {
            signature,
            signer,
            slot,
            timestamp,
            fee,
            type: txType,
            pool,
            position,
            active_bin_id,
            amount_x,
            amount_y,
            originalParsedInstruction,
        };
    }
    return {
        signature,
        signer,
        slot,
        timestamp,
        fee,
        type: txType,
        pool,
        position,
        active_bin_id,
        amount_x,
        amount_y,
    };
}

function getTxType(ix: ParsedInstructionWithEvents): DlmmInstructionType {
    const txType = "parsedInstruction" in ix 
        && ix.parsedInstruction !== null 
        && "name" in ix.parsedInstruction 
            ? IDL_INSTRUCTION_MAP[ix.parsedInstruction.name] 
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
        if ((x_added_amount > 0 || y_added_amount > 0) && (x_withdrawn_amount == 0 || y_withdrawn_amount == 0)) {
            return "AddLiquidity";
        }
        if ((x_added_amount == 0 || y_added_amount == 0) && (x_withdrawn_amount > 0 || y_withdrawn_amount > 0)) {
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