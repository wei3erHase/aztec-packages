import {
  Fr,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  PublicDataWrite,
  RevertCode,
} from '@aztec/circuits.js';
import { type FieldsOf, makeTuple } from '@aztec/foundation/array';
import { padArrayEnd } from '@aztec/foundation/collection';
import { sha256Trunc } from '@aztec/foundation/crypto';
import { jsonStringify } from '@aztec/foundation/json-rpc';
import { schemas } from '@aztec/foundation/schemas';
import { BufferReader, serializeArrayOfBufferableToVector, serializeToBuffer } from '@aztec/foundation/serialize';
import { bufferToHex, hexToBuffer } from '@aztec/foundation/string';

import { inspect } from 'util';
import { z } from 'zod';

import { ContractClassTxL2Logs, EncryptedNoteTxL2Logs, EncryptedTxL2Logs, UnencryptedTxL2Logs } from './logs/index.js';
import { TxHash } from './tx/tx_hash.js';

export { RevertCodeEnum } from '@aztec/circuits.js';

export class TxEffect {
  constructor(
    /**
     * Whether the transaction reverted during public app logic.
     */
    public revertCode: RevertCode,
    /**
     * The transaction fee, denominated in FPA.
     */
    public transactionFee: Fr,
    /**
     * The note hashes to be inserted into the note hash tree.
     */
    public noteHashes: Fr[],
    /**
     * The nullifiers to be inserted into the nullifier tree.
     */
    public nullifiers: Fr[],
    /**
     * The hash of L2 to L1 messages to be inserted into the messagebox on L1.
     * TODO(just-mitch): rename to l2ToL1MsgHashes
     */
    public l2ToL1Msgs: Fr[],
    /**
     * The public data writes to be inserted into the public data tree.
     */
    public publicDataWrites: PublicDataWrite[],
    /**
     * The logs and logs lengths of the txEffect
     */
    public noteEncryptedLogsLength: Fr,
    public encryptedLogsLength: Fr,
    public unencryptedLogsLength: Fr,
    public contractClassLogsLength: Fr,
    public noteEncryptedLogs: EncryptedNoteTxL2Logs,
    public encryptedLogs: EncryptedTxL2Logs,
    public unencryptedLogs: UnencryptedTxL2Logs,
    public contractClassLogs: ContractClassTxL2Logs,
  ) {
    // TODO(#4638): Clean this up once we have isDefault() everywhere --> then we don't have to deal with 2 different
    // functions (isZero and isEmpty)
    if (noteHashes.length > MAX_NOTE_HASHES_PER_TX) {
      throw new Error(`Too many note hashes: ${noteHashes.length}, max: ${MAX_NOTE_HASHES_PER_TX}`);
    }
    noteHashes.forEach(h => {
      if (h.isZero()) {
        throw new Error('Note hash is zero');
      }
    });

    if (nullifiers.length > MAX_NULLIFIERS_PER_TX) {
      throw new Error(`Too many nullifiers: ${nullifiers.length}, max: ${MAX_NULLIFIERS_PER_TX}`);
    }
    nullifiers.forEach(h => {
      if (h.isZero()) {
        throw new Error('Nullifier is zero');
      }
    });

    if (l2ToL1Msgs.length > MAX_L2_TO_L1_MSGS_PER_TX) {
      throw new Error(`Too many L2 to L1 messages: ${l2ToL1Msgs.length}, max: ${MAX_L2_TO_L1_MSGS_PER_TX}`);
    }
    l2ToL1Msgs.forEach(h => {
      if (h.isZero()) {
        throw new Error('L2 to L1 message is zero');
      }
    });

    if (publicDataWrites.length > MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX) {
      throw new Error(
        `Too many public data writes: ${publicDataWrites.length}, max: ${MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX}`,
      );
    }
    publicDataWrites.forEach(h => {
      if (h.isEmpty()) {
        throw new Error('Public data write is empty');
      }
    });
  }

  toBuffer(): Buffer {
    return serializeToBuffer([
      this.revertCode,
      this.transactionFee,
      serializeArrayOfBufferableToVector(this.noteHashes, 1),
      serializeArrayOfBufferableToVector(this.nullifiers, 1),
      serializeArrayOfBufferableToVector(this.l2ToL1Msgs, 1),
      serializeArrayOfBufferableToVector(this.publicDataWrites, 1),
      this.noteEncryptedLogsLength,
      this.encryptedLogsLength,
      this.unencryptedLogsLength,
      this.contractClassLogsLength,
      this.noteEncryptedLogs,
      this.encryptedLogs,
      this.unencryptedLogs,
      this.contractClassLogs,
    ]);
  }

