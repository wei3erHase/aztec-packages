import { type L2Block, MerkleTreeId, type SiblingPath, TxEffect } from '@aztec/circuit-types';
import {
  type BatchInsertionResult,
  type IndexedTreeId,
  type MerkleTreeLeafType,
  type MerkleTreeReadOperations,
  type MerkleTreeWriteOperations,
  type TreeInfo,
} from '@aztec/circuit-types/interfaces';
import {
  ARCHIVE_HEIGHT,
  AppendOnlyTreeSnapshot,
  Fr,
  Header,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  NOTE_HASH_TREE_HEIGHT,
  NULLIFIER_SUBTREE_HEIGHT,
  NULLIFIER_TREE_HEIGHT,
  NUMBER_OF_L1_L2_MESSAGES_PER_ROLLUP,
  NullifierLeaf,
  NullifierLeafPreimage,
  PUBLIC_DATA_SUBTREE_HEIGHT,
  PUBLIC_DATA_TREE_HEIGHT,
  PartialStateReference,
  PublicDataTreeLeaf,
  PublicDataTreeLeafPreimage,
  PublicDataWrite,
  StateReference,
} from '@aztec/circuits.js';
import { padArrayEnd } from '@aztec/foundation/collection';
import { type DebugLogger, createDebugLogger } from '@aztec/foundation/log';
import { SerialQueue } from '@aztec/foundation/queue';
import { Timer, elapsed } from '@aztec/foundation/timer';
import { type IndexedTreeLeafPreimage } from '@aztec/foundation/trees';
import { type AztecKVStore, type AztecSingleton } from '@aztec/kv-store';
import { openTmpStore } from '@aztec/kv-store/utils';
import {
  type AppendOnlyTree,
  type IndexedTree,
  Poseidon,
  StandardIndexedTree,
  StandardTree,
  getTreeMeta,
  loadTree,
  newTree,
} from '@aztec/merkle-tree';
import { type TelemetryClient } from '@aztec/telemetry-client';
import { NoopTelemetryClient } from '@aztec/telemetry-client/noop';
import { type Hasher } from '@aztec/types/interfaces';

import {
  type WorldStateStatusFull,
  type WorldStateStatusSummary,
  buildEmptyWorldStateStatusFull,
} from '../native/message.js';
import {
  INITIAL_NULLIFIER_TREE_SIZE,
  INITIAL_PUBLIC_DATA_TREE_SIZE,
  type MerkleTreeAdminDatabase,
  type TreeSnapshots,
} from './merkle_tree_db.js';
import { type MerkleTreeMap } from './merkle_tree_map.js';
import { MerkleTreeReadOperationsFacade } from './merkle_tree_operations_facade.js';
import { MerkleTreeSnapshotOperationsFacade } from './merkle_tree_snapshot_operations_facade.js';
import { WorldStateMetrics } from './metrics.js';

/**
 * The nullifier tree is an indexed tree.
 */
class NullifierTree extends StandardIndexedTree {
  constructor(
    store: AztecKVStore,
    hasher: Hasher,
    name: string,
    depth: number,
    size: bigint = 0n,
    _noop: any,
    root?: Buffer,
  ) {
    super(store, hasher, name, depth, size, NullifierLeafPreimage, NullifierLeaf, root);
  }
}

/**
 * The public data tree is an indexed tree.
 */
class PublicDataTree extends StandardIndexedTree {
  constructor(
    store: AztecKVStore,
    hasher: Hasher,
    name: string,
    depth: number,
    size: bigint = 0n,
    _noop: any,
    root?: Buffer,
  ) {
    super(store, hasher, name, depth, size, PublicDataTreeLeafPreimage, PublicDataTreeLeaf, root);
  }
}

/**
 * A convenience class for managing multiple merkle trees.
 */
