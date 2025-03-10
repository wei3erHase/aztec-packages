import { UnencryptedL2Log } from '@aztec/circuit-types';
import {
  AztecAddress,
  EthAddress,
  L2ToL1Message,
  LogHash,
  MAX_L1_TO_L2_MSG_READ_REQUESTS_PER_TX,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NOTE_HASH_READ_REQUESTS_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_NULLIFIER_NON_EXISTENT_READ_REQUESTS_PER_TX,
  MAX_NULLIFIER_READ_REQUESTS_PER_TX,
  MAX_PUBLIC_DATA_READS_PER_TX,
  MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  MAX_UNENCRYPTED_LOGS_PER_TX,
  NoteHash,
  Nullifier,
  NullifierLeafPreimage,
  PublicDataRead,
  PublicDataTreeLeafPreimage,
  PublicDataUpdateRequest,
  ReadRequest,
  SerializableContractInstance,
  TreeLeafReadRequest,
} from '@aztec/circuits.js';
import { computePublicDataTreeLeafSlot, siloNullifier } from '@aztec/circuits.js/hash';
import { Fr } from '@aztec/foundation/fields';

import { randomInt } from 'crypto';

import { PublicEnqueuedCallSideEffectTrace, SideEffectArrayLengths } from './enqueued_call_side_effect_trace.js';
import { SideEffectLimitReachedError } from './side_effect_errors.js';

