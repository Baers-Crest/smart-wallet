import { ethers } from "hardhat";
import { getDeployer } from "./signers/getDeployer";

async function main() {
	const deployer = await getDeployer();
	const deployerAddress = await deployer.getAddress();

	console.log("Deploying with:", deployerAddress);

	const balance = await deployer.provider!.getBalance(deployerAddress);
	console.log("Balance (ETH):", ethers.formatEther(balance));

	const Factory = await ethers.getContractFactory("SmartWalletFactoryV1");

	// 1️⃣ Build deploy tx
	const deployTx = await Factory.getDeployTransaction();

	// 2️⃣ Estimate gas
	const estimatedGas = await deployer.estimateGas(deployTx);

	// 3️⃣ Add buffer
	const gasLimit = (estimatedGas * 110n) / 100n;

	// 4️⃣ Get EIP-1559 fee data
	const feeData = await deployer.provider!.getFeeData();

	if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
		throw new Error("Unable to fetch gas fee data");
	}

	// 5️⃣ Calculate total ETH required
	const requiredEth = gasLimit * feeData.maxFeePerGas;

	console.log("Estimated gas:", estimatedGas.toString());
	console.log("Gas limit (buffered):", gasLimit.toString());
	console.log("Max fee per gas (gwei):", ethers.formatUnits(feeData.maxFeePerGas, "gwei"));

	console.log("ETH required to deploy:", ethers.formatEther(requiredEth));

	// 6️⃣ Balance check
	if (balance < requiredEth) {
		throw new Error(
			`❌ Insufficient ETH.
Required: ${ethers.formatEther(requiredEth)} ETH
Available: ${ethers.formatEther(balance)} ETH`
		);
	}

	// 7️⃣ Deploy
	const contract = await Factory.deploy({
		gasLimit,
		maxFeePerGas: feeData.maxFeePerGas,
		maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
	});

	await contract.waitForDeployment();

	console.log("✅ Contract deployed at:", await contract.getAddress());
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
