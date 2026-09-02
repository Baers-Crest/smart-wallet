import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { GetPublicKeyCommand, SignCommand, KMSClient } from "@aws-sdk/client-kms";
import type { SigningKey } from "ethers";
import { KmsSigner, decodeDerSignature, normalizeS, explainKmsError } from "../scripts/signers/KmsSigner";

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/** DER prefix for an SPKI-wrapped secp256k1 public key (RFC 5480). */
const SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

function derInteger(value: bigint): Buffer {
	let hex = value.toString(16);
	if (hex.length % 2 === 1) hex = "0" + hex;

	let bytes = Buffer.from(hex, "hex");
	// DER integers are signed: a leading high bit needs a 0x00 pad.
	if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0x00]), bytes]);

	return Buffer.concat([Buffer.from([0x02, bytes.length]), bytes]);
}

function derSignature(r: bigint, s: bigint): Buffer {
	const body = Buffer.concat([derInteger(r), derInteger(s)]);

	return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/**
 * Stands in for AWS KMS: holds a local key, answers GetPublicKey with real SPKI
 * DER and Sign with real DER-encoded ECDSA, without ever contacting AWS.
 */
class FakeKms {
	readonly signingKey: SigningKey;
	readonly address: string;

	/** KMS is free to return a non-canonical high-s value; emulate that. */
	forceHighS = false;
	/** Corrupt the response, to prove the decoder fails loudly. */
	corrupt: "none" | "not-sequence" | "trailing" = "none";

	constructor(privateKey: string) {
		this.signingKey = new ethers.SigningKey(privateKey);
		this.address = ethers.computeAddress(this.signingKey.publicKey);
	}

	async send(command: any): Promise<any> {
		if (command instanceof GetPublicKeyCommand) {
			const uncompressed = Buffer.from(this.signingKey.publicKey.slice(2), "hex");

			return { PublicKey: new Uint8Array(Buffer.concat([SPKI_PREFIX, uncompressed])) };
		}

		if (command instanceof SignCommand) {
			const digest = ethers.hexlify(command.input.Message as Uint8Array);
			const signature = this.signingKey.sign(digest);

			let r = BigInt(signature.r);
			let s = BigInt(signature.s);

			if (this.forceHighS) {
				s = SECP256K1_N - s;
			}

			let der = derSignature(r, s);

			if (this.corrupt === "not-sequence") der[0] = 0x31;
			if (this.corrupt === "trailing") der = Buffer.concat([der, Buffer.from([0x00])]);

			return { Signature: new Uint8Array(der) };
		}

		throw new Error("unexpected KMS command");
	}
}

describe("KmsSigner", function () {
	const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

	function makeSigner(fake: FakeKms) {
		return new KmsSigner("alias/test-key", ethers.provider, fake as unknown as KMSClient);
	}

	describe("DER decoding", function () {
		it("round-trips r and s, including values needing a zero pad", async function () {
			const cases: [bigint, bigint][] = [
				[1n, 1n],
				[BigInt("0x80" + "00".repeat(31)), BigInt("0x7f" + "ff".repeat(31))],
				[SECP256K1_N - 1n, SECP256K1_N / 2n]
			];

			for (const [r, s] of cases) {
				expect(decodeDerSignature(derSignature(r, s))).to.deep.equal({ r, s });
			}
		});

		it("rejects malformed responses rather than guessing", async function () {
			expect(() => decodeDerSignature(Buffer.from([0x31, 0x02, 0x02, 0x01, 0x01]))).to.throw("not a DER SEQUENCE");

			expect(() => decodeDerSignature(Buffer.concat([derSignature(1n, 1n), Buffer.from([0x00])]))).to.throw("trailing bytes");
		});
	});

	describe("EIP-2 low-s normalisation", function () {
		it("folds high-s values into the lower half of the curve order", async function () {
			expect(normalizeS(1n)).to.equal(1n);
			expect(normalizeS(SECP256K1_N / 2n)).to.equal(SECP256K1_N / 2n);
			expect(normalizeS(SECP256K1_N - 1n)).to.equal(1n);
			expect(normalizeS(SECP256K1_N / 2n + 1n)).to.equal(SECP256K1_N - (SECP256K1_N / 2n + 1n));
		});
	});

	describe("address derivation", function () {
		it("derives the Ethereum address from the KMS SPKI public key", async function () {
			const fake = new FakeKms(PRIVATE_KEY);

			expect(await makeSigner(fake).getAddress()).to.equal(fake.address);
			expect(fake.address).to.equal(new ethers.Wallet(PRIVATE_KEY).address);
		});

		it("rejects a key that is not an uncompressed secp256k1 point", async function () {
			const badFake = {
				async send() {
					return { PublicKey: new Uint8Array(Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex")) };
				}
			};

			await expect(makeSigner(badFake as unknown as FakeKms).getAddress()).to.be.rejectedWith("ECC_SECG_P256K1");
		});
	});

	for (const highS of [false, true]) {
		describe(`signing (KMS returning ${highS ? "high-s" : "low-s"})`, function () {
			it("produces a message signature that recovers to the KMS address", async function () {
				const fake = new FakeKms(PRIVATE_KEY);
				fake.forceHighS = highS;

				const signature = await makeSigner(fake).signMessage("settlement batch 2026-09-01");

				expect(ethers.verifyMessage("settlement batch 2026-09-01", signature)).to.equal(fake.address);
				expect(BigInt(ethers.Signature.from(signature).s)).to.be.at.most(SECP256K1_N / 2n);
			});

			it("produces typed-data signatures that recover to the KMS address", async function () {
				const fake = new FakeKms(PRIVATE_KEY);
				fake.forceHighS = highS;

				const domain = { name: "CurrencyToken", version: "1", chainId: 137, verifyingContract: fake.address };
				const types = { Payment: [{ name: "reference", type: "string" }] };
				const value = { reference: "INV-1001" };

				const signature = await makeSigner(fake).signTypedData(domain, types, value);

				expect(ethers.verifyTypedData(domain, types, value, signature)).to.equal(fake.address);
			});

			it("produces a transaction that is valid on chain", async function () {
				const fake = new FakeKms(PRIVATE_KEY);
				fake.forceHighS = highS;

				const signer = makeSigner(fake);
				const [funder] = await ethers.getSigners();
				await funder.sendTransaction({ to: fake.address, value: ethers.parseEther("1") });

				const recipient = ethers.Wallet.createRandom().address;
				const tx = await signer.sendTransaction({ to: recipient, value: ethers.parseEther("0.25") });
				await tx.wait();

				expect(tx.from).to.equal(fake.address);
				expect(await ethers.provider.getBalance(recipient)).to.equal(ethers.parseEther("0.25"));
			});
		});
	}

	describe("guards", function () {
		it("refuses to sign a transaction whose 'from' is not the KMS address", async function () {
			const fake = new FakeKms(PRIVATE_KEY);

			await expect(
				makeSigner(fake).signTransaction({ to: fake.address, from: ethers.ZeroAddress, chainId: 31337, nonce: 0, gasLimit: 21000 })
			).to.be.rejectedWith("does not match KMS address");
		});

		it("surfaces a corrupt KMS response instead of signing wrongly", async function () {
			const fake = new FakeKms(PRIVATE_KEY);
			fake.corrupt = "trailing";

			await expect(makeSigner(fake).signMessage("hello")).to.be.rejectedWith("trailing bytes");
		});
	});

	describe("KMS error reporting", function () {
		function failingSigner(name: string) {
			const client = {
				async send() {
					const error: any = new Error("UnknownError");
					error.name = name;
					error.__type = name;
					throw error;
				}
			};

			return new KmsSigner("alias/wrong-key", ethers.provider, client as unknown as KMSClient);
		}

		it("explains a symmetric key instead of surfacing UnknownError", async function () {
			// The real-world failure: `aws kms create-key` with no --key-spec
			// makes a SYMMETRIC_DEFAULT key, and GetPublicKey rejects it.
			await expect(failingSigner("UnsupportedOperationException").getAddress()).to.be.rejectedWith(/not an asymmetric signing key/);

			const message = explainKmsError("GetPublicKey", "alias/wrong-key", { name: "UnsupportedOperationException" })!;

			expect(message).to.contain("ECC_SECG_P256K1");
			expect(message).to.contain("SIGN_VERIFY");
			expect(message).to.contain("immutable");
			expect(message).to.contain("aws kms describe-key");
		});

		it("names the cause for the other common misconfigurations", async function () {
			const cases: [string, RegExp][] = [
				["NotFoundException", /could not find key/],
				["DisabledException", /is disabled/],
				["KMSInvalidStateException", /not in a usable state/],
				["InvalidKeyUsageException", /does not permit signing/],
				["AccessDeniedException", /kms:GetPublicKey and kms:Sign/],
				["ExpiredTokenException", /aws sso login/],
				["CredentialsProviderError", /No AWS credentials found/]
			];

			for (const [name, pattern] of cases) {
				expect(explainKmsError("GetPublicKey", "alias/k", { name }), name).to.match(pattern);
			}
		});

		it("preserves the original error as the cause, and rethrows unknown ones untouched", async function () {
			try {
				await failingSigner("UnsupportedOperationException").getAddress();
				expect.fail("should have thrown");
			} catch (error: any) {
				expect(error.cause.name).to.equal("UnsupportedOperationException");
			}

			expect(explainKmsError("Sign", "alias/k", { name: "ThrottlingException" })).to.be.undefined;

			await expect(failingSigner("ThrottlingException").getAddress()).to.be.rejectedWith("UnknownError");
		});
	});

	describe("deployment", function () {
		it("can deploy and drive a real contract end to end", async function () {
			const fake = new FakeKms(PRIVATE_KEY);
			const signer = makeSigner(fake);

			const [funder] = await ethers.getSigners();
			await funder.sendTransaction({ to: fake.address, value: ethers.parseEther("10") });

			// Deploy the token implementation with the KMS-backed signer.
			const Impl = await ethers.getContractFactory("CurrencyToken", signer);
			const impl = await Impl.deploy();
			await impl.waitForDeployment();

			// And the factory behind its proxy — the implementation disables its own
			// initializers, so it must be deployed the way the real script does.
			const Factory = await ethers.getContractFactory("TokenFactory", signer);
			const factory = await upgrades.deployProxy(Factory, [fake.address, fake.address, await impl.getAddress()], {
				initializer: "initialize"
			});
			await factory.waitForDeployment();

			expect(await factory.hasRole(await factory.DEFAULT_ADMIN_ROLE(), fake.address)).to.be.true;

			// A state-changing call signed by KMS.
			await (await factory.deployToken("KMS Token", "KMS", fake.address, 18, 1_000n)).wait();

			expect(await factory.tokens("KMS")).to.properAddress;
		});
	});
});
