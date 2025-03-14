import {
  type AccountWallet,
  FeeJuicePaymentMethod,
  FeeJuicePaymentMethodWithClaim,
  type FeePaymentMethod,
  NoFeePaymentMethod,
  type PXE,
  PrivateFeePaymentMethod,
  PublicFeePaymentMethod,
  type SendMethodOptions,
} from '@aztec/aztec.js';
import { AztecAddress, Fr, Gas, GasFees, GasSettings } from '@aztec/circuits.js';
import { type LogFn } from '@aztec/foundation/log';

import { Option } from 'commander';

import { type WalletDB } from '../../storage/wallet_db.js';
import { aliasedAddressParser } from './index.js';

export type CliFeeArgs = {
  estimateGasOnly: boolean;
  gasLimits?: string;
  payment?: string;
  maxFeesPerGas?: string;
  estimateGas?: boolean;
};

export interface IFeeOpts {
  estimateOnly: boolean;
  gasSettings: GasSettings;
  toSendOpts(sender: AccountWallet): Promise<SendMethodOptions>;
}

export function printGasEstimates(
  feeOpts: IFeeOpts,
  gasEstimates: Pick<GasSettings, 'gasLimits' | 'teardownGasLimits'>,
  log: LogFn,
) {
  log(`Estimated gas usage:    ${formatGasEstimate(gasEstimates)}`);
  log(`Maximum total tx fee:   ${getEstimatedCost(gasEstimates, feeOpts.gasSettings.maxFeesPerGas)}`);
}

function formatGasEstimate(estimate: Pick<GasSettings, 'gasLimits' | 'teardownGasLimits'>) {
  return `da=${estimate.gasLimits.daGas},l2=${estimate.gasLimits.l2Gas},teardownDA=${estimate.teardownGasLimits.daGas},teardownL2=${estimate.teardownGasLimits.l2Gas}`;
}

function getEstimatedCost(estimate: Pick<GasSettings, 'gasLimits' | 'teardownGasLimits'>, fees: GasFees) {
  return GasSettings.from({ ...GasSettings.default(), ...estimate, maxFeesPerGas: fees })
    .getFeeLimit()
    .toBigInt();
}

export class FeeOpts implements IFeeOpts {
  constructor(
    public estimateOnly: boolean,
    public gasSettings: GasSettings,
    private paymentMethodFactory: (sender: AccountWallet) => Promise<FeePaymentMethod>,
    private estimateGas: boolean,
  ) {}

  async toSendOpts(sender: AccountWallet): Promise<SendMethodOptions> {
    return {
      estimateGas: this.estimateGas,
      fee: {
        gasSettings: this.gasSettings,
        paymentMethod: await this.paymentMethodFactory(sender),
      },
    };
  }

  static paymentMethodOption() {
    return new Option(
      '--payment <method=name,asset=address,fpc=address,claimSecret=string,claimAmount=string,feeRecipient=string>',
      'Fee payment method and arguments. Valid methods are: none, fee_juice, fpc-public, fpc-private.',
    );
  }

  static getOptions() {
    return [
      new Option('--gas-limits <da=100,l2=100,teardownDA=10,teardownL2=10>', 'Gas limits for the tx.'),
      FeeOpts.paymentMethodOption(),
      new Option('--max-fee-per-gas <da=100,l2=100>', 'Maximum fee per gas unit for DA and L2 computation.'),
      new Option('--no-estimate-gas', 'Whether to automatically estimate gas limits for the tx.'),
      new Option('--estimate-gas-only', 'Only report gas estimation for the tx, do not send it.'),
    ];
  }

  static async fromCli(args: CliFeeArgs, pxe: PXE, log: LogFn, db?: WalletDB) {
    const estimateOnly = args.estimateGasOnly;
    const gasFees = args.maxFeesPerGas
      ? parseGasFees(args.maxFeesPerGas)
      : { maxFeesPerGas: await pxe.getCurrentBaseFees() };
    const input = {
      ...GasSettings.default(),
      ...(args.gasLimits ? parseGasLimits(args.gasLimits) : {}),
      ...gasFees,
    };
    const gasSettings = GasSettings.from(input);

    if (!args.gasLimits && !args.payment) {
      return new NoFeeOpts(estimateOnly, gasSettings);
    }

    return new FeeOpts(
      estimateOnly,
      gasSettings,
      args.payment ? parsePaymentMethod(args.payment, log, db) : () => Promise.resolve(new NoFeePaymentMethod()),
      !!args.estimateGas,
    );
  }
}

