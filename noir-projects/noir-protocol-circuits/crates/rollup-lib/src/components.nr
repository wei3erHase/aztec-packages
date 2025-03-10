use crate::abis::{
    base_or_merge_rollup_public_inputs::BaseOrMergeRollupPublicInputs,
    block_root_or_block_merge_public_inputs::{BlockRootOrBlockMergePublicInputs, FeeRecipient},
};
use crate::abis::{
    previous_rollup_block_data::PreviousRollupBlockData, previous_rollup_data::PreviousRollupData,
};
use dep::types::{
    abis::{
        accumulated_data::CombinedAccumulatedData,
        log_hash::{LogHash, ScopedLogHash},
        public_data_write::PublicDataWrite,
    },
    constants::{
        AZTEC_MAX_EPOCH_DURATION, MAX_CONTRACT_CLASS_LOGS_PER_TX, MAX_L2_TO_L1_MSGS_PER_TX,
        MAX_NOTE_HASHES_PER_TX, MAX_NULLIFIERS_PER_TX, MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
        MAX_UNENCRYPTED_LOGS_PER_TX,
    },
    hash::{
        accumulate_sha256, compute_tx_logs_hash, silo_encrypted_log_hash, silo_unencrypted_log_hash,
    },
    merkle_tree::VariableMerkleTree,
    traits::is_empty,
    utils::arrays::{array_length, array_merge},
};

/**
 * Asserts that the tree formed by rollup circuits is filled greedily from L to R
 *
 */
pub fn assert_txs_filled_from_left(
    left: BaseOrMergeRollupPublicInputs,
    right: BaseOrMergeRollupPublicInputs,
) {
    // assert that the left rollup is either a base (1 tx) or a balanced tree (num txs = power of 2)
    if (left.rollup_type == 1) {
        let left_txs = left.num_txs;
        let right_txs = right.num_txs;
        // See https://graphics.stanford.edu/~seander/bithacks.html#DetermineIfPowerOf2
        assert(
            (left_txs) & (left_txs - 1) == 0,
            "The rollup should be filled greedily from L to R, but received an unbalanced left subtree",
        );
        assert(
            right_txs <= left_txs,
            "The rollup should be filled greedily from L to R, but received a L txs < R txs",
        );
    } else {
        assert(
            right.rollup_type == 0,
            "The rollup should be filled greedily from L to R, but received a L base and R merge",
        );
    }
}

/**
 * Asserts that the constants used in the left and right child are identical
 *
 */
pub fn assert_equal_constants(
    left: BaseOrMergeRollupPublicInputs,
    right: BaseOrMergeRollupPublicInputs,
) {
    assert(left.constants.eq(right.constants), "input proofs have different constants");
}

// asserts that the end snapshot of previous_rollup 0 equals the start snapshot of previous_rollup 1 (i.e. ensure they
// follow on from one-another). Ensures that right uses the tres that was updated by left.
pub fn assert_prev_rollups_follow_on_from_each_other(
    left: BaseOrMergeRollupPublicInputs,
    right: BaseOrMergeRollupPublicInputs,
) {
    assert(
        left.end.note_hash_tree.eq(right.start.note_hash_tree),
        "input proofs have different note hash tree snapshots",
    );
    assert(
        left.end.nullifier_tree.eq(right.start.nullifier_tree),
        "input proofs have different nullifier tree snapshots",
    );
    assert(
        left.end.public_data_tree.eq(right.start.public_data_tree),
        "input proofs have different public data tree snapshots",
    );
}

