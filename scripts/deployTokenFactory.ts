import { ethers, upgrades } from "hardhat";
import { getDeployer } from "./signers/getDeployer";

/**
 * Deploys the TokenFactory stack:
 *   1. the shared CurrencyToken implementation that new token proxies point at;
 *   2. the TokenFactory itself, behind a transparent proxy.
 *
 * Every token the factory deploys is its own ERC-1967 (UUPS) proxy over the
 * implementation from step 1, upgradeable by that token's own owner.
 *
 * Signing is selected with DEPLOYER_SIGNER (`kms` or `local`) — see
 * docs/DEPLOYMENT.md.
 */
async function main() {
	const deployer = await getDeployer();
	const deployerAddress = await deployer.getAddress();

	const tokenAdmin = process.env.TOKEN_ADMIN_ADDRESS ?? deployerAddress;
	if (!tokenAdmin) {
		throw new Error("TOKEN_ADMIN_ADDRESS is not set");
	}
	if (!ethers.isAddress(tokenAdmin)) {
		throw new Error(`TOKEN_ADMIN_ADDRESS is not a valid address: ${tokenAdmin}`);
	}

	const tokenDeployer = process.env.TOKEN_DEPLOYER_ADDRESS ?? deployerAddress;
	if (!tokenDeployer) {
		throw new Error("TOKEN_DEPLOYER_ADDRESS is not set");
	}
	if (!ethers.isAddress(tokenDeployer)) {
		throw new Error(`TOKEN_DEPLOYER_ADDRESS is not a valid address: ${tokenDeployer}`);
	}

	// Defaults to the deployer, which is the KMS admin key in a KMS deploy.
	const admin = process.env.FACTORY_ADMIN_ADDRESS ?? deployerAddress;
	if (!ethers.isAddress(admin)) {
		throw new Error(`FACTORY_ADMIN_ADDRESS is not a valid address: ${admin}`);
	}

	const CurrencyToken = await ethers.getContractFactory("CurrencyToken", deployer);
	const currencyTokenImpl = await upgrades.deployImplementation(CurrencyToken, { kind: "uups" });
	const currencyTokenImplAddress = currencyTokenImpl.toString();
	console.log("CurrencyToken implementation deployed to:", currencyTokenImplAddress);

	const Factory = await ethers.getContractFactory("TokenFactory", deployer);
	const factory = await upgrades.deployProxy(Factory, [admin, tokenDeployer, currencyTokenImplAddress], {
		initializer: "initialize"
	});
	await factory.waitForDeployment();

	const factoryAddress = await factory.getAddress();

	console.log("TokenFactory deployed to:", factoryAddress);
	console.log("  implementation: ", await upgrades.erc1967.getImplementationAddress(factoryAddress));
	console.log("  admin:          ", admin);
	console.log("  token deployer: ", tokenDeployer);
	console.log("  token impl:     ", currencyTokenImplAddress);
	console.log("  deployed by:    ", deployerAddress);
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
