import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    MnemonicIdentity,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    Wallet,
    arkade,
    networks,
    resolveEmulatorPubkey,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { walletParty, type Ctx, type Party } from "../core/actions.js";
import type { Config } from "./config.js";

export interface NetworkHandle {
    ctx: Ctx;
    ark: Awaited<ReturnType<typeof arkade.Arkade.connect>>;
    arkProvider: RestArkProvider;
    indexer: RestIndexerProvider;
    emulator: RestEmulatorProvider;
    info: Awaited<ReturnType<RestArkProvider["getInfo"]>>;
    emulatorPubkey: string;
    exitDelaySeconds: bigint;
}

/**
 * Connects and checks the operator/emulator identity against independently configured pins. The emulator's
 * self-reported key is compared, never adopted: covenants commit to the pinned key.
 */
export async function connectNetwork(cfg: Config): Promise<NetworkHandle> {
    const arkProvider = new RestArkProvider(cfg.ARK_SERVER_URL);
    const indexer = new RestIndexerProvider(cfg.ARK_SERVER_URL);
    const emulator = new RestEmulatorProvider(cfg.EMULATOR_URL);
    const info = await arkProvider.getInfo();
    if (info.network !== cfg.APM_NETWORK) throw new Error(`arkd reports network ${info.network}, configured ${cfg.APM_NETWORK}`);
    if (cfg.ARK_SIGNER_PUBKEY && info.signerPubkey !== cfg.ARK_SIGNER_PUBKEY) {
        throw new Error(`arkd signer ${info.signerPubkey} != pinned ${cfg.ARK_SIGNER_PUBKEY}`);
    }
    const network = networks[cfg.APM_NETWORK];
    const emulatorPubkey = resolveEmulatorPubkey(network, cfg.EMULATOR_PUBKEY);
    const emuInfo = await emulator.getInfo();
    if (emuInfo.signerPubkey !== emulatorPubkey) {
        throw new Error(`emulator reports signer ${emuInfo.signerPubkey}, pinned ${emulatorPubkey}`);
    }
    const exitDelaySeconds = BigInt(info.unilateralExitDelay);
    if (exitDelaySeconds < 512n || exitDelaySeconds % 512n !== 0n) {
        throw new Error(`unilateral exit delay ${exitDelaySeconds} is not a seconds-based multiple of 512`);
    }
    const ark = await arkade.Arkade.connect({ arkade: arkProvider, emulator, indexer, network, emulatorPubkey });
    const net = { ark: arkProvider, emulator, indexer, checkpoint: ark.checkpoint };
    return { ctx: { ark, net, indexer }, ark, arkProvider, indexer, emulator, info, emulatorPubkey, exitDelaySeconds };
}

export async function partyFromMnemonic(cfg: Config, mnemonic: string): Promise<{ party: Party; wallet: Wallet }> {
    const identity = MnemonicIdentity.fromMnemonic(mnemonic, { isMainnet: false });
    const wallet = await Wallet.create({
        identity,
        arkServerUrl: cfg.ARK_SERVER_URL,
        onchainProvider: new EsploraProvider(cfg.ESPLORA_URL),
        storage: { walletRepository: new InMemoryWalletRepository(), contractRepository: new InMemoryContractRepository() },
        settlementConfig: false,
    });
    return { party: await walletParty(wallet, identity), wallet };
}

export const keyHex = (b: Uint8Array) => hex.encode(b);
