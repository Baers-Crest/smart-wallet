import { HardhatUserConfig } from "hardhat/config";
import "hardhat-contract-sizer";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const config: HardhatUserConfig = {
	solidity: {
		version: "0.8.28",
		settings: {
			optimizer: {
				enabled: true,
				runs: 200
			}
		}
	},
	defaultNetwork: "hardhat",
	networks: {
		localhost: {
			url: "http://127.0.0.1:8545"
		},
		sepolia: {
			url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
			accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
		},
		mainnet: {
			url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
			accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
		},
		hardhat: {
			forking: {
				url: `https://sepolia.infura.io/v3/${process.env.INFURA_API_KEY}`,
				enabled: process.env.FORK_SEPOLIA === "true"
				// optional explicit block number for deterministic tests
				// blockNumber: process.env.FORK_BLOCK_NUMBER
				//   ? Number(process.env.FORK_BLOCK_NUMBER)
				//   : undefined,
			},
			accounts:
				process.env.PRIVATE_KEY && process.env.PRIVATE_KEY_SIGNER_1 && process.env.PRIVATE_KEY_SIGNER_2 && process.env.PRIVATE_KEY_SIGNER_3
					? [
							{
								privateKey: process.env.PRIVATE_KEY,
								balance: "1000000000000000000000" // 1000 ETH for testing
							},
							{
								privateKey: process.env.PRIVATE_KEY_SIGNER_1,
								balance: "1000000000000000000000" // 1000 ETH for testing
							},
							{
								privateKey: process.env.PRIVATE_KEY_SIGNER_2,
								balance: "1000000000000000000000" // 1000 ETH for testing
							},
							{
								privateKey: process.env.PRIVATE_KEY_SIGNER_3,
								balance: "1000000000000000000000" // 1000 ETH for testing
							}
					  ]
					: undefined
		}
	},
	mocha: {
		timeout: 20000000
	},

	etherscan: {
		apiKey: {
			sepolia: process.env.ETHERSCAN_API_KEY || "",
			mainnet: process.env.ETHERSCAN_API_KEY || ""
		},
		customChains: [
			{
				network: "sepolia",
				chainId: 11155111,
				urls: {
					apiURL: "https://api.etherscan.io/v2/api?chainid=11155111",
					browserURL: "https://sepolia.etherscan.io/"
				}
			},
			{
				network: "mainnet",
				chainId: 1,
				urls: {
					apiURL: "https://api.etherscan.io/v2/api?chainid=1",
					browserURL: "https://etherscan.io/"
				}
			}
		]
	},
	contractSizer: {
		alphaSort: true,
		runOnCompile: true,
		disambiguatePaths: false,
		strict: false
	}
};

export default config;
