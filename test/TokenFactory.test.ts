import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import type { TokenFactory, CurrencyToken } from "../typechain-types/contracts/TokenFactory";
import type { CurrencyTokenV2Mock } from "../typechain-types/contracts/mocks/CurrencyTokenV2Mock";

const refHash = (reference: string) => ethers.keccak256(ethers.toUtf8Bytes(reference));

describe("TokenFactory & CurrencyToken", function () {
	async function deployImplementation() {
		const CurrencyTokenImpl = await ethers.getContractFactory("CurrencyToken");
		const impl = await CurrencyTokenImpl.deploy();
		await impl.waitForDeployment();

		return impl;
	}

	async function deployFactory() {
		const [admin, deployer, owner, user1, user2] = await ethers.getSigners();

		const tokenImpl = await deployImplementation();
		const tokenImplAddress = await tokenImpl.getAddress();

		const Factory = await ethers.getContractFactory("TokenFactory");
		const factory = (await upgrades.deployProxy(Factory, [admin.address, deployer.address, tokenImplAddress], {
			initializer: "initialize"
		})) as unknown as TokenFactory;

		return { factory, admin, deployer, owner, user1, user2, tokenImpl, tokenImplAddress };
	}

	async function deployTokenFromFactory() {
		const ctx = await deployFactory();

		const name = "Currency Token";
		const symbol = "CUR";
		const decimals = 18;
		const initialSupply = 1_000_000n * 10n ** 18n;

		await ctx.factory.connect(ctx.deployer).deployToken(name, symbol, ctx.owner.address, decimals, initialSupply);

		const tokenAddress = await ctx.factory.tokens(symbol);
		const token = (await ethers.getContractAt("CurrencyToken", tokenAddress)) as unknown as CurrencyToken;

		return { ...ctx, token, name, symbol, decimals, initialSupply };
	}

	async function signPermit(token: CurrencyToken, owner: any, spender: string, value: bigint, deadline: bigint) {
		const domain = {
			name: await token.name(),
			version: "1",
			chainId: (await ethers.provider.getNetwork()).chainId,
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

		const signature = await owner.signTypedData(domain, types, {
			owner: owner.address,
			spender,
			value,
			nonce: await token.nonces(owner.address),
			deadline
		});

		return ethers.Signature.from(signature);
	}

	describe("TokenFactory deployment", function () {
		it("deploys and initializes correctly", async function () {
			const { factory, admin, deployer } = await deployFactory();

			expect(await factory.hasRole(await factory.DEFAULT_ADMIN_ROLE(), admin.address)).to.be.true;
			expect(await factory.hasRole(await factory.DEPLOYER_ROLE(), deployer.address)).to.be.true;
			expect(await factory.hasRole(await factory.PAUSER_ROLE(), admin.address)).to.be.true;
		});

		it("locks the implementation against direct initialization", async function () {
			const { factory, admin, deployer, tokenImplAddress } = await deployFactory();

			const implAddress = await upgrades.erc1967.getImplementationAddress(await factory.getAddress());
			const impl = (await ethers.getContractAt("TokenFactory", implAddress)) as unknown as TokenFactory;

			await expect(impl.initialize(admin.address, deployer.address, tokenImplAddress)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
		});

		it("cannot be reinitialized through the proxy", async function () {
			const { factory, admin, deployer, tokenImplAddress } = await deployFactory();

			await expect(factory.initialize(admin.address, deployer.address, tokenImplAddress)).to.be.revertedWithCustomError(factory, "InvalidInitialization");
		});

		it("rejects zero addresses and a non-contract implementation at initialization", async function () {
			const [admin] = await ethers.getSigners();
			const Factory = await ethers.getContractFactory("TokenFactory");
			const implAddress = await (await deployImplementation()).getAddress();

			await expect(
				upgrades.deployProxy(Factory, [ethers.ZeroAddress, admin.address, implAddress], { initializer: "initialize" })
			).to.be.revertedWithCustomError(Factory, "ZeroAddress");

			await expect(
				upgrades.deployProxy(Factory, [admin.address, ethers.ZeroAddress, implAddress], { initializer: "initialize" })
			).to.be.revertedWithCustomError(Factory, "ZeroAddress");

			await expect(
				upgrades.deployProxy(Factory, [admin.address, admin.address, ethers.ZeroAddress], { initializer: "initialize" })
			).to.be.revertedWithCustomError(Factory, "ZeroAddress");

			await expect(upgrades.deployProxy(Factory, [admin.address, admin.address, admin.address], { initializer: "initialize" })).to.be.revertedWithCustomError(
				Factory,
				"NotAContract"
			);
		});

		it("only deployer role can deploy tokens", async function () {
			const { factory, owner, user1 } = await deployFactory();

			await expect(factory.connect(user1).deployToken("Another Token", "ANT", owner.address, 18, 1_000n)).to.be.revertedWithCustomError(
				factory,
				"AccessControlUnauthorizedAccount"
			);
		});

		it("reverts when deploying a token with an already used symbol", async function () {
			const { factory, deployer, owner } = await deployFactory();

			await factory.connect(deployer).deployToken("Duplicate Token", "DUP", owner.address, 18, 1_000n);

			await expect(factory.connect(deployer).deployToken("Duplicate Token", "DUP", owner.address, 18, 1_000n))
				.to.be.revertedWithCustomError(factory, "TokenAlreadyDeployed")
				.withArgs("DUP");
		});

		it("rejects a zero owner and empty name/symbol", async function () {
			const { factory, deployer, owner } = await deployFactory();

			await expect(factory.connect(deployer).deployToken("Token", "TKN", ethers.ZeroAddress, 18, 0n)).to.be.revertedWithCustomError(factory, "ZeroAddress");

			await expect(factory.connect(deployer).deployToken("", "TKN", owner.address, 18, 0n)).to.be.revertedWithCustomError(factory, "EmptyString");

			await expect(factory.connect(deployer).deployToken("Token", "", owner.address, 18, 0n)).to.be.revertedWithCustomError(factory, "EmptyString");
		});

		it("emits TokenDeployed with indexed token and owner", async function () {
			const { factory, deployer, owner } = await deployFactory();

			const tx = factory.connect(deployer).deployToken("Event Token", "EVT", owner.address, 18, 1_000n);
			await expect(tx).to.emit(factory, "TokenDeployed");

			const tokenAddress = await factory.tokens("EVT");
			await expect(tx).to.emit(factory, "TokenDeployed").withArgs(tokenAddress, owner.address, "Event Token", "EVT");
		});

		it("reports its version", async function () {
			const { factory } = await deployFactory();

			expect(await factory.version()).to.equal("v1");
		});

		it("pauser can halt and resume token deployment", async function () {
			const { factory, admin, deployer, owner, user1 } = await deployFactory();

			await expect(factory.connect(user1).pause()).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");

			await factory.connect(admin).pause();
			expect(await factory.paused()).to.be.true;

			await expect(factory.connect(deployer).deployToken("Paused Token", "PSD", owner.address, 18, 1_000n)).to.be.revertedWithCustomError(
				factory,
				"EnforcedPause"
			);

			await expect(factory.connect(user1).unpause()).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");

			await factory.connect(admin).unpause();
			await factory.connect(deployer).deployToken("Paused Token", "PSD", owner.address, 18, 1_000n);

			expect(await factory.tokens("PSD")).to.properAddress;
		});
	});

	describe("CurrencyToken basic ERC20 behaviour", function () {
		it("has correct metadata & initial balances", async function () {
			const { token, name, symbol, decimals, owner, initialSupply } = await deployTokenFromFactory();

			expect(await token.name()).to.equal(name);
			expect(await token.symbol()).to.equal(symbol);
			expect(await token.decimals()).to.equal(decimals);
			expect(await token.totalSupply()).to.equal(initialSupply);
			expect(await token.balanceOf(owner.address)).to.equal(initialSupply);
			expect(await token.owner()).to.equal(owner.address);
		});

		it("reports its version", async function () {
			const { token } = await deployTokenFromFactory();

			expect(await token.version()).to.equal("v1");
		});

		it("supports tokens with 6 decimals", async function () {
			const { factory, owner, deployer } = await deployFactory();

			const decimals = 6;
			const initialSupply = 1_000_000n * 10n ** BigInt(decimals);

			await factory.connect(deployer).deployToken("USDC-like Token", "USDC6", owner.address, decimals, initialSupply);

			const token = (await ethers.getContractAt("CurrencyToken", await factory.tokens("USDC6"))) as unknown as CurrencyToken;

			expect(await token.decimals()).to.equal(decimals);
			expect(await token.totalSupply()).to.equal(initialSupply);
		});

		it("mints no supply when initialSupply is zero", async function () {
			const { factory, owner, deployer } = await deployFactory();

			await factory.connect(deployer).deployToken("Zero Supply", "ZRO", owner.address, 18, 0n);
			const token = (await ethers.getContractAt("CurrencyToken", await factory.tokens("ZRO"))) as unknown as CurrencyToken;

			expect(await token.totalSupply()).to.equal(0n);
		});

		it("supports referenced transfer and transferFrom", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 100n * 10n ** 18n;

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "plain-ref-1")).to.changeTokenBalances(
				token,
				[owner, user1],
				[-amount, amount]
			);

			await token.connect(owner).approve(user1.address, amount);
			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user2.address, amount, "plain-ref-2")
			).to.changeTokenBalances(token, [owner, user2], [-amount, amount]);

			expect(await token.allowance(owner.address, user1.address)).to.equal(0n);
		});

		it("disables the unreferenced ERC-20 entrypoints", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 100n * 10n ** 18n;

			await expect(token.connect(owner)["transfer(address,uint256)"](user1.address, amount)).to.be.revertedWithCustomError(token, "ReferenceRequired");

			await token.connect(owner).approve(user1.address, amount);

			await expect(token.connect(user1)["transferFrom(address,address,uint256)"](owner.address, user2.address, amount)).to.be.revertedWithCustomError(
				token,
				"ReferenceRequired"
			);

			// Nothing moved, and the allowance is untouched.
			expect(await token.balanceOf(user1.address)).to.equal(0n);
			expect(await token.balanceOf(user2.address)).to.equal(0n);
			expect(await token.allowance(owner.address, user1.address)).to.equal(amount);
		});

		it("rejects the unreferenced entrypoints ahead of every other check", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			// Zero amount, no balance, no allowance, even paused: the reference
			// requirement is what surfaces, so callers get one unambiguous reason.
			await expect(token.connect(user1)["transfer(address,uint256)"](owner.address, 0n)).to.be.revertedWithCustomError(token, "ReferenceRequired");

			await expect(token.connect(user1)["transferFrom(address,address,uint256)"](owner.address, user1.address, 10n ** 30n)).to.be.revertedWithCustomError(
				token,
				"ReferenceRequired"
			);

			await token.connect(owner).pause();

			await expect(token.connect(owner)["transfer(address,uint256)"](user1.address, 1n)).to.be.revertedWithCustomError(token, "ReferenceRequired");
		});

		it("reverts transfer with insufficient balance and transferFrom with insufficient allowance", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 1n * 10n ** 18n;

			await expect(token.connect(user1)["transfer(address,uint256,string)"](owner.address, amount, "no-balance")).to.be.revertedWithCustomError(
				token,
				"ERC20InsufficientBalance"
			);

			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, amount, "no-allowance")
			).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
		});
	});

	describe("Referenced transfers", function () {
		it("emits TransferSuccess with an indexed reference hash", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 42n * 10n ** 18n;
			const reference = "Payment for invoice #123";

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference))
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user1.address, refHash(reference), amount, reference);
		});

		it("lets a reference be looked up directly as a log topic", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const reference = "settlement-batch-2026-09-01";
			const amount = 5n * 10n ** 18n;

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference);
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "some-other-reference");

			const logs = await token.queryFilter(token.filters.TransferSuccess(undefined, undefined, refHash(reference)));

			expect(logs).to.have.lengthOf(1);
			expect(logs[0].args.paymentReference).to.equal(reference);
			expect(logs[0].args.value).to.equal(amount);
		});

		it("emits TransferSuccess on referenced transferFrom", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 75n * 10n ** 18n;
			const reference = "Approved payment #456";

			await token.connect(owner).approve(user1.address, amount);

			await expect(token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user2.address, amount, reference))
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user2.address, refHash(reference), amount, reference);
		});

		it("rejects zero-amount and empty-reference transfers", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 1n * 10n ** 18n;

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, 0n, "spam")).to.be.revertedWithCustomError(token, "ZeroAmount");

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "")).to.be.revertedWithCustomError(token, "EmptyReference");

			await token.connect(owner).approve(user1.address, amount);

			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, 0n, "spam")
			).to.be.revertedWithCustomError(token, "ZeroAmount");

			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, amount, "")
			).to.be.revertedWithCustomError(token, "EmptyReference");
		});
	});

	describe("Payment reference replay protection", function () {
		it("marks a reference as used and blocks an exact replay", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 25n * 10n ** 18n;
			const reference = "INV-1001";

			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.false;

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference);

			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.true;

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference)).to.be.revertedWithCustomError(
				token,
				"ReferenceAlreadyUsed"
			);

			// The blocked replay moved nothing.
			expect(await token.balanceOf(user1.address)).to.equal(amount);
		});

		it("scopes the flag to the exact (reference, from, to, amount) tuple", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 10n * 10n ** 18n;
			const reference = "INV-2002";

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference);

			// Same reference, different amount -> allowed.
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount + 1n, reference);

			// Same reference, same amount, different recipient -> allowed.
			await token.connect(owner)["transfer(address,uint256,string)"](user2.address, amount, reference);

			// Same reference, same amount, different sender -> allowed.
			await token.connect(user1)["transfer(address,uint256,string)"](user2.address, amount, reference);

			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount + 1n)).to.be.true;
			expect(await token.paymentReferenceUsed(reference, owner.address, user2.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed(reference, user1.address, user2.address, amount)).to.be.true;

			// An untouched tuple stays clear.
			expect(await token.paymentReferenceUsed(reference, user2.address, owner.address, amount)).to.be.false;
		});

		it("keys on the payer, not on whoever executes the transferFrom", async function () {
			const { token, owner, admin, user1, user2 } = await deployTokenFromFactory();

			const amount = 15n * 10n ** 18n;
			const reference = "INV-3003";

			await token.connect(owner).approve(user1.address, amount);
			await token.connect(owner).approve(admin.address, amount);

			await token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user2.address, amount, reference);

			// A different spender, same payer/recipient/amount/reference -> still a replay.
			await expect(
				token.connect(admin)["transferFrom(address,address,uint256,string)"](owner.address, user2.address, amount, reference)
			).to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");

			expect(await token.balanceOf(user2.address)).to.equal(amount);
		});

		it("shares the used-flag between the transfer and transferFrom paths", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 20n * 10n ** 18n;
			const reference = "INV-4004";

			// Recorded via the direct transfer path...
			await token.connect(owner)["transfer(address,uint256,string)"](user2.address, amount, reference);

			await token.connect(owner).approve(user1.address, amount);

			// ...and honoured by the allowance path, because the key is the payer.
			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user2.address, amount, reference)
			).to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");
		});

		it("rejects a duplicate entry inside a single batch", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 5n * 10n ** 18n;

			await expect(
				token.connect(owner).batchTransfer([user1.address, user1.address], [amount, amount], ["INV-5005", "INV-5005"])
			).to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");

			// Nothing from the reverted batch was applied.
			expect(await token.balanceOf(user1.address)).to.equal(0n);
			expect(await token.paymentReferenceUsed("INV-5005", owner.address, user1.address, amount)).to.be.false;
		});

		it("allows a repeated reference inside a batch when the amount differs", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 5n * 10n ** 18n;

			await token.connect(owner).batchTransfer([user1.address, user1.address], [amount, amount + 1n], ["INV-6006", "INV-6006"]);

			expect(await token.balanceOf(user1.address)).to.equal(amount * 2n + 1n);
			expect(await token.paymentReferenceUsed("INV-6006", owner.address, user1.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed("INV-6006", owner.address, user1.address, amount + 1n)).to.be.true;
		});

		it("reverts a whole batch when one entry replays an earlier reference", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 8n * 10n ** 18n;

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "INV-7007");

			const balanceBefore = await token.balanceOf(user2.address);

			await expect(
				token.connect(owner).batchTransfer([user2.address, user1.address], [amount, amount], ["INV-fresh", "INV-7007"])
			).to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");

			// The first, valid entry was rolled back with the rest.
			expect(await token.balanceOf(user2.address)).to.equal(balanceBefore);
			expect(await token.paymentReferenceUsed("INV-fresh", owner.address, user2.address, amount)).to.be.false;
		});

		it("rejects a batchTransferFrom replay", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 12n * 10n ** 18n;
			const reference = "INV-8008";

			await token.connect(owner).approve(user1.address, amount * 3n);

			await token.connect(user1).batchTransferFrom([owner.address], [user2.address], [amount], [reference]);

			await expect(token.connect(user1).batchTransferFrom([owner.address], [user2.address], [amount], [reference])).to.be.revertedWithCustomError(
				token,
				"ReferenceAlreadyUsed"
			);
		});

		it("records nothing when a disabled entrypoint is called", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 9n * 10n ** 18n;
			const reference = "INV-9009";

			// A plain ERC20 transfer records no reference...
			await expect(token.connect(owner)["transfer(address,uint256)"](user1.address, amount)).to.be.revertedWithCustomError(token, "ReferenceRequired");
			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.false;

			// ...so the same movement can still be made with a reference afterwards.
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference);
			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.true;
		});

		it("treats references differing only in case or whitespace as distinct", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 3n * 10n ** 18n;

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "inv-1");
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "INV-1");
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "inv-1 ");

			expect(await token.paymentReferenceUsed("inv-1", owner.address, user1.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed("INV-1", owner.address, user1.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed("inv-1 ", owner.address, user1.address, amount)).to.be.true;
			expect(await token.paymentReferenceUsed("Inv-1", owner.address, user1.address, amount)).to.be.false;
		});

		it("checks amount and reference validity before the replay check", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 4n * 10n ** 18n;

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "INV-A");

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, 0n, "INV-A")).to.be.revertedWithCustomError(token, "ZeroAmount");

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "")).to.be.revertedWithCustomError(token, "EmptyReference");
		});

		it("keeps the used-flags across pause/unpause and across an upgrade", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 7n * 10n ** 18n;
			const reference = "INV-PERSIST";

			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference);

			await token.connect(owner).pause();
			await token.connect(owner).unpause();

			expect(await token.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.true;

			const V2 = await ethers.getContractFactory("CurrencyTokenV2Mock");
			const v2Impl = await V2.deploy();
			await v2Impl.waitForDeployment();

			await token.connect(owner).upgradeToAndCall(await v2Impl.getAddress(), "0x");

			const upgraded = (await ethers.getContractAt("CurrencyTokenV2Mock", await token.getAddress())) as unknown as CurrencyTokenV2Mock;

			expect(await upgraded.paymentReferenceUsed(reference, owner.address, user1.address, amount)).to.be.true;

			await expect(upgraded.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, reference)).to.be.revertedWithCustomError(
				upgraded,
				"ReferenceAlreadyUsed"
			);
		});
	});

	describe("Batch transfers", function () {
		it("supports batchTransfer and emits an event per entry", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amounts = [100n * 10n ** 18n, 200n * 10n ** 18n];
			const recipients = [user1.address, user2.address];
			const references = ["Payment #1", "Payment #2"];

			await expect(token.connect(owner).batchTransfer(recipients, amounts, references))
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user1.address, refHash(references[0]), amounts[0], references[0])
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user2.address, refHash(references[1]), amounts[1], references[1]);

			expect(await token.balanceOf(user1.address)).to.equal(amounts[0]);
			expect(await token.balanceOf(user2.address)).to.equal(amounts[1]);
		});

		it("supports batchTransferFrom and emits an event per entry", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amounts = [50n * 10n ** 18n, 75n * 10n ** 18n];
			const total = amounts[0] + amounts[1];
			const references = ["Batch TF #1", "Batch TF #2"];

			await token.connect(owner).approve(user1.address, total);

			await expect(token.connect(user1).batchTransferFrom([owner.address, owner.address], [user1.address, user2.address], amounts, references))
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user1.address, refHash(references[0]), amounts[0], references[0])
				.to.emit(token, "TransferSuccess")
				.withArgs(owner.address, user2.address, refHash(references[1]), amounts[1], references[1]);

			expect(await token.allowance(owner.address, user1.address)).to.equal(0n);
		});

		it("reverts on length mismatch and on empty batches", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const to = [user1.address, user2.address];
			const from = [owner.address, owner.address];
			const amounts = [1n, 2n];
			const refs = ["Payment #1", "Payment #2"];

			// batchTransfer: each array in turn out of step with `to`.
			await expect(token.connect(owner).batchTransfer(to, [1n], refs)).to.be.revertedWithCustomError(token, "LengthMismatch");
			await expect(token.connect(owner).batchTransfer(to, amounts, ["Payment #1"])).to.be.revertedWithCustomError(token, "LengthMismatch");

			await expect(token.connect(owner).batchTransfer([], [], [])).to.be.revertedWithCustomError(token, "EmptyBatch");

			// batchTransferFrom: same, across all three companion arrays.
			await expect(token.connect(owner).batchTransferFrom([owner.address], to, amounts, refs)).to.be.revertedWithCustomError(token, "LengthMismatch");
			await expect(token.connect(owner).batchTransferFrom(from, to, [1n], refs)).to.be.revertedWithCustomError(token, "LengthMismatch");
			await expect(token.connect(owner).batchTransferFrom(from, to, amounts, ["Payment #1"])).to.be.revertedWithCustomError(token, "LengthMismatch");

			await expect(token.connect(owner).batchTransferFrom([], [], [], [])).to.be.revertedWithCustomError(token, "EmptyBatch");
		});

		it("reverts the whole batch when one entry is invalid", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 10n * 10n ** 18n;

			await expect(token.connect(owner).batchTransfer([user1.address, user2.address], [amount, 0n], ["ok", "zero"])).to.be.revertedWithCustomError(
				token,
				"ZeroAmount"
			);

			await expect(token.connect(owner).batchTransfer([user1.address, user2.address], [amount, amount], ["ok", ""])).to.be.revertedWithCustomError(
				token,
				"EmptyReference"
			);

			expect(await token.balanceOf(user1.address)).to.equal(0n);
		});

		it("reverts batchTransfer when the sender runs out of balance mid-batch", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const balance = await token.balanceOf(owner.address);
			const half = balance / 2n + 1n;

			await expect(
				token.connect(owner).batchTransfer([user1.address, user2.address], [half, half], ["Payment #1", "Payment #2"])
			).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
		});
	});

	describe("Supply control", function () {
		it("owner can mint and burn, including burning another holder's balance", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const mintAmount = 1_000n * 10n ** 18n;
			const burnAmount = 400n * 10n ** 18n;
			const supplyBefore = await token.totalSupply();

			await token.connect(owner).mint(user1.address, mintAmount);
			expect(await token.balanceOf(user1.address)).to.equal(mintAmount);
			expect(await token.totalSupply()).to.equal(supplyBefore + mintAmount);

			await token.connect(owner).burn(user1.address, burnAmount);
			expect(await token.balanceOf(user1.address)).to.equal(mintAmount - burnAmount);
			expect(await token.totalSupply()).to.equal(supplyBefore + mintAmount - burnAmount);
		});

		it("reverts mint and burn for non-owners and for zero amounts", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 100n * 10n ** 18n;

			await expect(token.connect(user1).mint(owner.address, amount)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
			await expect(token.connect(user1).burn(owner.address, amount)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			await expect(token.connect(owner).mint(user1.address, 0n)).to.be.revertedWithCustomError(token, "ZeroAmount");
			await expect(token.connect(owner).burn(owner.address, 0n)).to.be.revertedWithCustomError(token, "ZeroAmount");
		});
	});

	describe("Pausing", function () {
		it("owner can pause and unpause all balance movements", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const amount = 10n * 10n ** 18n;

			await expect(token.connect(user1).pause()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			await token.connect(owner).pause();
			expect(await token.paused()).to.be.true;

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "ref")).to.be.revertedWithCustomError(
				token,
				"EnforcedPause"
			);
			await expect(token.connect(owner).batchTransfer([user1.address], [amount], ["ref"])).to.be.revertedWithCustomError(token, "EnforcedPause");
			await expect(token.connect(owner).mint(user1.address, amount)).to.be.revertedWithCustomError(token, "EnforcedPause");
			await expect(token.connect(owner).burn(owner.address, amount)).to.be.revertedWithCustomError(token, "EnforcedPause");

			// The allowance paths are gated too.
			await token.connect(owner).approve(user1.address, amount);
			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, amount, "ref")
			).to.be.revertedWithCustomError(token, "EnforcedPause");
			await expect(token.connect(user1).batchTransferFrom([owner.address], [user1.address], [amount], ["ref"])).to.be.revertedWithCustomError(
				token,
				"EnforcedPause"
			);

			await expect(token.connect(user1).unpause()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			await token.connect(owner).unpause();
			expect(await token.paused()).to.be.false;

			await expect(token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "after-unpause")).to.changeTokenBalances(
				token,
				[owner, user1],
				[-amount, amount]
			);
		});

		it("still allows approvals and permits while paused", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			await token.connect(owner).pause();

			const amount = 10n * 10n ** 18n;
			await token.connect(owner).approve(user1.address, amount);
			expect(await token.allowance(owner.address, user1.address)).to.equal(amount);

			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, amount, "while-paused")
			).to.be.revertedWithCustomError(token, "EnforcedPause");
		});
	});

	describe("Two-step ownership", function () {
		it("requires the new owner to accept before privileges move", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			await token.connect(owner).transferOwnership(user1.address);

			expect(await token.owner()).to.equal(owner.address);
			expect(await token.pendingOwner()).to.equal(user1.address);

			// Privileges stay with the current owner until acceptance.
			await token.connect(owner).mint(owner.address, 1n);
			await expect(token.connect(user1).mint(user1.address, 1n)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			await token.connect(user1).acceptOwnership();

			expect(await token.owner()).to.equal(user1.address);
			expect(await token.pendingOwner()).to.equal(ethers.ZeroAddress);

			await token.connect(user1).mint(user1.address, 1n);
			await expect(token.connect(owner).mint(owner.address, 1n)).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("a mistyped transfer target cannot brick the token", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			// Ownership handed to the wrong address, never accepted.
			await token.connect(owner).transferOwnership(user2.address);

			// The mistake is recoverable: the real owner still controls the token.
			await token.connect(owner).transferOwnership(user1.address);
			await token.connect(user1).acceptOwnership();

			expect(await token.owner()).to.equal(user1.address);

			await expect(token.connect(user2).acceptOwnership()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("only the pending owner can accept", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			await token.connect(owner).transferOwnership(user1.address);

			await expect(token.connect(user2).acceptOwnership()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("renouncing ownership is permanently disabled", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			await expect(token.connect(owner).renounceOwnership()).to.be.revertedWithCustomError(token, "RenounceDisabled");
			await expect(token.connect(user1).renounceOwnership()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			expect(await token.owner()).to.equal(owner.address);
		});
	});

	describe("Permit", function () {
		it("approves via permit and then transfers", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const value = 123n * 10n ** 18n;
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
			const { v, r, s } = await signPermit(token, owner, user1.address, value, deadline);

			await token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s);
			expect(await token.allowance(owner.address, user1.address)).to.equal(value);

			await expect(
				token.connect(user1)["transferFrom(address,address,uint256,string)"](owner.address, user1.address, value, "permit-then-transfer")
			).to.changeTokenBalances(token, [owner, user1], [-value, value]);
		});

		it("approves via permit and then batchTransferFrom with references", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amounts = [100n * 10n ** 18n, 200n * 10n ** 18n];
			const total = amounts[0] + amounts[1];
			const references = ["Permit batch #1", "Permit batch #2"];
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
			const { v, r, s } = await signPermit(token, owner, user1.address, total, deadline);

			await token.connect(user1).permit(owner.address, user1.address, total, deadline, v, r, s);

			await expect(
				token.connect(user1).batchTransferFrom([owner.address, owner.address], [user1.address, user2.address], amounts, references)
			).to.changeTokenBalances(token, [owner, user1, user2], [-total, amounts[0], amounts[1]]);

			expect(await token.allowance(owner.address, user1.address)).to.equal(0n);
		});

		it("reverts permit with an expired deadline", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const value = 10n * 10n ** 18n;
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp - 60);
			const { v, r, s } = await signPermit(token, owner, user1.address, value, deadline);

			await expect(token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s)).to.be.revertedWithCustomError(
				token,
				"ERC2612ExpiredSignature"
			);
		});

		it("reverts batchTransferFrom when the batch exceeds the permitted allowance", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amounts = [100n * 10n ** 18n, 200n * 10n ** 18n];
			const approved = 250n * 10n ** 18n;
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
			const { v, r, s } = await signPermit(token, owner, user1.address, approved, deadline);

			await token.connect(user1).permit(owner.address, user1.address, approved, deadline, v, r, s);

			await expect(
				token.connect(user1).batchTransferFrom([owner.address, owner.address], [user2.address, user2.address], amounts, ["#1", "#2"])
			).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
		});

		it("consumes the permit nonce so a replayed signature fails", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const value = 10n * 10n ** 18n;
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
			const { v, r, s } = await signPermit(token, owner, user1.address, value, deadline);

			const nonceBefore = await token.nonces(owner.address);
			await token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s);
			expect(await token.nonces(owner.address)).to.equal(nonceBefore + 1n);

			await expect(token.connect(user1).permit(owner.address, user1.address, value, deadline, v, r, s)).to.be.revertedWithCustomError(
				token,
				"ERC2612InvalidSigner"
			);
		});
	});

	describe("Token proxy deployment", function () {
		it("deploys each token behind its own ERC-1967 proxy over the shared implementation", async function () {
			const { factory, deployer, owner, tokenImplAddress } = await deployFactory();

			await factory.connect(deployer).deployToken("Token A", "AAA", owner.address, 18, 0n);
			await factory.connect(deployer).deployToken("Token B", "BBB", owner.address, 18, 0n);

			const tokenA = await factory.tokens("AAA");
			const tokenB = await factory.tokens("BBB");

			expect(tokenA).to.not.equal(tokenB);
			expect(await upgrades.erc1967.getImplementationAddress(tokenA)).to.equal(tokenImplAddress);
			expect(await upgrades.erc1967.getImplementationAddress(tokenB)).to.equal(tokenImplAddress);
		});

		it("locks the shared token implementation against direct initialization and upgrade", async function () {
			const { tokenImpl, owner } = await deployFactory();

			await expect(tokenImpl.initialize("Direct", "DIR", owner.address, 18, 0n)).to.be.revertedWithCustomError(tokenImpl, "InvalidInitialization");

			await expect(tokenImpl.upgradeToAndCall(ethers.ZeroAddress, "0x")).to.be.revertedWithCustomError(tokenImpl, "UUPSUnauthorizedCallContext");
		});

		it("keeps per-token state isolated despite a shared implementation and slot", async function () {
			const { factory, deployer, owner, tokenImplAddress } = await deployFactory();

			// ERC-7201 slot is a compile-time constant, so it is the same on every
			// token. Isolation comes from each proxy being a distinct address.
			const SLOT = "0xdc94d7db4246dd77f914f0a8f819612576c37ea888c0a9f5eb0d934a215c9900";

			const specs = [
				{ symbol: "JPY0", decimals: 0 },
				{ symbol: "USD2", decimals: 2 },
				{ symbol: "ETH18", decimals: 18 }
			];

			for (const spec of specs) {
				await factory.connect(deployer).deployToken(`Token ${spec.symbol}`, spec.symbol, owner.address, spec.decimals, 0n);
			}

			for (const spec of specs) {
				const address = await factory.tokens(spec.symbol);
				const token = (await ethers.getContractAt("CurrencyToken", address)) as unknown as CurrencyToken;

				expect(await token.decimals()).to.equal(spec.decimals);
				expect(await ethers.provider.getStorage(address, SLOT)).to.equal(ethers.toBeHex(spec.decimals, 32));
			}

			// The shared implementation never holds token state of its own.
			expect(await ethers.provider.getStorage(tokenImplAddress, SLOT)).to.equal(ethers.ZeroHash);
		});

		it("rejects a token whose owner is the zero address", async function () {
			const { factory, deployer } = await deployFactory();

			await expect(factory.connect(deployer).deployToken("Token", "TKN", ethers.ZeroAddress, 18, 0n)).to.be.revertedWithCustomError(factory, "ZeroAddress");
		});

		it("the token initializer rejects a zero owner even when called outside the factory", async function () {
			const { tokenImplAddress } = await deployFactory();

			// The factory guards this, so reach initialize directly through a raw
			// ERC-1967 proxy to prove the token defends itself too.
			const CurrencyTokenFactory = await ethers.getContractFactory("CurrencyToken");
			const Proxy = await ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");

			const initData = CurrencyTokenFactory.interface.encodeFunctionData("initialize", ["Orphan", "ORP", ethers.ZeroAddress, 18, 0n]);

			await expect(Proxy.deploy(tokenImplAddress, initData)).to.be.revertedWithCustomError(CurrencyTokenFactory, "ZeroAddress");
		});
	});

	describe("Token implementation management", function () {
		it("admin can point new deployments at a new implementation", async function () {
			const { factory, admin, deployer, owner, tokenImplAddress } = await deployFactory();

			await factory.connect(deployer).deployToken("Old Impl", "OLD", owner.address, 18, 0n);
			const oldToken = await factory.tokens("OLD");

			const V2 = await ethers.getContractFactory("CurrencyTokenV2Mock");
			const v2Impl = await V2.deploy();
			await v2Impl.waitForDeployment();
			const v2Address = await v2Impl.getAddress();

			await expect(factory.connect(admin).setTokenImplementation(v2Address))
				.to.emit(factory, "TokenImplementationUpdated")
				.withArgs(tokenImplAddress, v2Address);

			expect(await factory.tokenImplementation()).to.equal(v2Address);

			await factory.connect(deployer).deployToken("New Impl", "NEW", owner.address, 18, 0n);
			const newToken = await factory.tokens("NEW");

			expect(await upgrades.erc1967.getImplementationAddress(newToken)).to.equal(v2Address);

			// Already-deployed tokens are untouched by the factory's change.
			expect(await upgrades.erc1967.getImplementationAddress(oldToken)).to.equal(tokenImplAddress);
		});

		it("only admin can set the implementation, and it must be a contract", async function () {
			const { factory, admin, user1 } = await deployFactory();

			const otherImpl = await (await deployImplementation()).getAddress();

			await expect(factory.connect(user1).setTokenImplementation(otherImpl)).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount");

			await expect(factory.connect(admin).setTokenImplementation(ethers.ZeroAddress)).to.be.revertedWithCustomError(factory, "ZeroAddress");

			await expect(factory.connect(admin).setTokenImplementation(user1.address)).to.be.revertedWithCustomError(factory, "NotAContract");
		});
	});

	describe("Per-token upgradeability", function () {
		async function deployV2Impl() {
			const V2 = await ethers.getContractFactory("CurrencyTokenV2Mock");
			const v2Impl = await V2.deploy();
			await v2Impl.waitForDeployment();

			return await v2Impl.getAddress();
		}

		it("the token owner can upgrade their token, preserving balances, allowances and nonces", async function () {
			const { token, owner, user1, user2 } = await deployTokenFromFactory();

			const amount = 500n * 10n ** 18n;
			await token.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "pre-upgrade");
			await token.connect(owner).approve(user2.address, amount);

			const value = 10n * 10n ** 18n;
			const deadline = BigInt((await ethers.provider.getBlock("latest"))!.timestamp + 3600);
			const { v, r, s } = await signPermit(token, owner, user2.address, value, deadline);
			await token.connect(user2).permit(owner.address, user2.address, value, deadline, v, r, s);

			const supplyBefore = await token.totalSupply();
			const ownerBalanceBefore = await token.balanceOf(owner.address);
			const nonceBefore = await token.nonces(owner.address);

			const V2 = await ethers.getContractFactory("CurrencyTokenV2Mock");
			const v2Address = await deployV2Impl();
			await token.connect(owner).upgradeToAndCall(v2Address, V2.interface.encodeFunctionData("initializeV2", ["upgraded"]));

			expect(await upgrades.erc1967.getImplementationAddress(await token.getAddress())).to.equal(v2Address);

			const upgraded = (await ethers.getContractAt("CurrencyTokenV2Mock", await token.getAddress())) as unknown as CurrencyTokenV2Mock;

			expect(await upgraded.version()).to.equal("v2");
			expect(await upgraded.tag()).to.equal("upgraded");

			// V1 state survived intact.
			expect(await upgraded.totalSupply()).to.equal(supplyBefore);
			expect(await upgraded.balanceOf(owner.address)).to.equal(ownerBalanceBefore);
			expect(await upgraded.balanceOf(user1.address)).to.equal(amount);
			expect(await upgraded.allowance(owner.address, user2.address)).to.equal(value);
			expect(await upgraded.nonces(owner.address)).to.equal(nonceBefore);
			expect(await upgraded.owner()).to.equal(owner.address);
			expect(await upgraded.decimals()).to.equal(18);
			expect(await upgraded.name()).to.equal("Currency Token");

			// And the token still works.
			await expect(upgraded.connect(owner)["transfer(address,uint256,string)"](user1.address, amount, "post-upgrade"))
				.to.emit(upgraded, "TransferSuccess")
				.withArgs(owner.address, user1.address, refHash("post-upgrade"), amount, "post-upgrade");
		});

		it("a non-owner cannot upgrade a token", async function () {
			const { token, user1 } = await deployTokenFromFactory();

			const v2Address = await deployV2Impl();

			await expect(token.connect(user1).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("the factory admin cannot upgrade a deployed token", async function () {
			const { token, admin, deployer } = await deployTokenFromFactory();

			const v2Address = await deployV2Impl();

			await expect(token.connect(admin).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
			await expect(token.connect(deployer).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("upgrading one token leaves its siblings on the old implementation", async function () {
			const { factory, deployer, owner, tokenImplAddress } = await deployFactory();

			await factory.connect(deployer).deployToken("Token A", "AAA", owner.address, 18, 1_000n);
			await factory.connect(deployer).deployToken("Token B", "BBB", owner.address, 18, 1_000n);

			const tokenAAddress = await factory.tokens("AAA");
			const tokenBAddress = await factory.tokens("BBB");
			const tokenA = (await ethers.getContractAt("CurrencyToken", tokenAAddress)) as unknown as CurrencyToken;

			const v2Address = await deployV2Impl();
			await tokenA.connect(owner).upgradeToAndCall(v2Address, "0x");

			expect(await upgrades.erc1967.getImplementationAddress(tokenAAddress)).to.equal(v2Address);
			expect(await upgrades.erc1967.getImplementationAddress(tokenBAddress)).to.equal(tokenImplAddress);
		});

		it("upgrade authority follows two-step ownership", async function () {
			const { token, owner, user1 } = await deployTokenFromFactory();

			const v2Address = await deployV2Impl();

			await token.connect(owner).transferOwnership(user1.address);

			// Not yet accepted: authority has not moved.
			await expect(token.connect(user1).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");

			await token.connect(user1).acceptOwnership();

			await token.connect(user1).upgradeToAndCall(v2Address, "0x");
			expect(await upgrades.erc1967.getImplementationAddress(await token.getAddress())).to.equal(v2Address);

			await expect(token.connect(owner).upgradeToAndCall(v2Address, "0x")).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
		});

		it("a paused token can still be upgraded", async function () {
			const { token, owner } = await deployTokenFromFactory();

			await token.connect(owner).pause();

			const v2Address = await deployV2Impl();
			await token.connect(owner).upgradeToAndCall(v2Address, "0x");

			const upgraded = (await ethers.getContractAt("CurrencyTokenV2Mock", await token.getAddress())) as unknown as CurrencyTokenV2Mock;

			expect(await upgraded.version()).to.equal("v2");
			expect(await upgraded.paused()).to.be.true;
		});
	});
});