describe('Enqueued-call Side Effect Trace', () => {
  const address = AztecAddress.random();
  const utxo = Fr.random();
  const leafIndex = Fr.random();
  const slot = Fr.random();
  const value = Fr.random();
  const recipient = Fr.random();
  const content = Fr.random();
  const log = [Fr.random(), Fr.random(), Fr.random()];
  const contractInstance = SerializableContractInstance.default();

  let startCounter: number;
  let startCounterFr: Fr;
  let startCounterPlus1: number;
  let trace: PublicEnqueuedCallSideEffectTrace;

  beforeEach(() => {
    startCounter = randomInt(/*max=*/ 1000000);
    startCounterFr = new Fr(startCounter);
    startCounterPlus1 = startCounter + 1;
    trace = new PublicEnqueuedCallSideEffectTrace(startCounter);
  });

  it('Should trace storage reads', () => {
    const leafPreimage = new PublicDataTreeLeafPreimage(slot, value, Fr.ZERO, 0n);
    trace.tracePublicStorageRead(address, slot, value, leafPreimage, Fr.ZERO, []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const leafSlot = computePublicDataTreeLeafSlot(address, slot);
    const expected = [new PublicDataRead(leafSlot, value, startCounter /*contractAddress*/)];
    expect(trace.getSideEffects().publicDataReads).toEqual(expected);

    expect(trace.getAvmCircuitHints().storageValues.items).toEqual([{ key: startCounterFr, value }]);
  });

  it('Should trace storage writes', () => {
    const lowLeafPreimage = new PublicDataTreeLeafPreimage(slot, value, Fr.ZERO, 0n);
    const newLeafPreimage = new PublicDataTreeLeafPreimage(slot, value, Fr.ZERO, 0n);

    trace.tracePublicStorageWrite(address, slot, value, lowLeafPreimage, Fr.ZERO, [], newLeafPreimage, []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const leafSlot = computePublicDataTreeLeafSlot(address, slot);
    const expected = [new PublicDataUpdateRequest(leafSlot, value, startCounter /*contractAddress*/)];
    expect(trace.getSideEffects().publicDataWrites).toEqual(expected);
  });

  it('Should trace note hash checks', () => {
    const exists = true;
    trace.traceNoteHashCheck(address, utxo, leafIndex, exists, []);

    const expected = [new TreeLeafReadRequest(utxo, leafIndex)];
    expect(trace.getSideEffects().noteHashReadRequests).toEqual(expected);

    expect(trace.getAvmCircuitHints().noteHashExists.items).toEqual([{ key: leafIndex, value: new Fr(exists) }]);
  });

  it('Should trace note hashes', () => {
    trace.traceNewNoteHash(address, utxo, Fr.ZERO, []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const expected = [new NoteHash(utxo, startCounter).scope(address)];
    expect(trace.getSideEffects().noteHashes).toEqual(expected);
  });

  it('Should trace nullifier checks', () => {
    const exists = true;
    const lowLeafPreimage = new NullifierLeafPreimage(utxo, Fr.ZERO, 0n);
    trace.traceNullifierCheck(address, utxo, exists, lowLeafPreimage, Fr.ZERO, []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const { nullifierReadRequests, nullifierNonExistentReadRequests } = trace.getSideEffects();
    const expected = [new ReadRequest(utxo, startCounter).scope(address)];
    expect(nullifierReadRequests).toEqual(expected);
    expect(nullifierNonExistentReadRequests).toEqual([]);

    expect(trace.getAvmCircuitHints().nullifierExists.items).toEqual([{ key: startCounterFr, value: new Fr(exists) }]);
  });

  it('Should trace non-existent nullifier checks', () => {
    const exists = false;
    const lowLeafPreimage = new NullifierLeafPreimage(utxo, Fr.ZERO, 0n);
    trace.traceNullifierCheck(address, utxo, exists, lowLeafPreimage, Fr.ZERO, []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const { nullifierReadRequests, nullifierNonExistentReadRequests } = trace.getSideEffects();
    expect(nullifierReadRequests).toEqual([]);

    const expected = [new ReadRequest(utxo, startCounter).scope(address)];
    expect(nullifierNonExistentReadRequests).toEqual(expected);

    expect(trace.getAvmCircuitHints().nullifierExists.items).toEqual([{ key: startCounterFr, value: new Fr(exists) }]);
  });

  it('Should trace nullifiers', () => {
    const lowLeafPreimage = new NullifierLeafPreimage(utxo, Fr.ZERO, 0n);
    trace.traceNewNullifier(address, utxo, lowLeafPreimage, Fr.ZERO, [], []);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const expected = [new Nullifier(siloNullifier(address, utxo), startCounter, Fr.ZERO)];
    expect(trace.getSideEffects().nullifiers).toEqual(expected);
  });

  it('Should trace L1ToL2 Message checks', () => {
    const exists = true;
    trace.traceL1ToL2MessageCheck(address, utxo, leafIndex, exists, []);

    const expected = [new TreeLeafReadRequest(utxo, leafIndex)];
    expect(trace.getSideEffects().l1ToL2MsgReadRequests).toEqual(expected);

    expect(trace.getAvmCircuitHints().l1ToL2MessageExists.items).toEqual([
      {
        key: leafIndex,
        value: new Fr(exists),
      },
    ]);
  });

  it('Should trace new L2ToL1 messages', () => {
    trace.traceNewL2ToL1Message(address, recipient, content);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const expected = [new L2ToL1Message(EthAddress.fromField(recipient), content, startCounter).scope(address)];
    expect(trace.getSideEffects().l2ToL1Msgs).toEqual(expected);
  });

  it('Should trace new unencrypted logs', () => {
    trace.traceUnencryptedLog(address, log);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    const expectedLog = new UnencryptedL2Log(address, Buffer.concat(log.map(f => f.toBuffer())));
    const expectedHashes = [
      new LogHash(Fr.fromBuffer(expectedLog.hash()), startCounter, new Fr(expectedLog.length + 4)).scope(address),
    ];

    expect(trace.getUnencryptedLogs()).toEqual([expectedLog]);
    expect(trace.getSideEffects().unencryptedLogsHashes).toEqual(expectedHashes);
  });

  it('Should trace get contract instance', () => {
    const instance = SerializableContractInstance.random();
    const { version: _, ...instanceWithoutVersion } = instance;
    const exists = true;
    trace.traceGetContractInstance(address, exists, instance);
    expect(trace.getCounter()).toBe(startCounterPlus1);

    expect(trace.getAvmCircuitHints().contractInstances.items).toEqual([
      {
        address,
        exists,
        ...instanceWithoutVersion,
      },
    ]);
  });
  describe('Maximum accesses', () => {
    it('Should enforce maximum number of public storage reads', () => {
      for (let i = 0; i < MAX_PUBLIC_DATA_READS_PER_TX; i++) {
        const leafPreimage = new PublicDataTreeLeafPreimage(new Fr(i), new Fr(i), Fr.ZERO, 0n);
        trace.tracePublicStorageRead(address, slot, value, leafPreimage, Fr.ZERO, []);
      }
      const leafPreimage = new PublicDataTreeLeafPreimage(new Fr(42), new Fr(42), Fr.ZERO, 0n);
      expect(() => trace.tracePublicStorageRead(address, slot, value, leafPreimage, Fr.ZERO, [])).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of public storage writes', () => {
      for (let i = 0; i < MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX; i++) {
        const lowLeafPreimage = new PublicDataTreeLeafPreimage(new Fr(i), new Fr(i), Fr.ZERO, 0n);
        const newLeafPreimage = new PublicDataTreeLeafPreimage(new Fr(i + 1), new Fr(i + 1), Fr.ZERO, 0n);
        trace.tracePublicStorageWrite(address, slot, value, lowLeafPreimage, Fr.ZERO, [], newLeafPreimage, []);
      }
      const leafPreimage = new PublicDataTreeLeafPreimage(new Fr(42), new Fr(42), Fr.ZERO, 0n);
      expect(() =>
        trace.tracePublicStorageWrite(
          AztecAddress.fromNumber(42),
          new Fr(42),
          value,
          leafPreimage,
          Fr.ZERO,
          [],
          leafPreimage,
          [],
        ),
      ).toThrow(SideEffectLimitReachedError);
    });

    it('Should enforce maximum number of note hash checks', () => {
      for (let i = 0; i < MAX_NOTE_HASH_READ_REQUESTS_PER_TX; i++) {
        trace.traceNoteHashCheck(AztecAddress.fromNumber(i), new Fr(i), new Fr(i), true, []);
      }
      expect(() => trace.traceNoteHashCheck(AztecAddress.fromNumber(42), new Fr(42), new Fr(42), true, [])).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of new note hashes', () => {
      for (let i = 0; i < MAX_NOTE_HASHES_PER_TX; i++) {
        trace.traceNewNoteHash(AztecAddress.fromNumber(i), new Fr(i), Fr.ZERO, []);
      }
      expect(() => trace.traceNewNoteHash(AztecAddress.fromNumber(42), new Fr(42), Fr.ZERO, [])).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of nullifier checks', () => {
      for (let i = 0; i < MAX_NULLIFIER_READ_REQUESTS_PER_TX; i++) {
        const lowLeafPreimage = new NullifierLeafPreimage(new Fr(i), Fr.ZERO, 0n);
        trace.traceNullifierCheck(AztecAddress.fromNumber(i), new Fr(i + 1), true, lowLeafPreimage, Fr.ZERO, []);
      }
      const lowLeafPreimage = new NullifierLeafPreimage(new Fr(41), Fr.ZERO, 0n);
      expect(() =>
        trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), true, lowLeafPreimage, Fr.ZERO, []),
      ).toThrow(SideEffectLimitReachedError);
      // NOTE: also cannot do a non-existent check once existent checks have filled up
      expect(() =>
        trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), false, lowLeafPreimage, Fr.ZERO, []),
      ).toThrow(SideEffectLimitReachedError);
    });

    it('Should enforce maximum number of nullifier non-existent checks', () => {
      for (let i = 0; i < MAX_NULLIFIER_NON_EXISTENT_READ_REQUESTS_PER_TX; i++) {
        const lowLeafPreimage = new NullifierLeafPreimage(new Fr(i), Fr.ZERO, 0n);
        trace.traceNullifierCheck(AztecAddress.fromNumber(i), new Fr(i + 1), true, lowLeafPreimage, Fr.ZERO, []);
      }
      const lowLeafPreimage = new NullifierLeafPreimage(new Fr(41), Fr.ZERO, 0n);
      expect(() =>
        trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), false, lowLeafPreimage, Fr.ZERO, []),
      ).toThrow(SideEffectLimitReachedError);
      // NOTE: also cannot do a existent check once non-existent checks have filled up
      expect(() =>
        trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), true, lowLeafPreimage, Fr.ZERO, []),
      ).toThrow(SideEffectLimitReachedError);
    });

    it('Should enforce maximum number of new nullifiers', () => {
      for (let i = 0; i < MAX_NULLIFIERS_PER_TX; i++) {
        const lowLeafPreimage = new NullifierLeafPreimage(new Fr(i + 1), Fr.ZERO, 0n);
        trace.traceNewNullifier(AztecAddress.fromNumber(i), new Fr(i), lowLeafPreimage, Fr.ZERO, [], []);
      }
      const lowLeafPreimage = new NullifierLeafPreimage(new Fr(41), Fr.ZERO, 0n);
      expect(() =>
        trace.traceNewNullifier(AztecAddress.fromNumber(42), new Fr(42), lowLeafPreimage, Fr.ZERO, [], []),
      ).toThrow(SideEffectLimitReachedError);
    });

    it('Should enforce maximum number of L1 to L2 message checks', () => {
      for (let i = 0; i < MAX_L1_TO_L2_MSG_READ_REQUESTS_PER_TX; i++) {
        trace.traceL1ToL2MessageCheck(AztecAddress.fromNumber(i), new Fr(i), new Fr(i), true, []);
      }
      expect(() =>
        trace.traceL1ToL2MessageCheck(AztecAddress.fromNumber(42), new Fr(42), new Fr(42), true, []),
      ).toThrow(SideEffectLimitReachedError);
    });

    it('Should enforce maximum number of new l2 to l1 messages', () => {
      for (let i = 0; i < MAX_L2_TO_L1_MSGS_PER_TX; i++) {
        trace.traceNewL2ToL1Message(AztecAddress.fromNumber(i), new Fr(i), new Fr(i));
      }
      expect(() => trace.traceNewL2ToL1Message(AztecAddress.fromNumber(42), new Fr(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of new logs hashes', () => {
      for (let i = 0; i < MAX_UNENCRYPTED_LOGS_PER_TX; i++) {
        trace.traceUnencryptedLog(AztecAddress.fromNumber(i), [new Fr(i), new Fr(i)]);
      }
      expect(() => trace.traceUnencryptedLog(AztecAddress.fromNumber(42), [new Fr(42), new Fr(42)])).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of nullifier checks for GETCONTRACTINSTANCE', () => {
      for (let i = 0; i < MAX_NULLIFIER_READ_REQUESTS_PER_TX; i++) {
        const lowLeafPreimage = new NullifierLeafPreimage(new Fr(i), Fr.ZERO, 0n);
        trace.traceNullifierCheck(AztecAddress.fromNumber(i), new Fr(i + 1), true, lowLeafPreimage, Fr.ZERO, []);
      }
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ true, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
      // NOTE: also cannot do a existent check once non-existent checks have filled up
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ false, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('Should enforce maximum number of nullifier non-existent checks for GETCONTRACTINSTANCE', () => {
      for (let i = 0; i < MAX_NULLIFIER_NON_EXISTENT_READ_REQUESTS_PER_TX; i++) {
        const lowLeafPreimage = new NullifierLeafPreimage(new Fr(i), Fr.ZERO, 0n);
        trace.traceNullifierCheck(AztecAddress.fromNumber(i), new Fr(i + 1), true, lowLeafPreimage, Fr.ZERO, []);
      }
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ false, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
      // NOTE: also cannot do a existent check once non-existent checks have filled up
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ true, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
    });

    it('PreviousValidationRequestArrayLengths and PreviousAccumulatedDataArrayLengths contribute to limits', () => {
      trace = new PublicEnqueuedCallSideEffectTrace(
        0,
        new SideEffectArrayLengths(
          MAX_PUBLIC_DATA_READS_PER_TX,
          MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
          MAX_NOTE_HASH_READ_REQUESTS_PER_TX,
          MAX_NOTE_HASHES_PER_TX,
          MAX_NULLIFIER_READ_REQUESTS_PER_TX,
          MAX_NULLIFIER_NON_EXISTENT_READ_REQUESTS_PER_TX,
          MAX_NULLIFIERS_PER_TX,
          MAX_L1_TO_L2_MSG_READ_REQUESTS_PER_TX,
          MAX_L2_TO_L1_MSGS_PER_TX,
          MAX_UNENCRYPTED_LOGS_PER_TX,
        ),
      );
      expect(() => trace.tracePublicStorageRead(AztecAddress.fromNumber(42), new Fr(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.tracePublicStorageWrite(AztecAddress.fromNumber(42), new Fr(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNoteHashCheck(AztecAddress.fromNumber(42), new Fr(42), new Fr(42), true)).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNewNoteHash(AztecAddress.fromNumber(42), new Fr(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), false)).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNullifierCheck(AztecAddress.fromNumber(42), new Fr(42), true)).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNewNullifier(AztecAddress.fromNumber(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceL1ToL2MessageCheck(AztecAddress.fromNumber(42), new Fr(42), new Fr(42), true)).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceNewL2ToL1Message(AztecAddress.fromNumber(42), new Fr(42), new Fr(42))).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceUnencryptedLog(AztecAddress.fromNumber(42), [new Fr(42), new Fr(42)])).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ false, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
      expect(() => trace.traceGetContractInstance(address, /*exists=*/ true, contractInstance)).toThrow(
        SideEffectLimitReachedError,
      );
    });
  });

  describe.each([false, true])('Should merge forked traces', reverted => {
    it(`${reverted ? 'Reverted' : 'Successful'} forked trace should be merged properly`, () => {
      const existsDefault = true;

      const nestedTrace = new PublicEnqueuedCallSideEffectTrace(startCounter);
      let testCounter = startCounter;
      const leafPreimage = new PublicDataTreeLeafPreimage(slot, value, Fr.ZERO, 0n);
      const lowLeafPreimage = new NullifierLeafPreimage(utxo, Fr.ZERO, 0n);
      nestedTrace.tracePublicStorageRead(address, slot, value, leafPreimage, Fr.ZERO, []);
      testCounter++;
      nestedTrace.tracePublicStorageWrite(address, slot, value, leafPreimage, Fr.ZERO, [], leafPreimage, []);
      testCounter++;
      nestedTrace.traceNoteHashCheck(address, utxo, leafIndex, existsDefault, []);
      // counter does not increment for note hash checks
      nestedTrace.traceNewNoteHash(address, utxo, Fr.ZERO, []);
      testCounter++;
      nestedTrace.traceNullifierCheck(address, utxo, true, lowLeafPreimage, Fr.ZERO, []);
      testCounter++;
      nestedTrace.traceNullifierCheck(address, utxo, true, lowLeafPreimage, Fr.ZERO, []);
      testCounter++;
      nestedTrace.traceNewNullifier(address, utxo, lowLeafPreimage, Fr.ZERO, [], []);
      testCounter++;
      nestedTrace.traceL1ToL2MessageCheck(address, utxo, leafIndex, existsDefault, []);
      // counter does not increment for l1tol2 message checks
      nestedTrace.traceNewL2ToL1Message(address, recipient, content);
      testCounter++;
      nestedTrace.traceUnencryptedLog(address, log);
      testCounter++;
      nestedTrace.traceGetContractInstance(address, /*exists=*/ true, contractInstance);
      testCounter++;
      nestedTrace.traceGetContractInstance(address, /*exists=*/ false, contractInstance);
      testCounter++;

      trace.merge(nestedTrace, reverted);

      // parent trace adopts nested call's counter
      expect(trace.getCounter()).toBe(testCounter);

      // parent absorbs child's side effects
      const parentSideEffects = trace.getSideEffects();
      const childSideEffects = nestedTrace.getSideEffects();
      // TODO(dbanks12): confirm that all hints were merged from child
      if (reverted) {
        expect(parentSideEffects.publicDataReads).toEqual([]);
        expect(parentSideEffects.publicDataWrites).toEqual([]);
        expect(parentSideEffects.noteHashReadRequests).toEqual([]);
        expect(parentSideEffects.noteHashes).toEqual([]);
        expect(parentSideEffects.nullifierReadRequests).toEqual([]);
        expect(parentSideEffects.nullifierNonExistentReadRequests).toEqual([]);
        expect(parentSideEffects.nullifiers).toEqual([]);
        expect(parentSideEffects.l1ToL2MsgReadRequests).toEqual([]);
        expect(parentSideEffects.l2ToL1Msgs).toEqual([]);
        expect(parentSideEffects.unencryptedLogs).toEqual([]);
        expect(parentSideEffects.unencryptedLogsHashes).toEqual([]);
      } else {
        expect(parentSideEffects).toEqual(childSideEffects);
      }
    });
  });
});
