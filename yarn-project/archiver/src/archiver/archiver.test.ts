import {
  EncryptedL2BlockL2Logs,
  EncryptedNoteL2BlockL2Logs,
  InboxLeaf,
  L2Block,
  LogType,
  UnencryptedL2BlockL2Logs,
} from '@aztec/circuit-types';
import { GENESIS_ARCHIVE_ROOT } from '@aztec/circuits.js';
import { DefaultL1ContractsConfig } from '@aztec/ethereum';
import { EthAddress } from '@aztec/foundation/eth-address';
import { Fr } from '@aztec/foundation/fields';
import { sleep } from '@aztec/foundation/sleep';
import { type InboxAbi, RollupAbi } from '@aztec/l1-artifacts';

import { jest } from '@jest/globals';
import { type MockProxy, mock } from 'jest-mock-extended';
import {
  type Chain,
  type HttpTransport,
  type Log,
  type PublicClient,
  type Transaction,
  encodeFunctionData,
  toHex,
} from 'viem';

import { Archiver } from './archiver.js';
import { type ArchiverDataStore } from './archiver_store.js';
import { type ArchiverInstrumentation } from './instrumentation.js';
import { MemoryArchiverStore } from './memory_archiver_store/memory_archiver_store.js';

interface MockRollupContractRead {
  archiveAt: (args: readonly [bigint]) => Promise<`0x${string}`>;
  status: (args: readonly [bigint]) => Promise<[bigint, `0x${string}`, bigint, `0x${string}`, `0x${string}`]>;
}

interface MockInboxContractRead {
  totalMessagesInserted: () => Promise<bigint>;
}