// TODO(Miranda): split out?
pub fn assert_prev_block_rollups_follow_on_from_each_other(
    left: BlockRootOrBlockMergePublicInputs,
    right: BlockRootOrBlockMergePublicInputs,
) {
    assert(left.vk_tree_root == right.vk_tree_root, "input blocks have different vk tree roots");
    assert(
        left.protocol_contract_tree_root == right.protocol_contract_tree_root,
        "input blocks have different protocol contract tree roots",
    );
    assert(
        left.new_archive.eq(right.previous_archive),
        "input blocks have different archive tree snapshots",
    );
    assert(
        left.end_block_hash.eq(right.previous_block_hash),
        "input block hashes do not follow on from each other",
    );
    assert(
        left.end_global_variables.chain_id == right.start_global_variables.chain_id,
        "input blocks have different chain id",
    );
    assert(
        left.end_global_variables.version == right.start_global_variables.version,
        "input blocks have different chain version",
    );

    if right.is_padding() {
        assert(
            left.end_global_variables.block_number == right.start_global_variables.block_number,
            "input block numbers do not match",
        );
        assert(
            left.end_global_variables.timestamp == right.start_global_variables.timestamp,
            "input block timestamps do not match",
        );
    } else {
        assert(
            left.end_global_variables.block_number + 1 == right.start_global_variables.block_number,
            "input block numbers do not follow on from each other",
        );
        assert(
            left.end_global_variables.timestamp < right.start_global_variables.timestamp,
            "input block timestamps do not follow on from each other",
        );
    }
}

pub fn accumulate_fees(
    left: BaseOrMergeRollupPublicInputs,
    right: BaseOrMergeRollupPublicInputs,
) -> Field {
    left.accumulated_fees + right.accumulated_fees
}

pub fn accumulate_mana_used(
    left: BaseOrMergeRollupPublicInputs,
    right: BaseOrMergeRollupPublicInputs,
) -> Field {
    left.accumulated_mana_used + right.accumulated_mana_used
}

pub fn accumulate_blocks_fees(
    left: BlockRootOrBlockMergePublicInputs,
    right: BlockRootOrBlockMergePublicInputs,
) -> [FeeRecipient; AZTEC_MAX_EPOCH_DURATION] {
    let left_len = array_length(left.fees);
    let right_len = array_length(right.fees);
    assert(
        left_len + right_len <= AZTEC_MAX_EPOCH_DURATION,
        "too many fee payment structs accumulated in rollup",
    );
    // TODO(Miranda): combine fees with same recipient depending on rollup structure
    // Assuming that the final rollup tree (block root -> block merge -> root) has max 32 leaves (TODO: constrain in root), then
    // in the worst case, we would be checking the left 16 values (left_len = 16) against the right 16 (right_len = 16).
    // Either way, construct arr in unconstrained and make use of hints to point to merged fee array.
    array_merge(left.fees, right.fees)
}

/**
 * @brief From two previous rollup data, compute a single out hash
 *
 * @param previous_rollup_data
 * @return out hash stored in 2 fields
 */
pub fn compute_out_hash(previous_rollup_data: [PreviousRollupData; 2]) -> Field {
    accumulate_sha256([
        previous_rollup_data[0].base_or_merge_rollup_public_inputs.out_hash,
        previous_rollup_data[1].base_or_merge_rollup_public_inputs.out_hash,
    ])
}
// TODO(Miranda): combine fns?
pub fn compute_blocks_out_hash(previous_rollup_data: [PreviousRollupBlockData; 2]) -> Field {
    if previous_rollup_data[1].block_root_or_block_merge_public_inputs.is_padding() {
        previous_rollup_data[0].block_root_or_block_merge_public_inputs.out_hash
    } else {
        accumulate_sha256([
            previous_rollup_data[0].block_root_or_block_merge_public_inputs.out_hash,
            previous_rollup_data[1].block_root_or_block_merge_public_inputs.out_hash,
        ])
    }
}

pub fn compute_kernel_out_hash(l2_to_l1_msgs: [Field; MAX_L2_TO_L1_MSGS_PER_TX]) -> Field {
    let non_empty_items = array_length(l2_to_l1_msgs);
    let merkle_tree = VariableMerkleTree::new_sha(l2_to_l1_msgs, non_empty_items);
    merkle_tree.get_root()
}

/**
 * @brief From two previous rollup data, compute a single txs effects hash
 *
 * @param previous_rollup_data
 * @return The hash of the transaction effects stored in 2 fields
 */
pub fn compute_txs_effects_hash(previous_rollup_data: [PreviousRollupData; 2]) -> Field {
    accumulate_sha256([
        previous_rollup_data[0].base_or_merge_rollup_public_inputs.txs_effects_hash,
        previous_rollup_data[1].base_or_merge_rollup_public_inputs.txs_effects_hash,
    ])
}