export class MerkleTrees implements MerkleTreeAdminDatabase {
  // gets initialized in #init
  private trees: MerkleTreeMap = null as any;
  private jobQueue = new SerialQueue();
  private initialStateReference: AztecSingleton<Buffer>;
  private metrics: WorldStateMetrics;

  private constructor(private store: AztecKVStore, private telemetryClient: TelemetryClient, private log: DebugLogger) {
    this.initialStateReference = store.openSingleton('merkle_trees_initial_state_reference');
    this.metrics = new WorldStateMetrics(telemetryClient);
  }

  /**
   * Method to asynchronously create and initialize a MerkleTrees instance.
   * @param store - The db instance to use for data persistance.
   * @returns - A fully initialized MerkleTrees instance.
   */
  public static async new(store: AztecKVStore, client: TelemetryClient, log = createDebugLogger('aztec:merkle_trees')) {
    const merkleTrees = new MerkleTrees(store, client, log);
    await merkleTrees.#init();
    return merkleTrees;
  }

  /**
   * Creates a temporary store. Useful for testing.
   */
  public static tmp() {
    const store = openTmpStore();
    return MerkleTrees.new(store, new NoopTelemetryClient());
  }

  /**
   * Initializes the collection of Merkle Trees.
   */
  async #init(loadFromDb?: boolean) {
    const fromDb = loadFromDb === undefined ? this.#isDbPopulated() : loadFromDb;
    const initializeTree = fromDb ? loadTree : newTree;

    const hasher = new Poseidon();

    const nullifierTree = await initializeTree(
      NullifierTree,
      this.store,
      hasher,
      `${MerkleTreeId[MerkleTreeId.NULLIFIER_TREE]}`,
      {},
      NULLIFIER_TREE_HEIGHT,
      INITIAL_NULLIFIER_TREE_SIZE,
    );
    const noteHashTree: AppendOnlyTree<Fr> = await initializeTree(
      StandardTree,
      this.store,
      hasher,
      `${MerkleTreeId[MerkleTreeId.NOTE_HASH_TREE]}`,
      Fr,
      NOTE_HASH_TREE_HEIGHT,
    );
    const publicDataTree = await initializeTree(
      PublicDataTree,
      this.store,
      hasher,
      `${MerkleTreeId[MerkleTreeId.PUBLIC_DATA_TREE]}`,
      {},
      PUBLIC_DATA_TREE_HEIGHT,
      INITIAL_PUBLIC_DATA_TREE_SIZE,
    );
    const l1Tol2MessageTree: AppendOnlyTree<Fr> = await initializeTree(
      StandardTree,
      this.store,
      hasher,
      `${MerkleTreeId[MerkleTreeId.L1_TO_L2_MESSAGE_TREE]}`,
      Fr,
      L1_TO_L2_MSG_TREE_HEIGHT,
    );
    const archive: AppendOnlyTree<Fr> = await initializeTree(
      StandardTree,
      this.store,
      hasher,
      `${MerkleTreeId[MerkleTreeId.ARCHIVE]}`,
      Fr,
      ARCHIVE_HEIGHT,
    );
    this.trees = [nullifierTree, noteHashTree, publicDataTree, l1Tol2MessageTree, archive];

    this.jobQueue.start();

