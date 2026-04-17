import { IDL } from "@meteora-ag/dlmm";
import { ParsedInstructionWithEvents } from "@geeklad/solana-tx-parser";
export type DlmmInstructionType = "CreatePosition" | "ClosePosition" | "AddLiquidity" | "RemoveLiquidity" | "RebalanceLiquidity"  | "ClaimFees" | "ClaimRewards" | "Other";
export type DlmmAccounts = { pool: string; position: string };

export interface DlmmInstruction {
    signature: string;
    signer: string;
    slot: number;
    timestamp: Date;
    fee: number;
    type: DlmmInstructionType;
    position: string;
    pool?: string;
    active_bin_id?: number;
    amount_x?: number;
    amount_y?: number;
    originalParsedInstruction?: ParsedInstructionWithEvents;
}

type IDLInstructionName = typeof IDL.instructions[number]["name"]
export const IDL_INSTRUCTION_MAP: Record<IDLInstructionName, DlmmInstructionType> = {
    initialize_position: "CreatePosition",
    initialize_position2: "CreatePosition",
    initialize_position_by_operator: "CreatePosition",
    initialize_position_pda: "CreatePosition",
    close_position: "ClosePosition",
    close_position2: "ClosePosition",
    close_position_if_empty: "ClosePosition",
    add_liquidity: "AddLiquidity",
    add_liquidity2: "AddLiquidity",
    add_liquidity_by_strategy: "AddLiquidity",
    add_liquidity_by_strategy2: "AddLiquidity",
    add_liquidity_by_strategy_one_side: "AddLiquidity",
    add_liquidity_by_weight: "AddLiquidity",
    add_liquidity_one_side: "AddLiquidity",
    add_liquidity_one_side_precise: "AddLiquidity",
    add_liquidity_one_side_precise2: "AddLiquidity",
    remove_liquidity: "RemoveLiquidity",
    remove_liquidity2: "RemoveLiquidity",
    remove_liquidity_by_range: "RemoveLiquidity",
    remove_liquidity_by_range2: "RemoveLiquidity",
    remove_all_liquidity: "RemoveLiquidity",
    rebalance_liquidity: "RebalanceLiquidity",
    claim_fee: "ClaimFees",
    claim_fee2: "ClaimFees",
    claim_reward: "ClaimRewards",
    claim_reward2: "ClaimRewards",
    initialize_bin_array: "Other",
    initialize_lb_pair: "Other",
    initialize_lb_pair2: "Other",
    initialize_customizable_permissionless_lb_pair: "Other",
    initialize_customizable_permissionless_lb_pair2: "Other",
    initialize_permission_lb_pair: "Other",
    go_to_a_bin: "Other",
    fund_reward: "Other",
    withdraw_ineligible_reward: "Other",
    initialize_reward: "Other",
    initialize_token_badge: "Other",
    create_operator_account: "Other",
    update_fees_and_rewards: "Other",
    update_fees_and_reward2: "Other",
    update_reward_duration: "Other",
    update_reward_funder: "Other",
    swap: "Other",
    swap2: "Other",
    swap_exact_out: "Other",
    swap_exact_out2: "Other",
    swap_with_price_impact: "Other",
    swap_with_price_impact2: "Other",
    set_pair_status: "Other",
    set_pair_status_permissionless: "Other",
    set_pre_activation_duration: "Other",
    set_pre_activation_swap_address: "Other",
    update_base_fee_parameters: "Other",
    update_dynamic_fee_parameters: "Other",
    migrate_position: "Other",
    zap_protocol_fee: "Other",
    withdraw_protocol_fee: "Other",
    close_claim_fee_operator_account: "Other",
    close_operator_account: "Other",
    increase_position_length: "Other",
    increase_position_length2: "Other",
    decrease_position_length: "Other",
    set_activation_point: "Other",
};