fn silo_and_hash_unencrypted_logs<let N: u32>(
    unencrypted_logs_hashes: [ScopedLogHash; N],
) -> Field {
    let siloed_logs = unencrypted_logs_hashes.map(|log: ScopedLogHash| {
        LogHash {
            value: silo_unencrypted_log_hash(log),
            counter: log.log_hash.counter,
            length: log.log_hash.length,
        }
    });
    compute_tx_logs_hash(siloed_logs)
}

fn silo_and_hash_encrypted_logs(
    encrypted_logs_hashes: [ScopedLogHash; MAX_UNENCRYPTED_LOGS_PER_TX],
) -> Field {
    let siloed_encrypted_logs = encrypted_logs_hashes.map(|log: ScopedLogHash| {
        LogHash {
            value: silo_encrypted_log_hash(log),
            counter: log.log_hash.counter,
            length: log.log_hash.length,
        }
    });
    compute_tx_logs_hash(siloed_encrypted_logs)
}

// Tx effects hash consists of
// 1 field for revert code
// 1 field for transaction fee
// MAX_NOTE_HASHES_PER_TX fields for note hashes
// MAX_NULLIFIERS_PER_TX fields for nullifiers
// 1 field for L2 to L1 messages (represented by the out_hash)
// MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX public data update requests -> MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX * 2 fields
//                                          __
// 1 note encrypted logs length --> 1 field   |
// 1 encrypted logs length --> 1 field        | -> 4 types of logs - 4 fields for its lengths
// 1 unencrypted logs length --> 1 field      |
// 1 contract class logs length --> 1 field __|
//                                                                                                                                    __
// 1 note encrypted logs hash --> 1 sha256 hash -> 31 bytes -> 1 fields | Beware when populating bytes that we fill (prepend) to 32!    |
// 1 encrypted logs hash --> 1 sha256 hash -> 31 bytes -> 1 fields | Beware when populating bytes that we fill (prepend) to 32!         | -> 4 types of logs - 4 fields for its hashes
// 1 unencrypted logs hash --> 1 sha256 hash -> 31 bytes  -> 1 fields | Beware when populating bytes that we fill (prepend) to 32!      |
// 1 contract class logs hash --> 1 sha256 hash -> 31 bytes  -> 1 fields | Beware when populating bytes that we fill (prepend) to 32! __|
global TX_EFFECTS_HASH_INPUT_FIELDS: u32 = 1
    + 1
    + MAX_NOTE_HASHES_PER_TX
    + MAX_NULLIFIERS_PER_TX
    + 1
    + MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX * 2
    + 4
    + 4;