    if (!fromDb) {
      // We are not initializing from db so we need to populate the first leaf of the archive tree which is a hash of the initial header,
      // and persist the initial header state reference so we can later load it when requested.
      const initialState = await this.getStateReference(true);
      await this.#saveInitialStateReference(initialState);
      await this.#updateArchive(this.getInitialHeader());

      // And commit anything we did to initialize this set of trees
      await this.#commit();
    }
  }

  public removeHistoricalBlocks(_toBlockNumber: bigint): Promise<WorldStateStatusFull> {
    throw new Error('Method not implemented.');
  }

  public unwindBlocks(_toBlockNumber: bigint): Promise<WorldStateStatusFull> {
    throw new Error('Method not implemented.');
  }

  public setFinalised(_toBlockNumber: bigint): Promise<WorldStateStatusSummary> {
    throw new Error('Method not implemented.');
  }

  public getStatusSummary(): Promise<WorldStateStatusSummary> {
    throw new Error('Method not implemented.');
  }

  public async fork(blockNumber?: number): Promise<MerkleTreeWriteOperations> {
    if (blockNumber) {
      throw new Error('Block number forking is not supported in js world state');
    }
    const [ms, db] = await elapsed(async () => {
      const forked = await this.store.fork();
      return MerkleTrees.new(forked, this.telemetryClient, this.log);
    });

    this.metrics.recordForkDuration(ms);
    return new MerkleTreeReadOperationsFacade(db, true);
  }

  // REFACTOR: We're hiding the `commit` operations in the tree behind a type check only, but
  // we should make sure it's not accidentally called elsewhere by splitting this class into one
  // that can work on a read-only store and one that actually writes to the store. This implies
  // having read-only versions of the kv-stores, all kv-containers, and all trees.
  public async ephemeralFork(): Promise<MerkleTreeWriteOperations> {
    const forked = new MerkleTrees(
      this.store,
      this.telemetryClient,
      createDebugLogger('aztec:merkle_trees:ephemeral_fork'),
    );
    await forked.#init(true);
    return new MerkleTreeReadOperationsFacade(forked, true);
  }

  public async delete() {
    await this.store.delete();
  }

  public getInitialHeader(): Header {
    return Header.empty({ state: this.#loadInitialStateReference() });
  }

  /**
   * Stops the job queue (waits for all jobs to finish).
   */
  public async close() {
    await this.jobQueue.end();
  }

  /**
   * Gets a view of this db that returns uncommitted data.
   * @returns - A facade for this instance.
   */
  public getLatest(): Promise<MerkleTreeWriteOperations> {
    return Promise.resolve(new MerkleTreeReadOperationsFacade(this, true));
  }

  /**
   * Gets a view of this db that returns committed data only.
   * @returns - A facade for this instance.
   */
  public getCommitted(): MerkleTreeReadOperations {
    return new MerkleTreeReadOperationsFacade(this, false);
  }

  public getSnapshot(blockNumber: number): MerkleTreeReadOperations {
    return new MerkleTreeSnapshotOperationsFacade(this, blockNumber);
  }

  /**
   * Updates the archive with the new block/header hash.
   * @param header - The header whose hash to insert into the archive.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   */
  public async updateArchive(header: Header) {
    await this.synchronize(() => this.#updateArchive(header));
  }

  /**
   * Gets the tree info for the specified tree.
   * @param treeId - Id of the tree to get information from.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The tree info for the specified tree.
   */
  public async getTreeInfo(treeId: MerkleTreeId, includeUncommitted: boolean): Promise<TreeInfo> {
    return await this.synchronize(() => this.#getTreeInfo(treeId, includeUncommitted));
  }

  /**
   * Get the current state reference
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The current state reference
   */
  public getStateReference(includeUncommitted: boolean): Promise<StateReference> {
    const getAppendOnlyTreeSnapshot = (treeId: MerkleTreeId) => {
      const tree = this.trees[treeId] as AppendOnlyTree;
      return new AppendOnlyTreeSnapshot(
        Fr.fromBuffer(tree.getRoot(includeUncommitted)),
        Number(tree.getNumLeaves(includeUncommitted)),
      );
    };

    const state = new StateReference(
      getAppendOnlyTreeSnapshot(MerkleTreeId.L1_TO_L2_MESSAGE_TREE),
      new PartialStateReference(
        getAppendOnlyTreeSnapshot(MerkleTreeId.NOTE_HASH_TREE),
        getAppendOnlyTreeSnapshot(MerkleTreeId.NULLIFIER_TREE),
        getAppendOnlyTreeSnapshot(MerkleTreeId.PUBLIC_DATA_TREE),
      ),
    );
    return Promise.resolve(state);
  }

  /**
   * Gets the value at the given index.
   * @param treeId - The ID of the tree to get the leaf value from.
   * @param index - The index of the leaf.
   * @param includeUncommitted - Indicates whether to include uncommitted changes.
   * @returns Leaf value at the given index (undefined if not found).
   */
  public async getLeafValue(
    treeId: MerkleTreeId,
    index: bigint,
    includeUncommitted: boolean,
  ): Promise<MerkleTreeLeafType<typeof treeId> | undefined> {
    return await this.synchronize(() => Promise.resolve(this.trees[treeId].getLeafValue(index, includeUncommitted)));
  }

  /**
   * Gets the sibling path for a leaf in a tree.
   * @param treeId - The ID of the tree.
   * @param index - The index of the leaf.
   * @param includeUncommitted - Indicates whether the sibling path should include uncommitted data.
   * @returns The sibling path for the leaf.
   */
  public async getSiblingPath<N extends number>(
    treeId: MerkleTreeId,
    index: bigint,
    includeUncommitted: boolean,
  ): Promise<SiblingPath<N>> {
    return await this.synchronize(() => this.trees[treeId].getSiblingPath<N>(index, includeUncommitted));
  }

  /**
   * Appends leaves to a tree.
   * @param treeId - The ID of the tree.
   * @param leaves - The leaves to append.
   * @returns Empty promise.
   */
  public async appendLeaves<ID extends MerkleTreeId>(treeId: ID, leaves: MerkleTreeLeafType<ID>[]): Promise<void> {
    return await this.synchronize(() => this.#appendLeaves(treeId, leaves));
  }

  /**
   * Commits all pending updates.
   * @returns Empty promise.
   */
  public async commit(): Promise<void> {
    return await this.synchronize(() => this.#commit());
  }

  /**
   * Rolls back all pending updates.
   * @returns Empty promise.
   */
  public async rollback(): Promise<void> {
    return await this.synchronize(() => this.#rollback());
  }

  /**
   * Finds the index of the largest leaf whose value is less than or equal to the provided value.
   * @param treeId - The ID of the tree to search.
   * @param value - The value to be inserted into the tree.
   * @param includeUncommitted - If true, the uncommitted changes are included in the search.
   * @returns The found leaf index and a flag indicating if the corresponding leaf's value is equal to `newValue`.
   */
  public async getPreviousValueIndex(
    treeId: IndexedTreeId,
    value: bigint,
    includeUncommitted: boolean,
  ): Promise<
    | {
        /**
         * The index of the found leaf.
         */
        index: bigint;
        /**
         * A flag indicating if the corresponding leaf's value is equal to `newValue`.
         */
        alreadyPresent: boolean;
      }
    | undefined
  > {
    return await this.synchronize(() =>
      Promise.resolve(this.#getIndexedTree(treeId).findIndexOfPreviousKey(value, includeUncommitted)),
    );
  }

  /**
   * Gets the leaf data at a given index and tree.
   * @param treeId - The ID of the tree get the leaf from.
   * @param index - The index of the leaf to get.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns Leaf preimage.
   */
  public async getLeafPreimage(
    treeId: IndexedTreeId,
    index: bigint,
    includeUncommitted: boolean,
  ): Promise<IndexedTreeLeafPreimage | undefined> {
    return await this.synchronize(() =>
      Promise.resolve(this.#getIndexedTree(treeId).getLatestLeafPreimageCopy(index, includeUncommitted)),
    );
  }

  /**
   * Returns the index of a leaf given its value, or undefined if no leaf with that value is found.
   * @param treeId - The ID of the tree.
   * @param value - The leaf value to look for.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The index of the first leaf found with a given value (undefined if not found).
   */
  public async findLeafIndex<ID extends MerkleTreeId>(
    treeId: ID,
    value: MerkleTreeLeafType<ID>,
    includeUncommitted: boolean,
  ): Promise<bigint | undefined> {
    return await this.synchronize(() => {
      const tree = this.trees[treeId];
      // TODO #5448 fix "as any"
      return Promise.resolve(tree.findLeafIndex(value as any, includeUncommitted));
    });
  }

  /**
   * Returns the first index containing a leaf value after `startIndex`.
   * @param treeId - The tree for which the index should be returned.
   * @param value - The value to search for in the tree.
   * @param startIndex - The index to start searching from (used when skipping nullified messages)
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   */
  public async findLeafIndexAfter<ID extends MerkleTreeId>(
    treeId: ID,
    value: MerkleTreeLeafType<ID>,
    startIndex: bigint,
    includeUncommitted: boolean,
  ): Promise<bigint | undefined> {
    return await this.synchronize(() => {
      const tree = this.trees[treeId];
      // TODO #5448 fix "as any"
      return Promise.resolve(tree.findLeafIndexAfter(value as any, startIndex, includeUncommitted));
    });
  }

  /**
   * Handles a single L2 block (i.e. Inserts the new note hashes into the merkle tree).
   * @param block - The L2 block to handle.
   * @param l1ToL2Messages - The L1 to L2 messages for the block.
   * @returns Whether the block handled was produced by this same node.
   */
  public async handleL2BlockAndMessages(block: L2Block, l1ToL2Messages: Fr[]): Promise<WorldStateStatusFull> {
    return await this.synchronize(() => this.#handleL2BlockAndMessages(block, l1ToL2Messages));
  }

  /**
   * Batch insert multiple leaves into the tree.
   * @param treeId - The ID of the tree.
   * @param leaves - Leaves to insert into the tree.
   * @param subtreeHeight - Height of the subtree.
   * @returns The data for the leaves to be updated when inserting the new ones.
   */
  public async batchInsert<
    TreeHeight extends number,
    SubtreeHeight extends number,
    SubtreeSiblingPathHeight extends number,
  >(
    treeId: IndexedTreeId,
    leaves: Buffer[],
    subtreeHeight: SubtreeHeight,
  ): Promise<BatchInsertionResult<TreeHeight, SubtreeSiblingPathHeight>> {
    const tree = this.trees[treeId] as StandardIndexedTree;
    if (!('batchInsert' in tree)) {
      throw new Error('Tree does not support `batchInsert` method');
    }
    return await this.synchronize(() => tree.batchInsert(leaves, subtreeHeight));
  }

  /**
   * Waits for all jobs to finish before executing the given function.
   * @param fn - The function to execute.
   * @returns Promise containing the result of the function.
   */
  private async synchronize<T>(fn: () => Promise<T>): Promise<T> {
    return await this.jobQueue.put(fn);
  }

  #saveInitialStateReference(state: StateReference) {
    return this.initialStateReference.set(state.toBuffer());
  }

  #loadInitialStateReference(): StateReference {
    const serialized = this.initialStateReference.get();
    if (!serialized) {
      throw new Error('Initial state reference not found');
    }
    return StateReference.fromBuffer(serialized);
  }

  async #updateArchive(header: Header) {
    const state = await this.getStateReference(true);

    // This method should be called only when the block builder already updated the state so we sanity check that it's
    // the case here.
    if (!state.toBuffer().equals(header.state.toBuffer())) {
      throw new Error('State in header does not match current state');
    }

    const blockHash = header.hash();
    await this.#appendLeaves(MerkleTreeId.ARCHIVE, [blockHash]);
  }

  /**
   * Returns the tree info for the specified tree id.
   * @param treeId - Id of the tree to get information from.
   * @param includeUncommitted - Indicates whether to include uncommitted data.
   * @returns The tree info for the specified tree.
   */
  #getTreeInfo(treeId: MerkleTreeId, includeUncommitted: boolean): Promise<TreeInfo> {
    const treeInfo = {
      treeId,
      root: this.trees[treeId].getRoot(includeUncommitted),
      size: this.trees[treeId].getNumLeaves(includeUncommitted),
      depth: this.trees[treeId].getDepth(),
    } as TreeInfo;
    return Promise.resolve(treeInfo);
  }

  /**
   * Returns an instance of an indexed tree.
   * @param treeId - Id of the tree to get an instance of.
   * @returns The indexed tree for the specified tree id.
   */
  #getIndexedTree(treeId: IndexedTreeId): IndexedTree {
    return this.trees[treeId] as IndexedTree;
  }

  /**
   * Appends leaves to a tree.
   * @param treeId - Id of the tree to append leaves to.
   * @param leaves - Leaves to append.
   * @returns Empty promise.
   */
  async #appendLeaves<ID extends MerkleTreeId>(treeId: ID, leaves: MerkleTreeLeafType<typeof treeId>[]): Promise<void> {
    const tree = this.trees[treeId];
    if (!('appendLeaves' in tree)) {
      throw new Error('Tree does not support `appendLeaves` method');
    }
    // TODO #5448 fix "as any"
    return await tree.appendLeaves(leaves as any[]);
  }

  /**
   * Commits all pending updates.
   * @returns Empty promise.
   */
  async #commit(): Promise<void> {
    for (const tree of Object.values(this.trees)) {
      await tree.commit();
    }
  }

  /**
   * Rolls back all pending updates.
   * @returns Empty promise.
   */
  async #rollback(): Promise<void> {
    for (const tree of Object.values(this.trees)) {
      await tree.rollback();
    }
  }

  public async getTreeSnapshots(blockNumber: number): Promise<TreeSnapshots> {
    const snapshots = await Promise.all([
      this.trees[MerkleTreeId.NULLIFIER_TREE].getSnapshot(blockNumber),
      this.trees[MerkleTreeId.NOTE_HASH_TREE].getSnapshot(blockNumber),
      this.trees[MerkleTreeId.PUBLIC_DATA_TREE].getSnapshot(blockNumber),
      this.trees[MerkleTreeId.L1_TO_L2_MESSAGE_TREE].getSnapshot(blockNumber),
      this.trees[MerkleTreeId.ARCHIVE].getSnapshot(blockNumber),
    ]);

    return {
      [MerkleTreeId.NULLIFIER_TREE]: snapshots[0],
      [MerkleTreeId.NOTE_HASH_TREE]: snapshots[1],
      [MerkleTreeId.PUBLIC_DATA_TREE]: snapshots[2],
      [MerkleTreeId.L1_TO_L2_MESSAGE_TREE]: snapshots[3],
      [MerkleTreeId.ARCHIVE]: snapshots[4],
    };
  }

  async #snapshot(blockNumber: number): Promise<void> {
    for (const tree of Object.values(this.trees)) {
      await tree.snapshot(blockNumber);
    }
  }

  /**
   * Handles a single L2 block (i.e. Inserts the new note hashes into the merkle tree).
   * @param l2Block - The L2 block to handle.
   * @param l1ToL2Messages - The L1 to L2 messages for the block.
   */
  async #handleL2BlockAndMessages(l2Block: L2Block, l1ToL2Messages: Fr[]): Promise<WorldStateStatusFull> {
    const timer = new Timer();

    const treeRootWithIdPairs = [
      [l2Block.header.state.partial.nullifierTree.root, MerkleTreeId.NULLIFIER_TREE],
      [l2Block.header.state.partial.noteHashTree.root, MerkleTreeId.NOTE_HASH_TREE],
      [l2Block.header.state.partial.publicDataTree.root, MerkleTreeId.PUBLIC_DATA_TREE],
      [l2Block.header.state.l1ToL2MessageTree.root, MerkleTreeId.L1_TO_L2_MESSAGE_TREE],
      [l2Block.archive.root, MerkleTreeId.ARCHIVE],
    ] as const;
    const compareRoot = (root: Fr, treeId: MerkleTreeId) => {
      const treeRoot = this.trees[treeId].getRoot(true);
      return treeRoot.equals(root.toBuffer());
    };
    const ourBlock = treeRootWithIdPairs.every(([root, id]) => compareRoot(root, id));
    if (ourBlock) {
      this.log.verbose(`Block ${l2Block.number} is ours, committing world state`);
      await this.#commit();
    } else {
      this.log.verbose(`Block ${l2Block.number} is not ours, rolling back world state and committing state from chain`);
      await this.#rollback();

      // We have to pad both the tx effects and the values within tx effects because that's how the trees are built
      // by circuits.
      const paddedTxEffects = padArrayEnd(
        l2Block.body.txEffects,
        TxEffect.empty(),
        l2Block.body.numberOfTxsIncludingPadded,
      );

      // Sync the append only trees
      {
        const noteHashesPadded = paddedTxEffects.flatMap(txEffect =>
          padArrayEnd(txEffect.noteHashes, Fr.ZERO, MAX_NOTE_HASHES_PER_TX),
        );
        await this.#appendLeaves(MerkleTreeId.NOTE_HASH_TREE, noteHashesPadded);

        const l1ToL2MessagesPadded = padArrayEnd(l1ToL2Messages, Fr.ZERO, NUMBER_OF_L1_L2_MESSAGES_PER_ROLLUP);
        await this.#appendLeaves(MerkleTreeId.L1_TO_L2_MESSAGE_TREE, l1ToL2MessagesPadded);
      }

      // Sync the indexed trees
      {
        const nullifiersPadded = paddedTxEffects.flatMap(txEffect =>
          padArrayEnd(txEffect.nullifiers, Fr.ZERO, MAX_NULLIFIERS_PER_TX),
        );
        await (this.trees[MerkleTreeId.NULLIFIER_TREE] as StandardIndexedTree).batchInsert(
          nullifiersPadded.map(nullifier => nullifier.toBuffer()),
          NULLIFIER_SUBTREE_HEIGHT,
        );

        const publicDataTree = this.trees[MerkleTreeId.PUBLIC_DATA_TREE] as StandardIndexedTree;

        // We insert the public data tree leaves with one batch per tx to avoid updating the same key twice
        for (const txEffect of paddedTxEffects) {
          const publicDataWrites = padArrayEnd(
            txEffect.publicDataWrites,
            PublicDataWrite.empty(),
            MAX_TOTAL_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
          );

          await publicDataTree.batchInsert(
            publicDataWrites.map(write => write.toBuffer()),
            PUBLIC_DATA_SUBTREE_HEIGHT,
          );
        }
      }

      // The last thing remaining is to update the archive
      await this.#updateArchive(l2Block.header);

      await this.#commit();
    }

    for (const [root, treeId] of treeRootWithIdPairs) {
      const treeName = MerkleTreeId[treeId];
      const info = await this.#getTreeInfo(treeId, false);
      const syncedStr = '0x' + info.root.toString('hex');
      const rootStr = root.toString();
      // Sanity check that the rebuilt trees match the roots published by the L2 block
      if (!info.root.equals(root.toBuffer())) {
        throw new Error(
          `Synced tree root ${treeName} does not match published L2 block root: ${syncedStr} != ${rootStr}`,
        );
      } else {
        this.log.debug(`Tree ${treeName} synched with size ${info.size} root ${rootStr}`);
        this.metrics.recordTreeSize(treeName, info.size);
      }
    }
    await this.#snapshot(l2Block.number);

    this.metrics.recordDbSize(this.store.estimateSize().actualSize);
    this.metrics.recordSyncDuration('commit', timer);
    return buildEmptyWorldStateStatusFull();
  }

  #isDbPopulated(): boolean {
    try {
      getTreeMeta(this.store, MerkleTreeId[MerkleTreeId.NULLIFIER_TREE]);
      // Tree meta was found --> db is populated
      return true;
    } catch (e) {
      // Tree meta was not found --> db is not populated
      return false;
    }
  }
}