  /**
   * Deserializes the TxEffect object from a Buffer.
   * @param buffer - Buffer or BufferReader object to deserialize.
   * @returns An instance of TxEffect.
   */
  static fromBuffer(buffer: Buffer | BufferReader): TxEffect {
    const reader = BufferReader.asReader(buffer);

    return new TxEffect(
      RevertCode.fromBuffer(reader),
      Fr.fromBuffer(reader),
      reader.readVectorUint8Prefix(Fr),
      reader.readVectorUint8Prefix(Fr),
      reader.readVectorUint8Prefix(Fr),
      reader.readVectorUint8Prefix(PublicDataWrite),
      Fr.fromBuffer(reader),
      Fr.fromBuffer(reader),
      Fr.fromBuffer(reader),
      Fr.fromBuffer(reader),
      reader.readObject(EncryptedNoteTxL2Logs),
      reader.readObject(EncryptedTxL2Logs),
      reader.readObject(UnencryptedTxL2Logs),
      reader.readObject(ContractClassTxL2Logs),
    );
  }

  /**
   * Computes the hash of the TxEffect object.
   * @returns The hash of the TxEffect object.
   * @dev This function must correspond with compute_tx_effects_hash() in Noir and TxsDecoder.sol decode().
   */
  hash() {
    const padBuffer = (buf: Buffer, length: number) => Buffer.concat([buf, Buffer.alloc(length - buf.length)]);

    const noteHashesBuffer = padBuffer(serializeToBuffer(this.noteHashes), Fr.SIZE_IN_BYTES * MAX_NOTE_HASHES_PER_TX);
    const nullifiersBuffer = padBuffer(serializeToBuffer(this.nullifiers), Fr.SIZE_IN_BYTES * MAX_NULLIFIERS_PER_TX);
    const outHashBuffer = this.txOutHash();
    const publicDataWritesBuffer = padBuffer(
      serializeToBuffer(this.publicDataWrites),
      PublicDataWrite.SIZE_IN_BYTES * MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
    );

    const noteEncryptedLogsHashKernel0 = this.noteEncryptedLogs.hash();
    const encryptedLogsHashKernel0 = this.encryptedLogs.hash();
    const unencryptedLogsHashKernel0 = this.unencryptedLogs.hash();
    const contractClassLogsHashKernel0 = this.contractClassLogs.hash();

    const inputValue = Buffer.concat([
      this.revertCode.toHashPreimage(),
      this.transactionFee.toBuffer(),
      noteHashesBuffer,
      nullifiersBuffer,
      outHashBuffer,
      publicDataWritesBuffer,
      this.noteEncryptedLogsLength.toBuffer(),
      this.encryptedLogsLength.toBuffer(),
      this.unencryptedLogsLength.toBuffer(),
      this.contractClassLogsLength.toBuffer(),
      noteEncryptedLogsHashKernel0,
      encryptedLogsHashKernel0,
      unencryptedLogsHashKernel0,
      contractClassLogsHashKernel0,
    ]);

    return sha256Trunc(inputValue);
  }

  /**
   * Computes txOutHash of this tx effect.
   * TODO(#7218): Revert to fixed height tree for outbox
   * @dev Follows computeTxOutHash in TxsDecoder.sol and new_sha in variable_merkle_tree.nr
   */
  txOutHash() {
    const { l2ToL1Msgs } = this;
    if (l2ToL1Msgs.length == 0) {
      return Buffer.alloc(32);
    }
    const depth = l2ToL1Msgs.length == 1 ? 1 : Math.ceil(Math.log2(l2ToL1Msgs.length));
    let thisLayer = padArrayEnd(
      l2ToL1Msgs.map(msg => msg.toBuffer()),
      Buffer.alloc(32),
      2 ** depth,
    );
    let nextLayer = [];
    for (let i = 0; i < depth; i++) {
      for (let j = 0; j < thisLayer.length; j += 2) {
        // Store the hash of each pair one layer up
        nextLayer[j / 2] = sha256Trunc(Buffer.concat([thisLayer[j], thisLayer[j + 1]]));
      }
      thisLayer = nextLayer;
      nextLayer = [];
    }
    return thisLayer[0];
  }

