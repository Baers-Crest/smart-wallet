import { KmsSigner } from "./signers/KmsSigner";

/**
 * Prints the Ethereum address controlled by AWS_KMS_KEY_ID.
 *
 * Run this before a first deploy: the address needs funding for gas, and it is
 * the address that becomes the factory admin. Read-only — it calls
 * kms:GetPublicKey and signs nothing.
 */
async function main() {
	const keyId = process.env.AWS_KMS_KEY_ID;

	if (!keyId) {
		throw new Error("AWS_KMS_KEY_ID is not set");
	}

	const address = await new KmsSigner(keyId).getAddress();

	console.log("KMS key:  ", keyId);
	console.log("AWS profile:", process.env.AWS_PROFILE ?? "(default)");
	console.log("Address:  ", address);
}

main().catch(error => {
	console.error(error.message ?? error);
	process.exitCode = 1;
});
