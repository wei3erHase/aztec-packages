import { jsonStringify } from '@aztec/foundation/json-rpc';

import {
  L2BlockL2Logs as BaseL2BlockL2Logs,
  ContractClass2BlockL2Logs,
  EncryptedL2BlockL2Logs,
  EncryptedNoteL2BlockL2Logs,
  UnencryptedL2BlockL2Logs,
} from './l2_block_l2_logs.js';

function shouldBehaveLikeL2BlockL2Logs(
  L2BlockL2Logs:
    | typeof EncryptedNoteL2BlockL2Logs
    | typeof UnencryptedL2BlockL2Logs
    | typeof EncryptedL2BlockL2Logs
    | typeof ContractClass2BlockL2Logs,
) {
  describe(L2BlockL2Logs.name, () => {
    it('can encode L2Logs to buffer and back', () => {
      const l2Logs =
        L2BlockL2Logs.name == 'ContractClass2BlockL2Logs'
          ? L2BlockL2Logs.random(3, 1, 1)
          : L2BlockL2Logs.random(3, 4, 2);

      const buffer = l2Logs.toBuffer();
      const recovered = L2BlockL2Logs.fromBuffer(buffer);

      expect(recovered).toEqual(l2Logs);
    });

    it('getSerializedLength returns the correct length', () => {
      const l2Logs =
        L2BlockL2Logs.name == 'ContractClass2BlockL2Logs'
          ? L2BlockL2Logs.random(3, 1, 1)
          : L2BlockL2Logs.random(3, 4, 2);

      const buffer = l2Logs.toBuffer();
      const recovered = L2BlockL2Logs.fromBuffer(buffer);
      if (L2BlockL2Logs.name == 'EncryptedL2BlockL2Logs') {
        // For event logs, we don't 'count' the maskedContractAddress as part of the
        // log length, since it's just for siloing later on
        expect(recovered.getSerializedLength()).toEqual(buffer.length - 24 * 32);
      } else {
        expect(recovered.getSerializedLength()).toEqual(buffer.length);
      }
    });

    it('serializes to and from JSON via schema', () => {
      const l2Logs =
        L2BlockL2Logs.name == 'ContractClass2BlockL2Logs'
          ? L2BlockL2Logs.random(3, 1, 1)
          : L2BlockL2Logs.random(3, 4, 2);
      const json = jsonStringify(l2Logs);
      const recovered = BaseL2BlockL2Logs.schema.parse(JSON.parse(json));
      expect(recovered).toEqual(l2Logs);
      expect(recovered).toBeInstanceOf(L2BlockL2Logs);
    });
  });
}

shouldBehaveLikeL2BlockL2Logs(EncryptedNoteL2BlockL2Logs);
shouldBehaveLikeL2BlockL2Logs(UnencryptedL2BlockL2Logs);
shouldBehaveLikeL2BlockL2Logs(EncryptedL2BlockL2Logs);
shouldBehaveLikeL2BlockL2Logs(ContractClass2BlockL2Logs);