describe('Archiver', () => {
  const rollupAddress = EthAddress.ZERO;
  const inboxAddress = EthAddress.ZERO;
  const registryAddress = EthAddress.ZERO;
  const blockNumbers = [1, 2, 3];

  let publicClient: MockProxy<PublicClient<HttpTransport, Chain>>;
  let instrumentation: MockProxy<ArchiverInstrumentation>;
  let archiverStore: ArchiverDataStore;
  let now: number;

  let rollupRead: MockProxy<MockRollupContractRead>;
  let inboxRead: MockProxy<MockInboxContractRead>;
  let archiver: Archiver;
  let blocks: L2Block[];

  const GENESIS_ROOT = new Fr(GENESIS_ARCHIVE_ROOT).toString();

  beforeEach(() => {
    now = +new Date();
    publicClient = mock<PublicClient<HttpTransport, Chain>>({
      getBlock: ((args: any) => ({
        timestamp: args.blockNumber * BigInt(DefaultL1ContractsConfig.ethereumSlotDuration) + BigInt(now),
      })) as any,
    });

    instrumentation = mock({ isEnabled: () => true });
    archiverStore = new MemoryArchiverStore(1000);

    archiver = new Archiver(
      publicClient,
      rollupAddress,
      inboxAddress,
      registryAddress,
      archiverStore,
      1000,
      instrumentation,
    );

    blocks = blockNumbers.map(x => L2Block.random(x, 4, x, x + 1, 2, 2));

    rollupRead = mock<MockRollupContractRead>();
    rollupRead.archiveAt.mockImplementation((args: readonly [bigint]) =>
      Promise.resolve(blocks[Number(args[0] - 1n)].archive.root.toString()),
    );

    ((archiver as any).rollup as any).read = rollupRead;

    inboxRead = mock<MockInboxContractRead>();
    ((archiver as any).inbox as any).read = inboxRead;
  });

  afterEach(async () => {
    await archiver?.stop();
  });

  it('can start, sync and stop and handle l1 to l2 messages and logs', async () => {
    let latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(0);

    blocks.forEach(
      (b, i) =>
        (b.header.globalVariables.timestamp = new Fr(now + DefaultL1ContractsConfig.ethereumSlotDuration * (i + 1))),
    );
    const rollupTxs = blocks.map(makeRollupTx);

    publicClient.getBlockNumber.mockResolvedValueOnce(2500n).mockResolvedValueOnce(2600n).mockResolvedValueOnce(2700n);

    rollupRead.status
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 1n, blocks[0].archive.root.toString(), GENESIS_ROOT])
      .mockResolvedValue([
        1n,
        blocks[0].archive.root.toString(),
        3n,
        blocks[2].archive.root.toString(),
        blocks[0].archive.root.toString(),
      ]);

    inboxRead.totalMessagesInserted.mockResolvedValueOnce(2n).mockResolvedValueOnce(6n);

    mockGetLogs({
      messageSent: [
        makeMessageSentEventWithIndexInL2BlockSubtree(98n, 1n, 0n),
        makeMessageSentEventWithIndexInL2BlockSubtree(99n, 1n, 1n),
      ],
      L2BlockProposed: [makeL2BlockProposedEvent(101n, 1n, blocks[0].archive.root.toString())],
    });

    mockGetLogs({
      messageSent: [
        makeMessageSentEventWithIndexInL2BlockSubtree(2504n, 2n, 0n),
        makeMessageSentEventWithIndexInL2BlockSubtree(2505n, 2n, 1n),
        makeMessageSentEventWithIndexInL2BlockSubtree(2505n, 2n, 2n),
        makeMessageSentEventWithIndexInL2BlockSubtree(2506n, 3n, 1n),
      ],
      L2BlockProposed: [
        makeL2BlockProposedEvent(2510n, 2n, blocks[1].archive.root.toString()),
        makeL2BlockProposedEvent(2520n, 3n, blocks[2].archive.root.toString()),
      ],
    });

    publicClient.getTransaction.mockResolvedValueOnce(rollupTxs[0]);

    rollupTxs.slice(1).forEach(tx => publicClient.getTransaction.mockResolvedValueOnce(tx));

    await archiver.start(false);

    // Wait until block 3 is processed. If this won't happen the test will fail with timeout.
    while ((await archiver.getBlockNumber()) !== 3) {
      await sleep(100);
    }

    latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(3);

    // L1 to L2 messages
    {
      // Checks that I get correct amount of sequenced new messages for L2 blocks 1 and 2
      let l1ToL2Messages = await archiver.getL1ToL2Messages(1n);
      expect(l1ToL2Messages.length).toEqual(2);

      l1ToL2Messages = await archiver.getL1ToL2Messages(2n);
      expect(l1ToL2Messages.length).toEqual(3);

      // Check that I cannot get messages for block 3 because there is a message gap (message with index 0 was not
      // processed) --> since we are fetching events individually for each message there is a message gap check when
      // fetching the messages for the block in order to ensure that all the messages were really obtained. E.g. if we
      // receive messages with indices 0, 1, 2, 4, 5, 6 we can be sure there is an issue because we are missing message
      // with index 3.
      await expect(async () => {
        await archiver.getL1ToL2Messages(3n);
      }).rejects.toThrow(`L1 to L2 message gap found in block ${3}`);
    }

    // Expect logs to correspond to what is set by L2Block.random(...)
    const noteEncryptedLogs = await archiver.getLogs(1, 100, LogType.NOTEENCRYPTED);
    expect(noteEncryptedLogs.length).toEqual(blockNumbers.length);

    for (const [index, x] of blockNumbers.entries()) {
      const expectedTotalNumEncryptedLogs = 4 * x * 2;
      const totalNumEncryptedLogs = EncryptedNoteL2BlockL2Logs.unrollLogs([noteEncryptedLogs[index]]).length;
      expect(totalNumEncryptedLogs).toEqual(expectedTotalNumEncryptedLogs);
    }

    const encryptedLogs = await archiver.getLogs(1, 100, LogType.ENCRYPTED);
    expect(encryptedLogs.length).toEqual(blockNumbers.length);

    for (const [index, x] of blockNumbers.entries()) {
      const expectedTotalNumEncryptedLogs = 4 * x * 2;
      const totalNumEncryptedLogs = EncryptedL2BlockL2Logs.unrollLogs([encryptedLogs[index]]).length;
      expect(totalNumEncryptedLogs).toEqual(expectedTotalNumEncryptedLogs);
    }

    const unencryptedLogs = await archiver.getLogs(1, 100, LogType.UNENCRYPTED);
    expect(unencryptedLogs.length).toEqual(blockNumbers.length);

    blockNumbers.forEach((x, index) => {
      const expectedTotalNumUnencryptedLogs = 4 * (x + 1) * 2;
      const totalNumUnencryptedLogs = UnencryptedL2BlockL2Logs.unrollLogs([unencryptedLogs[index]]).length;
      expect(totalNumUnencryptedLogs).toEqual(expectedTotalNumUnencryptedLogs);
    });

    blockNumbers.forEach(async x => {
      const expectedTotalNumContractClassLogs = 4;
      const contractClassLogs = await archiver.getContractClassLogs({ fromBlock: x, toBlock: x + 1 });
      expect(contractClassLogs.logs.length).toEqual(expectedTotalNumContractClassLogs);
    });

    // Check last proven block number
    const provenBlockNumber = await archiver.getProvenBlockNumber();
    expect(provenBlockNumber).toEqual(1);

    // Check getting only proven blocks
    expect((await archiver.getBlocks(1, 100)).map(b => b.number)).toEqual([1, 2, 3]);
    expect((await archiver.getBlocks(1, 100, true)).map(b => b.number)).toEqual([1]);
  }, 10_000);

  it('ignores block 3 because it have been pruned (simulate pruning)', async () => {
    const loggerSpy = jest.spyOn((archiver as any).log, 'warn');

    let latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(0);

    const numL2BlocksInTest = 2;

    const rollupTxs = blocks.map(makeRollupTx);

    // Here we set the current L1 block number to 102. L1 to L2 messages after this should not be read.
    publicClient.getBlockNumber.mockResolvedValue(102n);

    const badArchive = Fr.random().toString();

    rollupRead.status.mockResolvedValue([0n, GENESIS_ROOT, 2n, blocks[1].archive.root.toString(), GENESIS_ROOT]);

    inboxRead.totalMessagesInserted.mockResolvedValueOnce(2n).mockResolvedValueOnce(2n);

    mockGetLogs({
      messageSent: [
        makeMessageSentEventWithIndexInL2BlockSubtree(66n, 1n, 0n),
        makeMessageSentEventWithIndexInL2BlockSubtree(68n, 1n, 1n),
      ],
      L2BlockProposed: [
        makeL2BlockProposedEvent(70n, 1n, blocks[0].archive.root.toString()),
        makeL2BlockProposedEvent(80n, 2n, blocks[1].archive.root.toString()),
        makeL2BlockProposedEvent(90n, 3n, badArchive),
      ],
    });

    rollupTxs.forEach(tx => publicClient.getTransaction.mockResolvedValueOnce(tx));

    await archiver.start(false);

    while ((await archiver.getBlockNumber()) !== numL2BlocksInTest) {
      await sleep(100);
    }

    latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(numL2BlocksInTest);
    const errorMessage = `Archive mismatch matching, ignoring block ${3} with archive: ${badArchive}, expected ${blocks[2].archive.root.toString()}`;
    expect(loggerSpy).toHaveBeenCalledWith(errorMessage);
  }, 10_000);

  it('skip event search if no changes found', async () => {
    const loggerSpy = jest.spyOn((archiver as any).log, 'verbose');

    let latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(0);

    const numL2BlocksInTest = 2;

    const rollupTxs = blocks.map(makeRollupTx);

    publicClient.getBlockNumber.mockResolvedValueOnce(50n).mockResolvedValueOnce(100n);
    rollupRead.status
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 0n, GENESIS_ROOT, GENESIS_ROOT])
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 2n, blocks[1].archive.root.toString(), GENESIS_ROOT]);

    inboxRead.totalMessagesInserted.mockResolvedValueOnce(0n).mockResolvedValueOnce(2n);

    mockGetLogs({
      messageSent: [
        makeMessageSentEventWithIndexInL2BlockSubtree(66n, 1n, 0n),
        makeMessageSentEventWithIndexInL2BlockSubtree(68n, 1n, 1n),
      ],
      L2BlockProposed: [
        makeL2BlockProposedEvent(70n, 1n, blocks[0].archive.root.toString()),
        makeL2BlockProposedEvent(80n, 2n, blocks[1].archive.root.toString()),
      ],
    });

    rollupTxs.forEach(tx => publicClient.getTransaction.mockResolvedValueOnce(tx));

    await archiver.start(false);

    while ((await archiver.getBlockNumber()) !== numL2BlocksInTest) {
      await sleep(100);
    }

    latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(numL2BlocksInTest);

    // For some reason, this is 1-indexed.
    expect(loggerSpy).toHaveBeenNthCalledWith(
      1,
      `Retrieved no new L1 -> L2 messages between L1 blocks ${1n} and ${50}.`,
    );
    expect(loggerSpy).toHaveBeenNthCalledWith(2, `No blocks to retrieve from ${1n} to ${50n}`);
  }, 10_000);

  it('handles L2 reorg', async () => {
    const loggerSpy = jest.spyOn((archiver as any).log, 'verbose');

    let latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(0);

    const numL2BlocksInTest = 2;

    const rollupTxs = blocks.map(makeRollupTx);

    publicClient.getBlockNumber.mockResolvedValueOnce(50n).mockResolvedValueOnce(100n).mockResolvedValueOnce(150n);

    // We will return status at first to have an empty round, then as if we have 2 pending blocks, and finally
    // Just a single pending block returning a "failure" for the expected pending block
    rollupRead.status
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 0n, GENESIS_ROOT, GENESIS_ROOT])
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 2n, blocks[1].archive.root.toString(), GENESIS_ROOT])
      .mockResolvedValueOnce([0n, GENESIS_ROOT, 1n, blocks[0].archive.root.toString(), Fr.ZERO.toString()]);

    rollupRead.archiveAt
      .mockResolvedValueOnce(blocks[0].archive.root.toString())
      .mockResolvedValueOnce(blocks[1].archive.root.toString())
      .mockResolvedValueOnce(Fr.ZERO.toString());

    inboxRead.totalMessagesInserted
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(2n)
      .mockResolvedValueOnce(2n);

    mockGetLogs({
      messageSent: [
        makeMessageSentEventWithIndexInL2BlockSubtree(66n, 1n, 0n),
        makeMessageSentEventWithIndexInL2BlockSubtree(68n, 1n, 1n),
      ],
      L2BlockProposed: [
        makeL2BlockProposedEvent(70n, 1n, blocks[0].archive.root.toString()),
        makeL2BlockProposedEvent(80n, 2n, blocks[1].archive.root.toString()),
      ],
    });

    rollupTxs.forEach(tx => publicClient.getTransaction.mockResolvedValueOnce(tx));

    await archiver.start(false);

    while ((await archiver.getBlockNumber()) !== numL2BlocksInTest) {
      await sleep(100);
    }

    latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(numL2BlocksInTest);

    // For some reason, this is 1-indexed.
    expect(loggerSpy).toHaveBeenNthCalledWith(
      1,
      `Retrieved no new L1 -> L2 messages between L1 blocks ${1n} and ${50}.`,
    );
    expect(loggerSpy).toHaveBeenNthCalledWith(2, `No blocks to retrieve from ${1n} to ${50n}`);

    // Lets take a look to see if we can find re-org stuff!
    await sleep(1000);

    expect(loggerSpy).toHaveBeenNthCalledWith(6, `L2 prune have occurred, unwind state`);
    expect(loggerSpy).toHaveBeenNthCalledWith(7, `Unwinding 1 block from block 2`);

    // Should also see the block number be reduced
    latestBlockNum = await archiver.getBlockNumber();
    expect(latestBlockNum).toEqual(numL2BlocksInTest - 1);

    const txHash = blocks[1].body.txEffects[0].txHash;
    expect(await archiver.getTxEffect(txHash)).resolves.toBeUndefined;
    expect(await archiver.getBlock(2)).resolves.toBeUndefined;

    [LogType.NOTEENCRYPTED, LogType.ENCRYPTED, LogType.UNENCRYPTED].forEach(async t => {
      expect(await archiver.getLogs(2, 1, t)).toEqual([]);
    });

    // The random blocks don't include contract instances nor classes we we cannot look for those here.
  }, 10_000);

  // TODO(palla/reorg): Add a unit test for the archiver handleEpochPrune
  xit('handles an upcoming L2 prune', () => {});

  // logs should be created in order of how archiver syncs.
  const mockGetLogs = (logs: {
    messageSent?: ReturnType<typeof makeMessageSentEventWithIndexInL2BlockSubtree>[];
    L2BlockProposed?: ReturnType<typeof makeL2BlockProposedEvent>[];
  }) => {
    if (logs.messageSent) {
      publicClient.getLogs.mockResolvedValueOnce(logs.messageSent);
    }
    if (logs.L2BlockProposed) {
      publicClient.getLogs.mockResolvedValueOnce(logs.L2BlockProposed);
    }
  };
});