  static random(
    numPrivateCallsPerTx = 2,
    numPublicCallsPerTx = 3,
    numEncryptedLogsPerCall = 2,
    numUnencryptedLogsPerCall = 1,
  ): TxEffect {
    const noteEncryptedLogs = EncryptedNoteTxL2Logs.random(numPrivateCallsPerTx, numEncryptedLogsPerCall);
    const encryptedLogs = EncryptedTxL2Logs.random(numPrivateCallsPerTx, numEncryptedLogsPerCall);
    const unencryptedLogs = UnencryptedTxL2Logs.random(numPublicCallsPerTx, numUnencryptedLogsPerCall);
    const contractClassLogs = ContractClassTxL2Logs.random(1, 1);
    return new TxEffect(
      RevertCode.random(),
      Fr.random(),
      makeTuple(MAX_NOTE_HASHES_PER_TX, Fr.random),
      makeTuple(MAX_NULLIFIERS_PER_TX, Fr.random),
      makeTuple(MAX_L2_TO_L1_MSGS_PER_TX, Fr.random),
      makeTuple(MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX, () => new PublicDataWrite(Fr.random(), Fr.random())),
      new Fr(noteEncryptedLogs.getKernelLength()),
      new Fr(encryptedLogs.getKernelLength()),
      new Fr(unencryptedLogs.getKernelLength()),
      new Fr(contractClassLogs.getKernelLength()),
      noteEncryptedLogs,
      encryptedLogs,
      unencryptedLogs,
      contractClassLogs,
    );
  }

  static empty(): TxEffect {
    return new TxEffect(
      RevertCode.OK,
      Fr.ZERO,
      [],
      [],
      [],
      [],
      Fr.ZERO,
      Fr.ZERO,
      Fr.ZERO,
      Fr.ZERO,
      EncryptedNoteTxL2Logs.empty(),
      EncryptedTxL2Logs.empty(),
      UnencryptedTxL2Logs.empty(),
      ContractClassTxL2Logs.empty(),
    );
  }

  isEmpty(): boolean {
    return this.nullifiers.length === 0;
  }

  /** Returns a hex representation of the TxEffect object. */
  toString() {
    return bufferToHex(this.toBuffer());
  }

  static from(fields: Omit<FieldsOf<TxEffect>, 'txHash'>) {
    return new TxEffect(
      fields.revertCode,
      fields.transactionFee,
      fields.noteHashes,
      fields.nullifiers,
      fields.l2ToL1Msgs,
      fields.publicDataWrites,
      fields.noteEncryptedLogsLength,
      fields.encryptedLogsLength,
      fields.unencryptedLogsLength,
      fields.contractClassLogsLength,
      fields.noteEncryptedLogs,
      fields.encryptedLogs,
      fields.unencryptedLogs,
      fields.contractClassLogs,
    );
  }

  static get schema() {
    return z
      .object({
        revertCode: RevertCode.schema,
        transactionFee: schemas.Fr,
        noteHashes: z.array(schemas.Fr),
        nullifiers: z.array(schemas.Fr),
        l2ToL1Msgs: z.array(schemas.Fr),
        publicDataWrites: z.array(PublicDataWrite.schema),
        noteEncryptedLogsLength: schemas.Fr,
        encryptedLogsLength: schemas.Fr,
        unencryptedLogsLength: schemas.Fr,
        contractClassLogsLength: schemas.Fr,
        noteEncryptedLogs: EncryptedNoteTxL2Logs.schema,
        encryptedLogs: EncryptedTxL2Logs.schema,
        unencryptedLogs: UnencryptedTxL2Logs.schema,
        contractClassLogs: ContractClassTxL2Logs.schema,
      })
      .transform(TxEffect.from);
  }

  [inspect.custom]() {
    return `TxEffect {
      revertCode: ${this.revertCode},
      transactionFee: ${this.transactionFee},
      note hashes: [${this.noteHashes.map(h => h.toString()).join(', ')}],
      nullifiers: [${this.nullifiers.map(h => h.toString()).join(', ')}],
      l2ToL1Msgs: [${this.l2ToL1Msgs.map(h => h.toString()).join(', ')}],
      publicDataWrites: [${this.publicDataWrites.map(h => h.toString()).join(', ')}],
      noteEncryptedLogsLength: ${this.noteEncryptedLogsLength},
      encryptedLogsLength: ${this.encryptedLogsLength},
      unencryptedLogsLength: ${this.unencryptedLogsLength},
      contractClassLogsLength: ${this.contractClassLogsLength},
      noteEncryptedLogs: ${jsonStringify(this.noteEncryptedLogs)},
      encryptedLogs: ${jsonStringify(this.encryptedLogs)},
      unencryptedLogs: ${jsonStringify(this.unencryptedLogs)}
      contractClassLogs: ${jsonStringify(this.contractClassLogs)}
     }`;
  }

  /**
   * Deserializes an TxEffect object from a string.
   * @param str - String to deserialize.
   * @returns An instance of TxEffect.
   */
  static fromString(str: string) {
    return TxEffect.fromBuffer(hexToBuffer(str));
  }

  get txHash(): TxHash {
    return new TxHash(this.nullifiers[0].toBuffer());
  }
}
