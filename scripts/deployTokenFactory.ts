import { ethers, upgrades } from "hardhat";

/**
 * Deploys the TokenFactory stack:
 *   1. the shared CurrencyToken implementation that new token proxies point at;
 *   2. the TokenFactory itself, behind a transparent proxy.
 *
 * Every token the factory deploys is its own ERC-1967 (UUPS) proxy over the
 * implementation from step 1, upgradeable by that token's own owner.
 */
async function main() {
	const [admin] = await ethers.getSigners();

	const tokenAdmin = process.env.TOKEN_ADMIN_ADDRESS ?? admin.address;
	if (!tokenAdmin) {
		throw new Error("TOKEN_ADMIN_ADDRESS is not set");
	}

	const tokenDeployer = process.env.TOKEN_DEPLOYER_ADDRESS ?? admin.address;
	if (!tokenDeployer) {
		throw new Error("TOKEN_DEPLOYER_ADDRESS is not set");
	}

	const CurrencyToken = await ethers.getContractFactory("CurrencyToken");
	const currencyTokenImpl = await upgrades.deployImplementation(CurrencyToken, { kind: "uups" });
	const currencyTokenImplAddress = currencyTokenImpl.toString();
	console.log("CurrencyToken implementation deployed to:", currencyTokenImplAddress);

	const Factory = await ethers.getContractFactory("TokenFactory");
	const factory = await upgrades.deployProxy(Factory, [tokenAdmin, tokenDeployer, currencyTokenImplAddress], {
		initializer: "initialize"
	});
	await factory.waitForDeployment();

	console.log("TokenFactory deployed to:", await factory.getAddress());
	console.log("  admin:          ", tokenAdmin);
	console.log("  token deployer: ", tokenDeployer);
	console.log("  token impl:     ", currencyTokenImplAddress);
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