/**
 * Makes a fake L2BlockProposed event for testing purposes.
 * @param l1BlockNum - L1 block number.
 * @param l2BlockNum - L2 Block number.
 * @returns An L2BlockProposed event log.
 */
function makeL2BlockProposedEvent(l1BlockNum: bigint, l2BlockNum: bigint, archive: `0x${string}`) {
  return {
    blockNumber: l1BlockNum,
    args: { blockNumber: l2BlockNum, archive },
    transactionHash: `0x${l2BlockNum}`,
  } as Log<bigint, number, false, undefined, true, typeof RollupAbi, 'L2BlockProposed'>;
}

/**
 * Makes fake L1ToL2 MessageSent events for testing purposes.
 * @param l1BlockNum - L1 block number.
 * @param l2BlockNumber - The L2 block number for which the message was included.
 * @param indexInSubtree - the index in the l2Block's subtree in the L1 to L2 Messages Tree.
 * @returns MessageSent event logs.
 */
function makeMessageSentEventWithIndexInL2BlockSubtree(
  l1BlockNum: bigint,
  l2BlockNumber: bigint,
  indexInSubtree: bigint,
) {
  const index = indexInSubtree + InboxLeaf.smallestIndexFromL2Block(l2BlockNumber);
  return {
    blockNumber: l1BlockNum,
    args: {
      l2BlockNumber,
      index,
      hash: Fr.random().toString(),
    },
    transactionHash: `0x${l1BlockNum}`,
  } as Log<bigint, number, false, undefined, true, typeof InboxAbi, 'MessageSent'>;
}

/**
 * Makes a fake rollup tx for testing purposes.
 * @param block - The L2Block.
 * @returns A fake tx with calldata that corresponds to calling process in the Rollup contract.
 */
function makeRollupTx(l2Block: L2Block) {
  const header = toHex(l2Block.header.toBuffer());
  const body = toHex(l2Block.body.toBuffer());
  const archive = toHex(l2Block.archive.root.toBuffer());
  const blockHash = toHex(l2Block.header.hash().toBuffer());
  const input = encodeFunctionData({
    abi: RollupAbi,
    functionName: 'propose',
    args: [
      { header, archive, blockHash, oracleInput: { provingCostModifier: 0n, feeAssetPriceModifier: 0n }, txHashes: [] },
      [],
      body,
    ],
  });
  return { input } as Transaction<bigint, number>;
}
