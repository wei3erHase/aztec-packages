import { deployInitialTestAccounts } from '@aztec/accounts/testing';
import { AztecNodeApiSchema, PXESchema } from '@aztec/circuit-types';
import {
  type NamespacedApiHandlers,
  createNamespacedSafeJsonRpcServer,
  startHttpRpcServer,
} from '@aztec/foundation/json-rpc/server';
import { type DebugLogger, type LogFn } from '@aztec/foundation/log';

import { Command } from 'commander';

import { setupConsoleJsonLog } from '../logging.js';
import { createSandbox } from '../sandbox.js';
import { github, splash } from '../splash.js';
import { aztecStartOptions } from './aztec_start_options.js';
import {
  addOptions,
  createAccountLogs,
  extractNamespacedOptions,
  installSignalHandlers,
  printAztecStartHelpText,
} from './util.js';

/**
 * Returns commander program that defines the 'aztec' command line interface.
 * @param userLog - log function for logging user output.
 * @param debugLogger - logger for logging debug messages.
 */
export function injectAztecCommands(program: Command, userLog: LogFn, debugLogger: DebugLogger): Command {
  const startCmd = new Command('start').description(
    'Starts Aztec modules. Options for each module can be set as key-value pairs (e.g. "option1=value1,option2=value2") or as environment variables.',
  );

  // Assuming commands are added elsewhere, here we just add options to the main program
  Object.keys(aztecStartOptions).forEach(category => {
    addOptions(startCmd, aztecStartOptions[category]);
  });

  startCmd.helpInformation = printAztecStartHelpText;

  startCmd.action(async options => {
    // setup json logging
    if (['1', 'true', 'TRUE'].includes(process.env.LOG_JSON ?? '')) {
      setupConsoleJsonLog();
    }

    // list of 'stop' functions to call when process ends
    const signalHandlers: Array<() => Promise<void>> = [];
    const services: NamespacedApiHandlers = {};

    if (options.sandbox) {
      const sandboxOptions = extractNamespacedOptions(options, 'sandbox');
      userLog(`${splash}\n${github}\n\n`);
      userLog(`Setting up Aztec Sandbox, please stand by...`);
      const { aztecNodeConfig, node, pxe, stop } = await createSandbox({
        enableGas: sandboxOptions.enableGas,
        l1Mnemonic: options.l1Mnemonic,
        l1RpcUrl: options.l1RpcUrl,
      });

      // Deploy test accounts by default
      if (sandboxOptions.testAccounts) {
        if (aztecNodeConfig.p2pEnabled) {
          userLog(`Not setting up test accounts as we are connecting to a network`);
        } else {
          userLog('Setting up test accounts...');
          const accounts = await deployInitialTestAccounts(pxe);
          const accLogs = await createAccountLogs(accounts, pxe);
          userLog(accLogs.join(''));
        }
      }

      // Start Node and PXE JSON-RPC server
      signalHandlers.push(stop);
      services.node = [node, AztecNodeApiSchema];
      services.pxe = [pxe, PXESchema];
    } else {
      if (options.node) {
        const { startNode } = await import('./cmds/start_node.js');
        await startNode(options, signalHandlers, services, userLog);
      } else if (options.proofVerifier) {
        const { startProofVerifier } = await import('./cmds/start_proof_verifier.js');
        await startProofVerifier(options, signalHandlers, userLog);
      } else if (options.bot) {
        const { startBot } = await import('./cmds/start_bot.js');
        await startBot(options, signalHandlers, services, userLog);
      } else if (options.proverNode) {
        const { startProverNode } = await import('./cmds/start_prover_node.js');
        await startProverNode(options, signalHandlers, services, userLog);
      } else if (options.pxe) {
        const { startPXE } = await import('./cmds/start_pxe.js');
        await startPXE(options, signalHandlers, services, userLog);
      } else if (options.archiver) {
        const { startArchiver } = await import('./cmds/start_archiver.js');
        await startArchiver(options, signalHandlers, services);
      } else if (options.p2pBootstrap) {
        const { startP2PBootstrap } = await import('./cmds/start_p2p_bootstrap.js');
        await startP2PBootstrap(options, userLog, debugLogger);
      } else if (options.prover) {
        const { startProverAgent } = await import('./cmds/start_prover_agent.js');
        await startProverAgent(options, signalHandlers, services, userLog);
      } else if (options.txe) {
        const { startTXE } = await import('./cmds/start_txe.js');
        await startTXE(options, debugLogger);
      } else if (options.sequencer) {
        userLog(`Cannot run a standalone sequencer without a node`);
        process.exit(1);
      } else {
        userLog(`No module specified to start`);
        process.exit(1);
      }
    }

    installSignalHandlers(debugLogger.info, signalHandlers);

    if (Object.entries(services).length > 0) {
      const rpcServer = createNamespacedSafeJsonRpcServer(services, debugLogger);
      const { port } = await startHttpRpcServer(rpcServer, { port: options.port });
      debugLogger.info(`Aztec Server listening on port ${port}`);
    }
  });

  program.addCommand(startCmd);

  program.configureHelp({ sortSubcommands: true });

  program.addHelpText(
    'after',
    `

  Additional commands:

    test [options]: starts a dockerized TXE node via
      $ aztec start --txe
    then runs
      $ aztec-nargo test --silence-warnings --oracle-resolver=<TXE_ADDRESS> [options]
    `,
  );

  return program;
}
