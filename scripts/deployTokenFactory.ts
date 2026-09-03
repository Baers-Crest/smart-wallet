import { ethers, upgrades } from "hardhat";
import { getDeployer } from "./signers/getDeployer";

/**
 * Reads a role address from the environment, failing before anything is
 * deployed. The zero address is rejected here rather than left to the chain:
 * `TokenFactory.initialize` reverts with `ZeroAddress`, but only after the
 * `CurrencyToken` implementation has already been paid for and recorded in the
 * upgrades manifest.
 */
function requireAddress(name: "FACTORY_ADMIN_ADDRESS" | "TOKEN_DEPLOYER_ADDRESS"): string {
	const value = process.env[name];

	if (!value) {
		throw new Error(`${name} is not set`);
	}
	if (!ethers.isAddress(value)) {
		throw new Error(`${name} is not a valid address: ${value}`);
	}
	if (value === ethers.ZeroAddress) {
		throw new Error(`${name} is the zero address — TokenFactory.initialize would revert`);
	}

	return value;
}

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
	const tokenDeployer = requireAddress("TOKEN_DEPLOYER_ADDRESS");
	const admin = requireAddress("FACTORY_ADMIN_ADDRESS");

	const deployer = await getDeployer();
	const deployerAddress = await deployer.getAddress();

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
