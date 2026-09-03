import hre, { ethers } from "hardhat";

/**
 * Preflight for deployments: checks each external dependency separately so a
 * failure names the endpoint responsible.
 *
 * A bare `ConnectTimeoutError` from undici carries no application frames, and
 * undici is Hardhat's HTTP client — not the AWS SDK's — so a timeout there is
 * always the RPC or an explorer, never KMS.
 */
const TIMEOUT_MS = Number(process.env.DOCTOR_TIMEOUT_MS ?? 15_000);

type Check = { name: string; ok: boolean; detail: string; ms?: number };

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string, ms?: number) {
	results.push({ name, ok, detail, ms });
}

async function withTimeout<T>(label: string, run: () => Promise<T>): Promise<T> {
	let timer: NodeJS.Timeout;

	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not respond within ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
	});

	try {
		return await Promise.race([run(), timeout]);
	} finally {
		clearTimeout(timer!);
	}
}

/** Path of an RPC URL, or "" if it does not parse — never throws. */
function safePathname(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "";
	}
}

/** Hides the API key in an RPC URL so the output is safe to paste. */
function maskUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const segments = parsed.pathname.split("/").filter(Boolean);

		if (segments.length > 0) {
			// Replace the key outright — a prefix is still a credential leak in a
			// pasted bug report. Built by hand so the placeholder is not
			// percent-encoded by URL.toString().
			segments[segments.length - 1] = "<key>";
		}

		return `${parsed.protocol}//${parsed.host}/${segments.join("/")}`;
	} catch {
		return "(unparseable URL)";
	}
}

async function checkKms() {
	const mode = (process.env.DEPLOYER_SIGNER ?? "local").toLowerCase();

	if (mode !== "kms") {
		record("KMS", true, `skipped (DEPLOYER_SIGNER=${mode})`);
		return;
	}

	const keyId = process.env.AWS_KMS_KEY_ID;

	if (!keyId) {
		record("KMS", false, "DEPLOYER_SIGNER=kms but AWS_KMS_KEY_ID is not set");
		return;
	}

	const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
	const profile = process.env.AWS_PROFILE ?? "(default)";
	const started = Date.now();

	try {
		const { KmsSigner } = await import("./signers/KmsSigner");
		const address = await withTimeout("KMS", () => new KmsSigner(keyId).getAddress());

		record("KMS", true, `${keyId} -> ${address} (profile ${profile}, region ${region ?? "from profile"})`, Date.now() - started);
	} catch (error: any) {
		record("KMS", false, `${keyId} (profile ${profile}) — ${error.message.split("\n")[0]}`, Date.now() - started);
	}
}

async function checkDeployerBalance() {
	const blocker = results.find(r => (r.name === "RPC" || r.name === "KMS") && !r.ok);

	if (blocker) {
		record("Deployer balance", false, `skipped — ${blocker.name} check failed`);
		return;
	}

	try {
		const { getDeployer } = await import("./signers/getDeployer");
		const deployer = await withTimeout("Deployer", () => getDeployer({ quiet: true }));
		const address = await deployer.getAddress();
		const balance = await ethers.provider.getBalance(address);

		record(
			"Deployer balance",
			balance > 0n,
			`${address} holds ${ethers.formatEther(balance)} ETH` + (balance > 0n ? "" : " — fund this address before deploying")
		);
	} catch (error: any) {
		record("Deployer balance", false, error.message.split("\n")[0]);
	}
}

function checkEnv() {
	const mode = (process.env.DEPLOYER_SIGNER ?? "local").toLowerCase();

	// localhost and hardhat take their accounts from the node, not PRIVATE_KEY.
	const needsPrivateKey = !["localhost", "hardhat"].includes(hre.network.name);

	const required: [string, unknown][] =
		mode === "kms"
			? [
					["AWS_KMS_KEY_ID", process.env.AWS_KMS_KEY_ID],
					["AWS_PROFILE", process.env.AWS_PROFILE]
			  ]
			: needsPrivateKey
			? [["PRIVATE_KEY", process.env.PRIVATE_KEY]]
			: [];

	const missing = required.filter(([, value]) => !value).map(([name]) => name);

	record("Environment", missing.length === 0, missing.length === 0 ? `mode=${mode}, all required variables set` : `missing: ${missing.join(", ")}`);
}

async function main() {
	console.log(`\nPreflight — network '${hre.network.name}', timeout ${TIMEOUT_MS}ms\n`);

	checkEnv();
	await checkKms();
	await checkDeployerBalance();

	for (const { name, ok, detail, ms } of results) {
		const timing = ms === undefined ? "" : ` [${ms}ms]`;
		console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(18)} ${detail}${timing}`);
	}

	const failed = results.filter(r => !r.ok);
	console.log();

	if (failed.length > 0) {
		console.log(`${failed.length} check(s) failed: ${failed.map(f => f.name).join(", ")}\n`);
		process.exitCode = 1;
	} else {
		console.log("All checks passed — safe to deploy.\n");
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