class NoFeeOpts implements IFeeOpts {
  constructor(public estimateOnly: boolean, public gasSettings: GasSettings) {}

  toSendOpts(): Promise<SendMethodOptions> {
    return Promise.resolve({});
  }
}

export function parsePaymentMethod(
  payment: string,
  log: LogFn,
  db?: WalletDB,
): (sender: AccountWallet) => Promise<FeePaymentMethod> {
  const parsed = payment.split(',').reduce((acc, item) => {
    const [dimension, value] = item.split('=');
    acc[dimension] = value ?? 1;
    return acc;
  }, {} as Record<string, string>);

  const getFpcOpts = (parsed: Record<string, string>, db?: WalletDB) => {
    if (!parsed.fpc) {
      throw new Error('Missing "fpc" in payment option');
    }
    if (!parsed.asset) {
      throw new Error('Missing "asset" in payment option');
    }
    if (!parsed.feeRecipient) {
      // Recipient of a fee in the refund flow
      throw new Error('Missing "feeRecipient" in payment option');
    }

    const fpc = aliasedAddressParser('contracts', parsed.fpc, db);
    const feeRecipient = AztecAddress.fromString(parsed.feeRecipient);

    return [AztecAddress.fromString(parsed.asset), fpc, feeRecipient];
  };

  return async (sender: AccountWallet) => {
    switch (parsed.method) {
      case 'none':
        log('Using no fee payment');
        return new NoFeePaymentMethod();
      case 'native':
        if (parsed.claim || (parsed.claimSecret && parsed.claimAmount && parsed.messageLeafIndex)) {
          let claimAmount, claimSecret, messageLeafIndex;
          if (parsed.claim && db) {
            ({
              amount: claimAmount,
              secret: claimSecret,
              leafIndex: messageLeafIndex,
            } = await db.popBridgedFeeJuice(sender.getAddress(), log));
          } else {
            ({ claimAmount, claimSecret, messageLeafIndex } = parsed);
          }
          log(`Using Fee Juice for fee payments with claim for ${claimAmount} tokens`);
          return new FeeJuicePaymentMethodWithClaim(sender.getAddress(), {
            claimAmount: typeof claimAmount === 'string' ? Fr.fromString(claimAmount) : new Fr(claimAmount),
            claimSecret: Fr.fromString(claimSecret),
            messageLeafIndex: BigInt(messageLeafIndex),
          });
        } else {
          log(`Using Fee Juice for fee payment`);
          return new FeeJuicePaymentMethod(sender.getAddress());
        }
      case 'fpc-public': {
        const [asset, fpc] = getFpcOpts(parsed, db);
        log(`Using public fee payment with asset ${asset} via paymaster ${fpc}`);
        return new PublicFeePaymentMethod(asset, fpc, sender);
      }
      case 'fpc-private': {
        const [asset, fpc, feeRecipient] = getFpcOpts(parsed, db);
        log(
          `Using private fee payment with asset ${asset} via paymaster ${fpc} with rebate secret ${feeRecipient.toString()}`,
        );
        return new PrivateFeePaymentMethod(asset, fpc, sender, feeRecipient);
      }
      case undefined:
        throw new Error('Missing "method" in payment option');
      default:
        throw new Error(`Invalid fee payment method: ${payment}`);
    }
  };
}

function parseGasLimits(gasLimits: string): { gasLimits: Gas; teardownGasLimits: Gas } {
  const parsed = gasLimits.split(',').reduce((acc, limit) => {
    const [dimension, value] = limit.split('=');
    acc[dimension] = parseInt(value, 10);
    return acc;
  }, {} as Record<string, number>);

  const expected = ['da', 'l2', 'teardownDA', 'teardownL2'];
  for (const dimension of expected) {
    if (!(dimension in parsed)) {
      throw new Error(`Missing gas limit for ${dimension}`);
    }
  }

  return {
    gasLimits: new Gas(parsed.da, parsed.l2),
    teardownGasLimits: new Gas(parsed.teardownDA, parsed.teardownL2),
  };
}

function parseGasFees(gasFees: string): { maxFeesPerGas: GasFees } {
  const parsed = gasFees.split(',').reduce((acc, fee) => {
    const [dimension, value] = fee.split('=');
    acc[dimension] = parseInt(value, 10);
    return acc;
  }, {} as Record<string, number>);

  const expected = ['da', 'l2'];
  for (const dimension of expected) {
    if (!(dimension in parsed)) {
      throw new Error(`Missing gas fee for ${dimension}`);
    }
  }

  return { maxFeesPerGas: new GasFees(parsed.da, parsed.l2) };
}
