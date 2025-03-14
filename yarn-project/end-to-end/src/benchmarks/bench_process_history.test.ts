import { type AztecNodeConfig, AztecNodeService } from '@aztec/aztec-node';
import { AztecAddress, Fr, INITIAL_L2_BLOCK_NUM, elapsed, sleep } from '@aztec/aztec.js';
import {
  BENCHMARK_HISTORY_BLOCK_SIZE,
  BENCHMARK_HISTORY_CHAIN_LENGTHS,
  type NodeSyncedChainHistoryStats,
} from '@aztec/circuit-types/stats';
import { type BenchmarkingContract } from '@aztec/noir-contracts.js/Benchmarking';
import { type SequencerClient } from '@aztec/sequencer-client';

import { type EndToEndContext } from '../fixtures/utils.js';
import { benchmarkSetup, getFolderSize, makeDataDirectory, sendTxs, waitNewPXESynced } from './utils.js';

const BLOCK_SIZE = BENCHMARK_HISTORY_BLOCK_SIZE;
const CHAIN_LENGTHS = BENCHMARK_HISTORY_CHAIN_LENGTHS;
const MAX_CHAIN_LENGTH = CHAIN_LENGTHS[CHAIN_LENGTHS.length - 1];

let setupBlockCount: number;

describe('benchmarks/process_history', () => {
  let context: EndToEndContext;
  let contract: BenchmarkingContract;
  let sequencer: SequencerClient;

  beforeEach(async () => {
    ({ context, contract, sequencer } = await benchmarkSetup({ maxTxsPerBlock: BLOCK_SIZE }));
    setupBlockCount = await context.aztecNode.getBlockNumber();
  });

  it(
    `processes chain history of ${MAX_CHAIN_LENGTH} with ${BLOCK_SIZE}-tx blocks`,
    async () => {
      // Ensure each block has exactly BLOCK_SIZE txs
      sequencer.updateSequencerConfig({ minTxsPerBlock: BLOCK_SIZE });
      let lastBlock = 0;

      for (const chainLength of CHAIN_LENGTHS) {
        // Send enough txs to move the chain to the next block number checkpoint
        const txCount = (chainLength - lastBlock) * BLOCK_SIZE;
        const sentTxs = await sendTxs(txCount, context, contract);
        await Promise.all(sentTxs.map(tx => tx.wait({ timeout: 5 * 60_000 })));
        await sleep(100);

        // Create a new node and measure how much time it takes it to sync
        const dataDirectory = makeDataDirectory(chainLength);
        context.logger.info(`Set up data directory at ${dataDirectory}`);
        const nodeConfig: AztecNodeConfig = { ...context.config, disableValidator: true, dataDirectory };
        const [nodeSyncTime, node] = await elapsed(async () => {
          const node = await AztecNodeService.createAndSync(nodeConfig);
          // call getPublicStorageAt (which calls #getWorldState, which calls #syncWorldState) to force a sync with
          // world state to ensure the node has caught up
          await node.getPublicStorageAt(AztecAddress.random(), Fr.random(), 'latest');
          return node;
        });

        const blockNumber = await node.getBlockNumber();
        expect(blockNumber).toEqual(chainLength + setupBlockCount);

        context.logger.info(`Node synced chain up to block ${chainLength}`, {
          eventName: 'node-synced-chain-history',
          txCount: BLOCK_SIZE * chainLength,
          txsPerBlock: BLOCK_SIZE,
          duration: nodeSyncTime,
          blockNumber,
          blockCount: chainLength,
          dbSize: getFolderSize(dataDirectory),
        } satisfies NodeSyncedChainHistoryStats);

        // Create a new pxe and measure how much time it takes it to sync with failed and successful decryption
        // Skip the first two blocks used for setup (create account contract and deploy benchmarking contract)
        context.logger.info(`Starting new pxe`);
        const pxe = await waitNewPXESynced(node, contract, INITIAL_L2_BLOCK_NUM + setupBlockCount);

        // Register the owner account and wait until it's synced so we measure how much time it took
        context.logger.info(`Registering owner account on new pxe`);
        const partialAddress = context.wallet.getCompleteAddress().partialAddress;
        const secretKey = context.wallet.getSecretKey();
        await pxe.registerAccount(secretKey, partialAddress);

        // Repeat for another account that didn't receive any notes for them, so we measure trial-decrypts
        context.logger.info(`Registering fresh account on new pxe`);
        await pxe.registerAccount(Fr.random(), Fr.random());

        // Stop the external node and pxe
        await pxe.stop();
        await node.stop();

        lastBlock = chainLength;
      }

      await context.teardown();
    },
    60 * 60_000,
  );
});
