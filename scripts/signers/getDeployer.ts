import { ethers } from "hardhat";
import type { Signer } from "ethers";
import { KmsSigner } from "./KmsSigner";

/** Chain ids where a raw private key is not an acceptable deploy credential. */
const MAINNET_CHAIN_IDS = new Set([1n, 137n]);

/**
 * Resolves the signer used for deployments.
 *
 * DEPLOYER_SIGNER=kms   -> AWS KMS, credentials from the standard AWS chain
 *                          (i.e. `aws sso login` + AWS_PROFILE). Requires
 *                          AWS_KMS_KEY_ID.
 * DEPLOYER_SIGNER=local -> the first account from hardhat.config.ts, which is
 *                          PRIVATE_KEY in .env. Default, for local and testnet
 *                          work.
 *
 * The mode is explicit on purpose: a mainnet deploy must never silently fall
 * back to a raw key because a KMS variable was mistyped.
 */
export async function getDeployer(options: { quiet?: boolean } = {}): Promise<Signer> {
	const mode = (process.env.DEPLOYER_SIGNER ?? "local").toLowerCase();
	const network = await ethers.provider.getNetwork();
	// The preflight prints its own report; a second banner inside it is noise.
	const announce = options.quiet ? async () => {} : printBanner;

	if (mode === "kms") {
		const keyId = process.env.AWS_KMS_KEY_ID;

		if (!keyId) {
			throw new Error("DEPLOYER_SIGNER=kms but AWS_KMS_KEY_ID is not set");
		}

		const signer = new KmsSigner(keyId, ethers.provider);
		await announce(signer, `AWS KMS (${keyId})`, network.chainId);

		return signer;
	}

	if (mode !== "local") {
		throw new Error(`Unknown DEPLOYER_SIGNER '${mode}' — expected 'kms' or 'local'`);
	}

	const [signer] = await ethers.getSigners();

	if (!signer) {
		throw new Error("No local signer available — set PRIVATE_KEY in .env, or use DEPLOYER_SIGNER=kms");
	}

	if (MAINNET_CHAIN_IDS.has(network.chainId) && process.env.ALLOW_RAW_KEY_ON_MAINNET !== "true") {
		throw new Error(
			`Refusing to deploy to chain ${network.chainId} with a raw private key.\n` +
				"Use DEPLOYER_SIGNER=kms, or set ALLOW_RAW_KEY_ON_MAINNET=true to override deliberately."
		);
	}

	// On localhost/hardhat the accounts come from the node, not from .env — say
	// which, so the banner never claims a key that is not in play.
	const source = process.env.PRIVATE_KEY ? "local private key (.env PRIVATE_KEY)" : "account supplied by the node";

	await announce(signer, source, network.chainId);

	return signer;
}

async function printBanner(signer: Signer, source: string, chainId: bigint): Promise<void> {
	const address = await signer.getAddress();
	const balance = await ethers.provider.getBalance(address);

	console.log("Deployer");
	console.log("  source:  ", source);
	console.log("  address: ", address);
	console.log("  chain:   ", chainId.toString());
	console.log("  balance: ", ethers.formatEther(balance), "ETH");
	console.log();
}
