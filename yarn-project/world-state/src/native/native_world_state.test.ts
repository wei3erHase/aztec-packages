import { type L2Block, MerkleTreeId } from '@aztec/circuit-types';
import {
  ARCHIVE_HEIGHT,
  AppendOnlyTreeSnapshot,
  EthAddress,
  Fr,
  Header,
  L1_TO_L2_MSG_TREE_HEIGHT,
  MAX_L2_TO_L1_MSGS_PER_TX,
  MAX_NOTE_HASHES_PER_TX,
  MAX_NULLIFIERS_PER_TX,
  MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX,
  NOTE_HASH_TREE_HEIGHT,
  NULLIFIER_TREE_HEIGHT,
  PUBLIC_DATA_TREE_HEIGHT,
} from '@aztec/circuits.js';
import { makeContentCommitment, makeGlobalVariables } from '@aztec/circuits.js/testing';

import { jest } from '@jest/globals';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { assertSameState, compareChains, mockBlock } from '../test/utils.js';
import { INITIAL_NULLIFIER_TREE_SIZE, INITIAL_PUBLIC_DATA_TREE_SIZE } from '../world-state-db/merkle_tree_db.js';
import { type WorldStateStatusSummary } from './message.js';
import { NativeWorldStateService, WORLD_STATE_VERSION_FILE } from './native_world_state.js';
import { WorldStateVersion } from './world_state_version.js';

jest.setTimeout(60_000);

