import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { TokenFactory, CurrencyToken } from "../typechain-types/contracts/TokenFactory";

describe("TokenFactory & CurrencyToken", function () {
	async function deployFactory() {
		const [admin, deployer, owner, user1, user2] = await ethers.getSigners();

		const Factory = await ethers.getContractFactory("TokenFactory");
		const factory = (await upgrades.deployProxy(Factory, [admin.address, deployer.address], {
			initializer: "initialize"
		})) as unknown as TokenFactory;

		return {
			factory,
			admin,
			deployer,
			owner,
			user1,
			user2
		};
	}

	async function deployTokenFromFactory() {
		const ctx = await deployFactory();

		const name = "Currency Token";
		const symbol = "CUR";
		const decimals = 18;
		const initialSupply = 1_000_000n * 10n ** 18n;

		await ctx.factory.connect(ctx.deployer).deployToken(name, symbol, ctx.owner.address, decimals, initialSupply);

		const tokenAddress = await ctx.factory.tokens(symbol);
		expect(tokenAddress).to.properAddress;

		const token = (await ethers.getContractAt("CurrencyToken", tokenAddress)) as unknown as CurrencyToken;

		return {
			...ctx,
			token,
			name,
			symbol,
			decimals,
			initialSupply
		};
	}

	describe("TokenFactory deployment", function () {
		it("deploys and initializes correctly", async function () {
			const { factory, admin, deployer } = await deployFactory();

			const DEFAULT_ADMIN_ROLE = await factory.DEFAULT_ADMIN_ROLE();
			const DEPLOYER_ROLE = await factory.DEPLOYER_ROLE();

			expect(await factory.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
			expect(await factory.hasRole(DEPLOYER_ROLE, deployer.address)).to.be.true;
		});

		it("only deployer role can deploy tokens", async function () {
			const { factory, owner, user1 } = await deployFactory();

			const name = "Another Token";
			const symbol = "ANT";
			const decimals = 18;
			const initialSupply = 1_000n;

			await expect(factory.connect(user1).deployToken(name, symbol, owner.address, decimals, initialSupply)).to.be.reverted;
		});

		it("reverts when deploying a token with an already used symbol", async function () {
			const { factory, deployer, owner } = await deployFactory();

			const name = "Duplicate Token";
			const symbol = "DUP";
			const decimals = 18;
			const initialSupply = 1_000n;

			await factory.connect(deployer).deployToken(name, symbol, owner.address, decimals, initialSupply);

			await expect(factory.connect(deployer).deployToken(name, symbol, owner.address, decimals, initialSupply)).to.be.reverted;
		});

		it("cannot be reinitialized", async function () {
			const { factory, admin, deployer } = await deployFactory();

			await expect(factory.initialize(admin.address, deployer.address)).to.be.reverted;
		});
	});

	describe("Deployed CurrencyToken basic ERC20 behaviour", function () {
		it("has correct metadata & initial balances", async function () {
			const { token, name, symbol, decimals, owner, initialSupply } = await deployTokenFromFactory();

			expect(await token.name()).to.equal(name);
			expect(await token.symbol()).to.equal(symbol);
			expect(await token.decimals()).to.equal(decimals);

			expect(await token.totalSupply()).to.equal(initialSupply);
			expect(await token.balanceOf(owner.address)).to.equal(initialSupply);
		});

		it("supports tokens with 6 decimals", async function () {
			const { factory, owner, deployer } = await deployFactory();

			const name = "USDC-like Token";
			const symbol = "USDC6";
			const decimals = 6;
			const initialUnits = 1_000_000n; // 1,000,000 whole tokens
			const initialSupply = initialUnits * 10n ** BigInt(decimals);

			await factory.connect(deployer).deployToken(name, symbol, owner.address, decimals, initialSupply);

			const tokenAddress = await factory.tokens(symbol);
			const token = (await ethers.getContractAt("CurrencyToken", tokenAddress)) as unknown as CurrencyToken;

			expect(await token.decimals()).to.equal(decimals);
			expect(await token.totalSupply()).to.equal(initialSupply);
			expect(await token.balanceOf(owner.address)).to.equal(initialSupply);
		});

		it("supports transfer flow", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 100n * 10n ** 18n;

			await expect(token.connect(owner)["transfer(address,uint256)"](user1.address, amount)).to.changeTokenBalances(token, [owner, user1], [-amount, amount]);
		});

		it("emits TransferSuccess when transferring with reference", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 42n * 10n ** 18n;
			const reference = "Payment for invoice #123";

			await expect(token.connect(owner)["transfer(address,uint256,string)"](owner.address, amount, reference))
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, owner.address, amount, reference);
		});

		it("supports approve and transferFrom flow", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 50n * 10n ** 18n;

			await token.connect(owner).approve(user1.address, amount);

			expect(await token.allowance(owner.address, user1.address)).to.equal(amount);

			await expect(token.connect(user1).transferFrom(owner.address, user2.address, amount)).to.changeTokenBalances(token, [owner, user2], [-amount, amount]);

			expect(await token.allowance(owner.address, user1.address)).to.equal(0n);
		});

		it("reverts transfer when sender has insufficient balance", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 1n * 10n ** 18n;

			await expect(token.connect(user1)["transfer(address,uint256)"](owner.address, amount)).to.be.reverted;
		});

		it("reverts transferFrom when allowance is insufficient", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 1n * 10n ** 18n;

			await expect(token.connect(user1).transferFrom(owner.address, user1.address, amount)).to.be.reverted;
		});

		it("owner can mint and burn", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const mintAmount = 1_000n * 10n ** 18n;
			const burnAmount = 400n * 10n ** 18n;

			const totalSupplyBefore = await token.totalSupply();

			await token.connect(owner).mint(user1.address, mintAmount);

			expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
			expect(await token.totalSupply()).to.equal(totalSupplyBefore + mintAmount);

			await token.connect(owner).burn(user1.address, burnAmount);

			expect(await token.balanceOf(user1.address)).to.equal(mintAmount - burnAmount);
			expect(await token.totalSupply()).to.equal(totalSupplyBefore + mintAmount - burnAmount);
		});

		it("reverts mint and burn when called by non-owner", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 100n * 10n ** 18n;

			await expect(token.connect(user1).mint(owner.address, amount)).to.be.reverted;

			await expect(token.connect(user1).burn(owner.address, amount)).to.be.reverted;
		});
	});

	describe("Permit and transferFrom flow", function () {
		it("uses permit to approve and then transferFrom", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const chainId = (await ethers.provider.getNetwork()).chainId;

			const value = 123n * 10n ** 18n;
			const nonce = await token.nonces(owner.address);
			const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

			const domain = {
				name: await token.name(),
				version: "1",
				chainId,
				verifyingContract: await token.getAddress()
			};

			const types = {
				Permit: [
					{ name: "owner", type: "address" },
					{ name: "spender", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "nonce", type: "uint256" },
					{ name: "deadline", type: "uint256" }
				]
			};

			const message = {
				owner: owner.address,
				spender: user1.address,
				value,
				nonce,
				deadline
			};

			const signature = await owner.signTypedData(domain, types, message);

			const { v, r, s } = ethers.Signature.from(signature);

			await token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s);

			expect(await token.allowance(owner.address, user1.address)).to.equal(value);

			await expect(token.connect(user1).transferFrom(owner.address, user1.address, value)).to.changeTokenBalances(token, [owner, user1], [-value, value]);

			expect(await token.allowance(owner.address, user1.address)).to.equal(0n);
		});

		it("reverts permit with expired deadline", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const chainId = (await ethers.provider.getNetwork()).chainId;

			const value = 10n * 10n ** 18n;
			const nonce = await token.nonces(owner.address);
			const deadline = BigInt(Math.floor(Date.now() / 1000) - 60); // already expired

			const domain = {
				name: await token.name(),
				version: "1",
				chainId,
				verifyingContract: await token.getAddress()
			};

			const types = {
				Permit: [
					{ name: "owner", type: "address" },
					{ name: "spender", type: "address" },
					{ name: "value", type: "uint256" },
					{ name: "nonce", type: "uint256" },
					{ name: "deadline", type: "uint256" }
				]
			};

			const message = {
				owner: owner.address,
				spender: user1.address,
				value,
				nonce,
				deadline
			};

			const signature = await owner.signTypedData(domain, types, message);
			const { v, r, s } = ethers.Signature.from(signature);

			await expect(token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s)).to.be.reverted;
		});
	});
});