// Computes the tx effects hash for a base rollup (a single transaction)
pub fn compute_tx_effects_hash(
    combined: CombinedAccumulatedData,
    revert_code: u8,
    transaction_fee: Field,
    all_public_data_update_requests: [PublicDataWrite; MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
    out_hash: Field,
) -> Field {
    let mut tx_effects_hash_input = [0; TX_EFFECTS_HASH_INPUT_FIELDS];

    let note_hashes = combined.note_hashes;
    let nullifiers = combined.nullifiers;

    // Public writes are the concatenation of all non-empty user update requests and protocol update requests, then padded with zeroes.
    // The incoming all_public_data_update_requests may have empty update requests in the middle, so we move those to the end of the array.
    let public_data_update_requests =
        get_all_update_requests_for_tx_effects(all_public_data_update_requests);
    let note_logs_length = combined.note_encrypted_log_preimages_length;
    let encrypted_logs_length = combined.encrypted_log_preimages_length;
    let unencrypted_logs_length = combined.unencrypted_log_preimages_length;
    let contract_class_logs_length = combined.contract_class_log_preimages_length;
    let note_encrypted_logs_hash = compute_tx_logs_hash(combined.note_encrypted_logs_hashes);
    let encrypted_logs_hash = silo_and_hash_encrypted_logs(combined.encrypted_logs_hashes);
    let unencrypted_logs_hash = silo_and_hash_unencrypted_logs(combined.unencrypted_logs_hashes);
    let contract_class_logs_hash =
        silo_and_hash_unencrypted_logs(combined.contract_class_logs_hashes);

    let mut offset = 0;

    // REVERT CODE
    // upcast to Field to have the same size for the purposes of the hash
    tx_effects_hash_input[offset] = revert_code as Field;
    offset += 1;

    // TX FEE
    tx_effects_hash_input[offset] = transaction_fee;
    offset += 1;

    // NOTE HASHES
    for j in 0..MAX_NOTE_HASHES_PER_TX {
        tx_effects_hash_input[offset + j] = note_hashes[j];
    }
    offset += MAX_NOTE_HASHES_PER_TX;

    // NULLIFIERS
    for j in 0..MAX_NULLIFIERS_PER_TX {
        tx_effects_hash_input[offset + j] = nullifiers[j];
    }
    offset += MAX_NULLIFIERS_PER_TX;

    // L2 TO L1 MESSAGES
    tx_effects_hash_input[offset] = out_hash;
    offset += 1;

    // PUBLIC DATA UPDATE REQUESTS
    for j in 0..MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX {
        tx_effects_hash_input[offset + j * 2] = public_data_update_requests[j].leaf_slot;
        tx_effects_hash_input[offset + j * 2 + 1] = public_data_update_requests[j].value;
    }
    offset += MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX * 2;

    // NOTE ENCRYPTED LOGS LENGTH
    tx_effects_hash_input[offset] = note_logs_length;
    offset += 1;

    // ENCRYPTED LOGS LENGTH
    tx_effects_hash_input[offset] = encrypted_logs_length;
    offset += 1;

    // UNENCRYPTED LOGS LENGTH
    tx_effects_hash_input[offset] = unencrypted_logs_length;
    offset += 1;

    // CONTRACT CLASS LOGS LENGTH
    tx_effects_hash_input[offset] = contract_class_logs_length;
    offset += 1;

    // NOTE ENCRYPTED LOGS HASH
    tx_effects_hash_input[offset] = note_encrypted_logs_hash;
    offset += 1;

    // ENCRYPTED LOGS HASH
    tx_effects_hash_input[offset] = encrypted_logs_hash;
    offset += 1;

    // UNENCRYPTED LOGS HASH
    tx_effects_hash_input[offset] = unencrypted_logs_hash;
    offset += 1;

    // CONTRACT CLASS LOGS HASH
    tx_effects_hash_input[offset] = contract_class_logs_hash;
    offset += 1;

    assert_eq(offset, TX_EFFECTS_HASH_INPUT_FIELDS); // Sanity check
    let mut hash_input_flattened = [0; TX_EFFECTS_HASH_INPUT_FIELDS * 32];
    for offset in 0..TX_EFFECTS_HASH_INPUT_FIELDS {
        // TODO: This is not checking that the decomposition is smaller than P
        let input_as_bytes: [u8; 32] = tx_effects_hash_input[offset].to_be_radix(256);
        for byte_index in 0..32 {
            hash_input_flattened[offset * 32 + byte_index] = input_as_bytes[byte_index];
        }
    }

    let sha_digest = dep::types::hash::sha256_to_field(hash_input_flattened);
    sha_digest
}

fn get_all_update_requests_for_tx_effects(
    all_public_data_update_requests: [PublicDataWrite; MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
) -> [PublicDataWrite; MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX] {
    let mut all_update_requests: BoundedVec<PublicDataWrite, MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX> =
        BoundedVec::new();
    for update_request in all_public_data_update_requests {
        if !is_empty(update_request) {
            all_update_requests.push(update_request);
        }
    }
    all_update_requests.storage()
}

#[test]
fn consistent_TX_EFFECTS_HASH_INPUT_FIELDS() {
    let expected_size = 1 // revert code
        + 1 // transaction fee
        + MAX_NOTE_HASHES_PER_TX
        + MAX_NULLIFIERS_PER_TX
        + MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX * 2
        + 1 // out hash
        + 4 // logs lengths
        + 4; // logs hashes
    assert(
        TX_EFFECTS_HASH_INPUT_FIELDS == expected_size,
        "tx effects hash input size is incorrect",
    );
}
