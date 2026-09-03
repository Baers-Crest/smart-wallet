import hre, { ethers } from "hardhat";

const TIMEOUT_MS = Number(process.env.DOCTOR_TIMEOUT_MS ?? 15_000);

type Status = "ok" | "warn" | "fail";

type Check = { name: string; status: Status; detail: string; ms?: number };

const results: Check[] = [];

function record(name: string, ok: boolean, detail: string, ms?: number) {
	results.push({ name, status: ok ? "ok" : "fail", detail, ms });
}

/**
 * A problem that blocks one deploy script but not the other, or a setting that
 * is only conventionally required. Reported, but does not fail the run.
 */
function warn(name: string, detail: string) {
	results.push({ name, status: "warn", detail });
}

/**
 * First line of whatever was thrown. `error.message` cannot be assumed: a
 * rejected non-Error (an AWS SDK or provider rejecting with a plain object or a
 * string) would otherwise crash the preflight inside its own catch block.
 */
function firstLine(error: unknown): string {
	const message = typeof (error as any)?.message === "string" ? (error as any).message : String(error);

	return message.split("\n")[0];
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

async function checkKms() {
	const mode = (process.env.DEPLOYER_SIGNER ?? "local").toLowerCase();

	if (mode !== "kms") {
		if (mode === "local") {
			record("KMS", true, "skipped (DEPLOYER_SIGNER=local)");
		}

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
	} catch (error: unknown) {
		record("KMS", false, `${keyId} (profile ${profile}) — ${firstLine(error)}`, Date.now() - started);
	}
}

async function checkDeployerBalance() {
	const blocker = results.find(r => ["Environment", "KMS"].includes(r.name) && r.status === "fail");

	if (blocker) {
		record("Deployer balance", false, `skipped — ${blocker.name} check failed`);
		return;
	}

	try {
		const { getDeployer } = await import("./signers/getDeployer");

		// Every leg has to sit inside the timeout: resolving the signer only talks
		// to the node, while `getAddress` is the kms:GetPublicKey call and
		// `getBalance` an eth_getBalance. Bounding just the first would let a node
		// that answers eth_chainId and then stalls hang the preflight for ever.
		const { address, balance } = await withTimeout("Deployer", async () => {
			const deployer = await getDeployer({ quiet: true });
			const resolved = await deployer.getAddress();

			return { address: resolved, balance: await ethers.provider.getBalance(resolved) };
		});

		record(
			"Deployer balance",
			balance > 0n,
			`${address} holds ${ethers.formatEther(balance)} ETH` + (balance > 0n ? "" : " — fund this address before deploying")
		);
	} catch (error: unknown) {
		record("Deployer balance", false, firstLine(error));
	}
}

function checkEnv() {
	const mode = (process.env.DEPLOYER_SIGNER ?? "local").toLowerCase();

	if (mode !== "kms" && mode !== "local") {
		record("Environment", false, `unknown DEPLOYER_SIGNER '${mode}' — expected 'kms' or 'local'`);
		return;
	}

	// localhost and hardhat take their accounts from the node, not PRIVATE_KEY.
	const needsPrivateKey = !["localhost", "hardhat"].includes(hre.network.name);

	const required: [string, unknown][] =
		mode === "kms" ? [["AWS_KMS_KEY_ID", process.env.AWS_KMS_KEY_ID]] : needsPrivateKey ? [["PRIVATE_KEY", process.env.PRIVATE_KEY]] : [];

	const missing = required.filter(([, value]) => !value).map(([name]) => name);

	record("Environment", missing.length === 0, missing.length === 0 ? `mode=${mode}, all required variables set` : `missing: ${missing.join(", ")}`);

	if (mode === "kms" && !process.env.AWS_PROFILE) {
		warn("AWS_PROFILE", "not set — falling back to the rest of the AWS provider chain");
	}
}

function checkTokenFactoryEnv() {
	const problems = (["FACTORY_ADMIN_ADDRESS", "TOKEN_DEPLOYER_ADDRESS"] as const)
		.map(name => {
			const value = process.env[name];

			if (!value) {
				return `${name} is not set`;
			}

			if (!ethers.isAddress(value)) {
				return `${name} is not an address (${value})`;
			}

			if (value === ethers.ZeroAddress) {
				return `${name} is the zero address — initialize would revert`;
			}

			return undefined;
		})
		.filter((problem): problem is string => problem !== undefined);

	if (problems.length > 0) {
		warn("Token factory roles", `${problems.join("; ")} — needed by deploy:tokenFactory only`);
		return;
	}

	record("Token factory roles", true, `admin ${process.env.FACTORY_ADMIN_ADDRESS}, token deployer ${process.env.TOKEN_DEPLOYER_ADDRESS}`);
}

const SYMBOLS: Record<Status, string> = { ok: "✓", warn: "!", fail: "✗" };

async function main() {
	console.log(`\nPreflight — network '${hre.network.name}', timeout ${TIMEOUT_MS}ms\n`);

	checkEnv();
	checkTokenFactoryEnv();
	await checkKms();
	await checkDeployerBalance();

	const width = Math.max(...results.map(r => r.name.length));

	for (const { name, status, detail, ms } of results) {
		const timing = ms === undefined ? "" : ` [${ms}ms]`;
		console.log(`  ${SYMBOLS[status]} ${name.padEnd(width)}  ${detail}${timing}`);
	}

	const failed = results.filter(r => r.status === "fail");
	const warned = results.filter(r => r.status === "warn");
	console.log();

	if (failed.length > 0) {
		console.log(`${failed.length} check(s) failed: ${failed.map(f => f.name).join(", ")}\n`);
		process.exitCode = 1;
		return;
	}

	if (warned.length > 0) {
		console.log(`All checks passed with ${warned.length} warning(s): ${warned.map(w => w.name).join(", ")}\n`);
		return;
	}

	console.log("All checks passed — safe to deploy.\n");
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
