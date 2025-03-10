use crate::{
    abis::{gas::Gas, log_hash::ScopedLogHash, public_data_write::PublicDataWrite},
    constants::{
        AVM_ACCUMULATED_DATA_LENGTH, MAX_L2_TO_L1_MSGS_PER_TX, MAX_NOTE_HASHES_PER_TX,
        MAX_NULLIFIERS_PER_TX, MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX, MAX_UNENCRYPTED_LOGS_PER_TX,
    },
    messaging::l2_to_l1_message::ScopedL2ToL1Message,
    traits::{Deserialize, Empty, Serialize},
    utils::reader::Reader,
};

pub struct AvmAccumulatedData {
    // The note hashes from private combining with those made in the AVM execution.
    note_hashes: [Field; MAX_NOTE_HASHES_PER_TX],
    // The nullifiers from private combining with those made in the AVM execution.
    nullifiers: [Field; MAX_NULLIFIERS_PER_TX],
    // The L2 to L1 messages from private combining with those made in the AVM execution.
    l2_to_l1_msgs: [ScopedL2ToL1Message; MAX_L2_TO_L1_MSGS_PER_TX],
    // TODO(#9589): This should only contain logs emitted from public.
    // The unencrypted logs emitted from private combining with those made in the AVM execution.
    unencrypted_logs_hashes: [ScopedLogHash; MAX_UNENCRYPTED_LOGS_PER_TX],
    // The public data writes made in the AVM execution.
    public_data_writes: [PublicDataWrite; MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
}

impl Empty for AvmAccumulatedData {
    fn empty() -> Self {
        AvmAccumulatedData {
            note_hashes: [0; MAX_NOTE_HASHES_PER_TX],
            nullifiers: [0; MAX_NULLIFIERS_PER_TX],
            l2_to_l1_msgs: [ScopedL2ToL1Message::empty(); MAX_L2_TO_L1_MSGS_PER_TX],
            unencrypted_logs_hashes: [ScopedLogHash::empty(); MAX_UNENCRYPTED_LOGS_PER_TX],
            public_data_writes: [PublicDataWrite::empty(); MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
        }
    }
}

impl Serialize<AVM_ACCUMULATED_DATA_LENGTH> for AvmAccumulatedData {
    fn serialize(self) -> [Field; AVM_ACCUMULATED_DATA_LENGTH] {
        let mut fields: BoundedVec<Field, AVM_ACCUMULATED_DATA_LENGTH> = BoundedVec::new();

        for i in 0..self.note_hashes.len() {
            fields.extend_from_array(self.note_hashes[i].serialize());
        }

        for i in 0..self.nullifiers.len() {
            fields.extend_from_array(self.nullifiers[i].serialize());
        }

        for i in 0..self.l2_to_l1_msgs.len() {
            fields.extend_from_array(self.l2_to_l1_msgs[i].serialize());
        }

        for i in 0..self.unencrypted_logs_hashes.len() {
            fields.extend_from_array(self.unencrypted_logs_hashes[i].serialize());
        }

        for i in 0..self.public_data_writes.len() {
            fields.extend_from_array(self.public_data_writes[i].serialize());
        }

        assert_eq(fields.len(), AVM_ACCUMULATED_DATA_LENGTH);

        fields.storage()
    }
}

impl Deserialize<AVM_ACCUMULATED_DATA_LENGTH> for AvmAccumulatedData {
    fn deserialize(fields: [Field; AVM_ACCUMULATED_DATA_LENGTH]) -> AvmAccumulatedData {
        let mut reader = Reader::new(fields);

        let item = AvmAccumulatedData {
            note_hashes: reader.read_array(),
            nullifiers: reader.read_array(),
            l2_to_l1_msgs: reader.read_struct_array(
                ScopedL2ToL1Message::deserialize,
                [ScopedL2ToL1Message::empty(); MAX_L2_TO_L1_MSGS_PER_TX],
            ),
            unencrypted_logs_hashes: reader.read_struct_array(
                ScopedLogHash::deserialize,
                [ScopedLogHash::empty(); MAX_UNENCRYPTED_LOGS_PER_TX],
            ),
            public_data_writes: reader.read_struct_array(
                PublicDataWrite::deserialize,
                [PublicDataWrite::empty(); MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX],
            ),
        };
        reader.finish();
        item
    }
}

impl Eq for AvmAccumulatedData {
    fn eq(self, other: Self) -> bool {
        (self.note_hashes == other.note_hashes)
            & (self.nullifiers == other.nullifiers)
            & (self.l2_to_l1_msgs == other.l2_to_l1_msgs)
            & (self.unencrypted_logs_hashes == other.unencrypted_logs_hashes)
            & (self.public_data_writes == other.public_data_writes)
    }
}

#[test]
fn serialization_of_empty_avm_accumulated_data() {
    let item = AvmAccumulatedData::empty();
    let serialized = item.serialize();
    let deserialized = AvmAccumulatedData::deserialize(serialized);
    assert(item.eq(deserialized));
}