describe('NativeWorldState', () => {
  let dataDir: string;
  let rollupAddress: EthAddress;
  const defaultDBMapSize = 25 * 1024 * 1024;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'world-state-test'));
    rollupAddress = EthAddress.random();
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true });
  });

  describe('persistence', () => {
    let block: L2Block;
    let messages: Fr[];

    beforeAll(async () => {
      const ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      const fork = await ws.fork();
      ({ block, messages } = await mockBlock(1, 2, fork));
      await fork.close();

      await ws.handleL2BlockAndMessages(block, messages);
      await ws.close();
    });

    it('correctly restores committed state', async () => {
      const ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      await expect(
        ws.getCommitted().findLeafIndex(MerkleTreeId.NOTE_HASH_TREE, block.body.txEffects[0].noteHashes[0]),
      ).resolves.toBeDefined();
      const status = await ws.getStatusSummary();
      expect(status.unfinalisedBlockNumber).toBe(1n);
      await ws.close();
    });

    it('clears the database if the rollup is different', async () => {
      // open ws against the same data dir but a different rollup
      let ws = await NativeWorldStateService.new(EthAddress.random(), dataDir, defaultDBMapSize);
      // db should be empty
      await expect(
        ws.getCommitted().findLeafIndex(MerkleTreeId.NOTE_HASH_TREE, block.body.txEffects[0].noteHashes[0]),
      ).resolves.toBeUndefined();

      await ws.close();

      // later on, open ws against the original rollup and same data dir
      // db should be empty because we wiped all its files earlier
      ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      await expect(
        ws.getCommitted().findLeafIndex(MerkleTreeId.NOTE_HASH_TREE, block.body.txEffects[0].noteHashes[0]),
      ).resolves.toBeUndefined();
      const status = await ws.getStatusSummary();
      expect(status.unfinalisedBlockNumber).toBe(0n);
      await ws.close();
    });

    it('clears the database if the world state version is different', async () => {
      // open ws against the data again
      let ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      // db should be empty
      let emptyStatus = await ws.getStatusSummary();
      expect(emptyStatus.unfinalisedBlockNumber).toBe(0n);

      // populate it and then close it
      const fork = await ws.fork();
      ({ block, messages } = await mockBlock(1, 2, fork));
      await fork.close();

      const status = await ws.handleL2BlockAndMessages(block, messages);
      expect(status.summary.unfinalisedBlockNumber).toBe(1n);
      await ws.close();
      // we open up the version file that was created and modify the version to be older
      const fullPath = join(dataDir, 'world_state', WORLD_STATE_VERSION_FILE);
      const storedWorldStateVersion = await WorldStateVersion.readVersion(fullPath);
      expect(storedWorldStateVersion).toBeDefined();
      const modifiedVersion = new WorldStateVersion(
        storedWorldStateVersion!.version - 1,
        storedWorldStateVersion!.rollupAddress,
      );
      await modifiedVersion.writeVersionFile(fullPath);

      // Open the world state again and it should be empty
      ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      // db should be empty
      emptyStatus = await ws.getStatusSummary();
      expect(emptyStatus.unfinalisedBlockNumber).toBe(0n);
      await ws.close();
    });

    it('Fails to sync further blocks if trees are out of sync', async () => {
      // open ws against the same data dir but a different rollup and with a small max db size
      const rollupAddress = EthAddress.random();
      const ws = await NativeWorldStateService.new(rollupAddress, dataDir, 1024);
      const initialFork = await ws.fork();

      const { block: block1, messages: messages1 } = await mockBlock(1, 8, initialFork);
      const { block: block2, messages: messages2 } = await mockBlock(2, 8, initialFork);
      const { block: block3, messages: messages3 } = await mockBlock(3, 8, initialFork);

      // The first block should succeed
      await expect(ws.handleL2BlockAndMessages(block1, messages1)).resolves.toBeDefined();

      // The trees should be synched at block 1
      const goodSummary = await ws.getStatusSummary();
      expect(goodSummary).toEqual({
        unfinalisedBlockNumber: 1n,
        finalisedBlockNumber: 0n,
        oldestHistoricalBlock: 1n,
        treesAreSynched: true,
      } as WorldStateStatusSummary);

      // The second block should fail
      await expect(ws.handleL2BlockAndMessages(block2, messages2)).rejects.toThrow();

      // The summary should indicate that the unfinalised block number (that of the archive tree) is 2
      // But it should also tell us that the trees are not synched
      const badSummary = await ws.getStatusSummary();
      expect(badSummary).toEqual({
        unfinalisedBlockNumber: 2n,
        finalisedBlockNumber: 0n,
        oldestHistoricalBlock: 1n,
        treesAreSynched: false,
      } as WorldStateStatusSummary);

      // Commits should always fail now, the trees are in an inconsistent state
      await expect(ws.handleL2BlockAndMessages(block2, messages2)).rejects.toThrow('World state trees are out of sync');
      await expect(ws.handleL2BlockAndMessages(block3, messages3)).rejects.toThrow('World state trees are out of sync');

      // Creating another world state instance should fail
      await ws.close();
      await expect(NativeWorldStateService.new(rollupAddress, dataDir, 1024)).rejects.toThrow(
        'World state trees are out of sync',
      );
    });
  });

  describe('Forks', () => {
    let ws: NativeWorldStateService;

    beforeEach(async () => {
      ws = await NativeWorldStateService.new(EthAddress.random(), dataDir, defaultDBMapSize);
    });

    afterEach(async () => {
      await ws.close();
    });

    it('creates a fork', async () => {
      const initialHeader = ws.getInitialHeader();
      const fork = await ws.fork();
      await assertSameState(fork, ws.getCommitted());

      expect(fork.getInitialHeader()).toEqual(initialHeader);

      const stateReference = await fork.getStateReference();
      const archiveInfo = await fork.getTreeInfo(MerkleTreeId.ARCHIVE);
      const header = new Header(
        new AppendOnlyTreeSnapshot(new Fr(archiveInfo.root), Number(archiveInfo.size)),
        makeContentCommitment(),
        stateReference,
        makeGlobalVariables(),
        Fr.ZERO,
        Fr.ZERO,
      );

      await fork.updateArchive(header);

      expect(await fork.getTreeInfo(MerkleTreeId.ARCHIVE)).not.toEqual(archiveInfo);
      expect(await ws.getCommitted().getTreeInfo(MerkleTreeId.ARCHIVE)).toEqual(archiveInfo);

      // initial header should still work as before
      expect(fork.getInitialHeader()).toEqual(initialHeader);

      await fork.close();
    });

    it('creates a fork at a block number', async () => {
      const initialFork = await ws.fork();
      for (let i = 0; i < 5; i++) {
        const { block, messages } = await mockBlock(i + 1, 2, initialFork);
        await ws.handleL2BlockAndMessages(block, messages);
      }

      const fork = await ws.fork(3);
      const stateReference = await fork.getStateReference();
      const archiveInfo = await fork.getTreeInfo(MerkleTreeId.ARCHIVE);
      const header = new Header(
        new AppendOnlyTreeSnapshot(new Fr(archiveInfo.root), Number(archiveInfo.size)),
        makeContentCommitment(),
        stateReference,
        makeGlobalVariables(),
        Fr.ZERO,
        Fr.ZERO,
      );

      await fork.updateArchive(header);

      expect(await fork.getTreeInfo(MerkleTreeId.ARCHIVE)).not.toEqual(archiveInfo);

      await fork.close();
    });

    it('can create a fork at block 0 when not latest', async () => {
      const fork = await ws.fork();
      const forkAtGenesis = await ws.fork();

      for (let i = 0; i < 5; i++) {
        const blockNumber = i + 1;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);

        expect(status.summary.unfinalisedBlockNumber).toBe(BigInt(blockNumber));
      }

      const forkAtZero = await ws.fork(0);
      await compareChains(forkAtGenesis, forkAtZero);
    });
  });

  describe('Pending and Proven chain', () => {
    let ws: NativeWorldStateService;

    beforeEach(async () => {
      ws = await NativeWorldStateService.tmp();
    });

    afterEach(async () => {
      await ws.close();
    });

    it('Tracks pending and proven chains', async () => {
      const fork = await ws.fork();

      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const provenBlock = blockNumber - 4;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);

        expect(status.summary.unfinalisedBlockNumber).toBe(BigInt(blockNumber));
        expect(status.summary.oldestHistoricalBlock).toBe(1n);

        if (provenBlock > 0) {
          const provenStatus = await ws.setFinalised(BigInt(provenBlock));
          expect(provenStatus.unfinalisedBlockNumber).toBe(BigInt(blockNumber));
          expect(provenStatus.finalisedBlockNumber).toBe(BigInt(provenBlock));
          expect(provenStatus.oldestHistoricalBlock).toBe(1n);
        } else {
          expect(status.summary.finalisedBlockNumber).toBe(0n);
        }
      }
    });

    it('Can finalise multiple blocks', async () => {
      const fork = await ws.fork();

      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);

        expect(status.summary.unfinalisedBlockNumber).toBe(BigInt(blockNumber));
        expect(status.summary.oldestHistoricalBlock).toBe(1n);
        expect(status.summary.finalisedBlockNumber).toBe(0n);
      }

      const status = await ws.setFinalised(8n);
      expect(status.unfinalisedBlockNumber).toBe(16n);
      expect(status.oldestHistoricalBlock).toBe(1n);
      expect(status.finalisedBlockNumber).toBe(8n);
    });

    it('Can prune historic blocks', async () => {
      const fork = await ws.fork();
      const forks = [];
      const provenBlockLag = 4;
      const prunedBlockLag = 8;

      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const provenBlock = blockNumber - provenBlockLag;
        const prunedBlockNumber = blockNumber - prunedBlockLag;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);

        expect(status.summary.unfinalisedBlockNumber).toBe(BigInt(blockNumber));

        const blockFork = await ws.fork();
        forks.push(blockFork);

        if (provenBlock > 0) {
          const provenStatus = await ws.setFinalised(BigInt(provenBlock));
          expect(provenStatus.finalisedBlockNumber).toBe(BigInt(provenBlock));
        } else {
          expect(status.summary.finalisedBlockNumber).toBe(0n);
        }

        if (prunedBlockNumber > 0) {
          const prunedStatus = await ws.removeHistoricalBlocks(BigInt(prunedBlockNumber + 1));
          expect(prunedStatus.summary.oldestHistoricalBlock).toBe(BigInt(prunedBlockNumber + 1));
        } else {
          expect(status.summary.oldestHistoricalBlock).toBe(1n);
        }
      }

      const highestPrunedBlockNumber = 16 - prunedBlockLag;
      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        if (blockNumber > highestPrunedBlockNumber) {
          await expect(forks[i].getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n)).resolves.toBeDefined();
        } else {
          await expect(forks[i].getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n)).rejects.toThrow('Fork not found');
        }
      }

      //can't prune what has already been pruned
      for (let i = 0; i <= highestPrunedBlockNumber; i++) {
        await expect(ws.removeHistoricalBlocks(BigInt(i + 1))).rejects.toThrow(
          `Unable to remove historical blocks to block number ${BigInt(
            i + 1,
          )}, blocks not found. Current oldest block: ${highestPrunedBlockNumber + 1}`,
        );
      }
    });

    it('Can re-org', async () => {
      const nonReorgState = await NativeWorldStateService.tmp();
      const sequentialReorgState = await NativeWorldStateService.tmp();
      let fork = await ws.fork();

      const blockForks = [];
      const blockTreeInfos = [];
      const blockStats = [];
      const siblingPaths = [];

      // advance 3 chains by 8 blocks, 2 of the chains go to 16 blocks
      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);
        blockStats.push(status);
        const blockFork = await ws.fork();
        blockForks.push(blockFork);
        const treeInfo = await ws.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
        blockTreeInfos.push(treeInfo);
        const siblingPath = await ws.getCommitted().getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n);
        siblingPaths.push(siblingPath);

        if (blockNumber < 9) {
          const statusNonReorg = await nonReorgState.handleL2BlockAndMessages(block, messages);
          expect(status.summary).toEqual(statusNonReorg.summary);

          const treeInfoNonReorg = await nonReorgState.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
          expect(treeInfo).toEqual(treeInfoNonReorg);
        }

        await sequentialReorgState.handleL2BlockAndMessages(block, messages);
      }

      // unwind 1 chain by a single block at a time
      for (let blockNumber = 16; blockNumber > 8; blockNumber--) {
        const unwindStatus = await sequentialReorgState.unwindBlocks(BigInt(blockNumber - 1));
        const unwindFork = await sequentialReorgState.fork();
        const unwindTreeInfo = await sequentialReorgState.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
        const unwindSiblingPath = await sequentialReorgState
          .getCommitted()
          .getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n);

        expect(unwindTreeInfo).toEqual(blockTreeInfos[blockNumber - 2]);
        expect(unwindStatus.summary).toEqual(blockStats[blockNumber - 2].summary);
        expect(await unwindFork.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).toEqual(
          await blockForks[blockNumber - 2].getTreeInfo(MerkleTreeId.NULLIFIER_TREE),
        );
        expect(unwindSiblingPath).toEqual(siblingPaths[blockNumber - 2]);
      }

      // unwind the other 16 block chain by a full 8 blocks in one go
      await ws.unwindBlocks(8n);

      // check that it is not possible to re-org blocks that were already reorged.
      await expect(ws.unwindBlocks(10n)).rejects.toThrow('Unable to unwind block, block not found');

      await compareChains(ws.getCommitted(), sequentialReorgState.getCommitted());

      const unwoundFork = await ws.fork();
      const unwoundTreeInfo = await ws.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
      const unwoundStatus = await ws.getStatusSummary();
      const unwoundSiblingPath = await ws.getCommitted().getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n);

      expect(unwoundStatus).toEqual(blockStats[7].summary);
      expect(unwoundTreeInfo).toEqual(blockTreeInfos[7]);
      expect(await ws.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).toEqual(blockTreeInfos[7]);
      expect(await unwoundFork.getTreeInfo(MerkleTreeId.NULLIFIER_TREE)).toEqual(blockTreeInfos[7]);
      expect(unwoundSiblingPath).toEqual(siblingPaths[7]);

      fork = await ws.fork();

      // now advance both the un-reorged chain and one of the reorged chains to 16 blocks
      for (let i = 8; i < 16; i++) {
        const blockNumber = i + 1;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);
        blockStats[i] = status;
        const blockFork = await ws.fork();
        blockForks[i] = blockFork;
        const treeInfo = await ws.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
        blockTreeInfos[i] = treeInfo;
        const siblingPath = await ws.getCommitted().getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n);
        siblingPaths[i] = siblingPath;

        const statusNonReorg = await nonReorgState.handleL2BlockAndMessages(block, messages);
        expect(status.summary).toEqual(statusNonReorg.summary);
      }

      // compare snapshot across the chains
      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const nonReorgSnapshot = nonReorgState.getSnapshot(blockNumber);
        const reorgSnaphsot = ws.getSnapshot(blockNumber);
        await compareChains(reorgSnaphsot, nonReorgSnapshot);
      }

      await compareChains(ws.getCommitted(), nonReorgState.getCommitted());
    });

    it('Forks are deleted during a re-org', async () => {
      const fork = await ws.fork();

      const blockForks = [];
      const blockTreeInfos = [];
      const blockStats = [];
      const siblingPaths = [];

      for (let i = 0; i < 16; i++) {
        const blockNumber = i + 1;
        const { block, messages } = await mockBlock(blockNumber, 1, fork);
        const status = await ws.handleL2BlockAndMessages(block, messages);
        blockStats.push(status);
        const blockFork = await ws.fork();
        blockForks.push(blockFork);
        const treeInfo = await ws.getCommitted().getTreeInfo(MerkleTreeId.NULLIFIER_TREE);
        blockTreeInfos.push(treeInfo);
        const siblingPath = await ws.getCommitted().getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n);
        siblingPaths.push(siblingPath);
      }

      await ws.unwindBlocks(8n);

      for (let i = 0; i < 16; i++) {
        if (i < 8) {
          expect(await blockForks[i].getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n)).toEqual(siblingPaths[i]);
        } else {
          await expect(blockForks[i].getSiblingPath(MerkleTreeId.NULLIFIER_TREE, 0n)).rejects.toThrow('Fork not found');
        }
      }
    });
  });

  describe('status reporting', () => {
    let block: L2Block;
    let messages: Fr[];

    it('correctly reports status', async () => {
      const ws = await NativeWorldStateService.new(rollupAddress, dataDir, defaultDBMapSize);
      const statuses = [];
      for (let i = 0; i < 2; i++) {
        const fork = await ws.fork();
        ({ block, messages } = await mockBlock(1, 2, fork));
        await fork.close();
        const status = await ws.handleL2BlockAndMessages(block, messages);
        statuses.push(status);

        expect(status.summary).toEqual({
          unfinalisedBlockNumber: BigInt(i + 1),
          finalisedBlockNumber: 0n,
          oldestHistoricalBlock: 1n,
          treesAreSynched: true,
        } as WorldStateStatusSummary);

        expect(status.meta.archiveTreeMeta).toMatchObject({
          depth: ARCHIVE_HEIGHT,
          size: BigInt(i + 2),
          committedSize: BigInt(i + 2),
          initialSize: BigInt(1),
          oldestHistoricBlock: 1n,
          unfinalisedBlockHeight: BigInt(i + 1),
          finalisedBlockHeight: 0n,
        });

        expect(status.meta.noteHashTreeMeta).toMatchObject({
          depth: NOTE_HASH_TREE_HEIGHT,
          size: BigInt(2 * MAX_NOTE_HASHES_PER_TX * (i + 1)),
          committedSize: BigInt(2 * MAX_NOTE_HASHES_PER_TX * (i + 1)),
          initialSize: BigInt(0),
          oldestHistoricBlock: 1n,
          unfinalisedBlockHeight: BigInt(i + 1),
          finalisedBlockHeight: 0n,
        });

        expect(status.meta.nullifierTreeMeta).toMatchObject({
          depth: NULLIFIER_TREE_HEIGHT,
          size: BigInt(2 * MAX_NULLIFIERS_PER_TX * (i + 1) + INITIAL_NULLIFIER_TREE_SIZE),
          committedSize: BigInt(2 * MAX_NULLIFIERS_PER_TX * (i + 1) + INITIAL_NULLIFIER_TREE_SIZE),
          initialSize: BigInt(INITIAL_NULLIFIER_TREE_SIZE),
          oldestHistoricBlock: 1n,
          unfinalisedBlockHeight: BigInt(i + 1),
          finalisedBlockHeight: 0n,
        });

        expect(status.meta.publicDataTreeMeta).toMatchObject({
          depth: PUBLIC_DATA_TREE_HEIGHT,
          size: BigInt(2 * (MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX + 1) * (i + 1) + INITIAL_PUBLIC_DATA_TREE_SIZE),
          committedSize: BigInt(
            2 * (MAX_PUBLIC_DATA_UPDATE_REQUESTS_PER_TX + 1) * (i + 1) + INITIAL_PUBLIC_DATA_TREE_SIZE,
          ),
          initialSize: BigInt(INITIAL_PUBLIC_DATA_TREE_SIZE),
          oldestHistoricBlock: 1n,
          unfinalisedBlockHeight: BigInt(i + 1),
          finalisedBlockHeight: 0n,
        });

        expect(status.meta.messageTreeMeta).toMatchObject({
          depth: L1_TO_L2_MSG_TREE_HEIGHT,
          size: BigInt(2 * MAX_L2_TO_L1_MSGS_PER_TX * (i + 1)),
          committedSize: BigInt(2 * MAX_L2_TO_L1_MSGS_PER_TX * (i + 1)),
          initialSize: BigInt(0),
          oldestHistoricBlock: 1n,
          unfinalisedBlockHeight: BigInt(i + 1),
          finalisedBlockHeight: 0n,
        });
      }

      expect(statuses[1].dbStats.archiveTreeStats.nodesDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.archiveTreeStats.nodesDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.archiveTreeStats.blocksDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.archiveTreeStats.blocksDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.messageTreeStats.nodesDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.messageTreeStats.nodesDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.messageTreeStats.blocksDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.messageTreeStats.blocksDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.noteHashTreeStats.nodesDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.noteHashTreeStats.nodesDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.noteHashTreeStats.blocksDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.noteHashTreeStats.blocksDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.nullifierTreeStats.nodesDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.nullifierTreeStats.nodesDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.nullifierTreeStats.blocksDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.nullifierTreeStats.blocksDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.publicDataTreeStats.nodesDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.publicDataTreeStats.nodesDBStats.numDataItems,
      );
      expect(statuses[1].dbStats.publicDataTreeStats.blocksDBStats.numDataItems).toBeGreaterThan(
        statuses[0].dbStats.publicDataTreeStats.blocksDBStats.numDataItems,
      );

      const mapSizeBytes = BigInt(1024 * defaultDBMapSize);
      expect(statuses[0].dbStats.archiveTreeStats.mapSize).toBe(mapSizeBytes);
      expect(statuses[0].dbStats.messageTreeStats.mapSize).toBe(mapSizeBytes);
      expect(statuses[0].dbStats.nullifierTreeStats.mapSize).toBe(mapSizeBytes);
      expect(statuses[0].dbStats.noteHashTreeStats.mapSize).toBe(mapSizeBytes);
      expect(statuses[0].dbStats.publicDataTreeStats.mapSize).toBe(mapSizeBytes);

      await ws.close();
    });
  });
});
