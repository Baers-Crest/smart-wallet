import { KMSClient, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import {
	AbstractSigner,
	Provider,
	Signature,
	TransactionRequest,
	TypedDataDomain,
	TypedDataField,
	TypedDataEncoder,
	computeAddress,
	getBytes,
	hashMessage,
	hexlify,
	keccak256,
	recoverAddress,
	resolveProperties,
	Transaction
} from "ethers";

/**
 * An ethers v6 signer whose private key lives in AWS KMS and never leaves it.
 *
 * The key must be an asymmetric KMS key with:
 *   - KeySpec  = ECC_SECG_P256K1  (secp256k1, the curve Ethereum uses)
 *   - KeyUsage = SIGN_VERIFY
 *
 * Credentials come from the standard AWS provider chain, so `aws sso login`
 * plus AWS_PROFILE is all that is needed — nothing secret is read by this code.
 */
export class KmsSigner extends AbstractSigner {
	readonly keyId: string;

	private readonly client: KMSClient;
	private addressCache?: string;

	constructor(keyId: string, provider?: Provider | null, client?: KMSClient) {
		super(provider);
		this.keyId = keyId;
		this.client = client ?? new KMSClient({});
	}

	connect(provider: Provider | null): KmsSigner {
		const signer = new KmsSigner(this.keyId, provider, this.client);

		// The address is a property of the key, not of the provider — carrying it
		// over saves a kms:GetPublicKey call on every reconnect.
		signer.addressCache = this.addressCache;

		return signer;
	}

	/**
	 * Derives the Ethereum address from the KMS public key.
	 *
	 * KMS returns SPKI DER (RFC 5280). The prefix is matched in full rather than
	 * just locating the trailing point: an ECC_NIST_P256 key produces the same
	 * shape (a 65-byte uncompressed point at the end) and would otherwise yield a
	 * plausible-looking address that nothing can ever sign for.
	 */
	async getAddress(): Promise<string> {
		if (this.addressCache) {
			return this.addressCache;
		}

		const { PublicKey } = await this._kmsCall("GetPublicKey", () => this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId })));

		if (!PublicKey) {
			throw new Error(`KMS key ${this.keyId} returned no public key`);
		}

		const der = Buffer.from(PublicKey);
		const prefix = SECP256K1_SPKI_PREFIX;

		if (der.length !== prefix.length + 65 || !der.subarray(0, prefix.length).equals(prefix)) {
			throw new Error(`KMS key ${this.keyId} is not an uncompressed secp256k1 point — check KeySpec is ECC_SECG_P256K1`);
		}

		this.addressCache = computeAddress(hexlify(der.subarray(prefix.length)));

		return this.addressCache;
	}

	async signTransaction(tx: TransactionRequest): Promise<string> {
		// ethers' AbstractSigner.sendTransaction hands us a fully-built
		// Transaction, whose fields are prototype getters rather than own
		// properties — resolveProperties would silently see an empty object and
		// we would sign a transaction with a zero chainId.
		let source: any;

		if (tx instanceof Transaction) {
			source = tx;
		} else {
			source = await resolveProperties(tx);

			// `from` is not part of the serialised payload; verify then drop it.
			if (source.from) {
				const expected = await this.getAddress();

				if (source.from.toString().toLowerCase() !== expected.toLowerCase()) {
					throw new Error(`Transaction 'from' ${source.from} does not match KMS address ${expected}`);
				}

				delete source.from;
			}
		}

		// Copies rather than mutating a caller-owned Transaction.
		const transaction = Transaction.from(source);
		transaction.signature = await this._signDigest(keccak256(transaction.unsignedSerialized));

		return transaction.serialized;
	}

	async signMessage(message: string | Uint8Array): Promise<string> {
		return (await this._signDigest(hashMessage(message))).serialized;
	}

	async signTypedData(
		domain: TypedDataDomain,
		types: Record<string, Array<TypedDataField>>,
		value: Record<string, any>
	): Promise<string> {
		return (await this._signDigest(TypedDataEncoder.hash(domain, types, value))).serialized;
	}

	/**
	 * Runs a KMS call, translating the SDK's opaque errors into something that
	 * names the actual misconfiguration. Without this, the common case — pointing
	 * at a symmetric key — surfaces only as "UnsupportedOperationException:
	 * UnknownError" from deep inside the protocol deserialiser.
	 */
	private async _kmsCall<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error: any) {
			const detail = explainKmsError(operation, this.keyId, error);

			if (!detail) {
				throw error;
			}

			const wrapped = new Error(detail);
			(wrapped as any).cause = error;

			throw wrapped;
		}
	}

	/**
	 * Signs a 32-byte digest and returns a fully-formed ethers Signature.
	 *
	 * Three corrections are needed on top of the raw KMS response:
	 *   1. KMS returns the signature DER-encoded; r and s must be unpacked.
	 *   2. KMS may return a high-s value. Ethereum rejects those (EIP-2), so s
	 *      is folded into the lower half of the curve order when necessary.
	 *   3. KMS does not return a recovery id, so both candidates are tried and
	 *      the one recovering to this key's address is kept.
	 */
	private async _signDigest(digest: string): Promise<Signature> {
		const { Signature: der } = await this._kmsCall("Sign", () =>
			this.client.send(
				new SignCommand({
					KeyId: this.keyId,
					Message: getBytes(digest),
					MessageType: "DIGEST",
					SigningAlgorithm: "ECDSA_SHA_256"
				})
			)
		);

		if (!der) {
			throw new Error(`KMS key ${this.keyId} returned no signature`);
		}

		const { r, s } = decodeDerSignature(Buffer.from(der));
		const address = await this.getAddress();
		const lowS = toHex32(normalizeS(s));

		for (const v of [27, 28]) {
			const candidate = Signature.from({ r: toHex32(r), s: lowS, v });

			if (recoverAddress(digest, candidate).toLowerCase() === address.toLowerCase()) {
				return candidate;
			}
		}

		throw new Error(`KMS signature for key ${this.keyId} does not recover to ${address}`);
	}
}

/** secp256k1 group order. */
const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

/**
 * SPKI (RFC 5480) header KMS emits for an ECC_SECG_P256K1 key:
 * SEQUENCE { SEQUENCE { id-ecPublicKey, secp256k1 }, BIT STRING (0 unused bits) }.
 * The 65-byte uncompressed point follows it, for 88 bytes in total.
 */
const SECP256K1_SPKI_PREFIX = Buffer.from("3056301006072a8648ce3d020106052b8104000a034200", "hex");

/** EIP-2: only the lower half of the order is a canonical signature. */
export function normalizeS(s: bigint): bigint {
	return s > SECP256K1_N / 2n ? SECP256K1_N - s : s;
}

function toHex32(value: bigint): string {
	return "0x" + value.toString(16).padStart(64, "0");
}

/**
 * Minimal DER reader for `SEQUENCE { INTEGER r, INTEGER s }`.
 *
 * Deliberately strict: a malformed response should fail loudly rather than
 * produce a signature that silently authorises the wrong transaction.
 */
export function decodeDerSignature(der: Buffer): { r: bigint; s: bigint } {
	let offset = 0;

	const readLength = (): number => {
		const first = der[offset++];

		if (first < 0x80) {
			return first;
		}

		const byteCount = first & 0x7f;
		let length = 0;

		for (let i = 0; i < byteCount; i++) {
			length = (length << 8) | der[offset++];
		}

		return length;
	};

	if (der[offset++] !== 0x30) {
		throw new Error("KMS signature is not a DER SEQUENCE");
	}

	const sequenceLength = readLength();

	if (offset + sequenceLength !== der.length) {
		throw new Error("KMS signature has trailing bytes after the DER SEQUENCE");
	}

	const readInteger = (): bigint => {
		if (der[offset++] !== 0x02) {
			throw new Error("KMS signature component is not a DER INTEGER");
		}

		const length = readLength();
		const value = der.subarray(offset, offset + length);
		offset += length;

		return BigInt("0x" + value.toString("hex"));
	};

	const r = readInteger();
	const s = readInteger();

	if (offset !== der.length) {
		throw new Error("KMS signature has trailing bytes after r and s");
	}

	return { r, s };
}

/**
 * Maps AWS SDK error names onto the configuration mistake that causes them.
 * Returns undefined for errors we have nothing useful to add to.
 */
export function explainKmsError(operation: string, keyId: string, error: any): string | undefined {
	const name = error?.name ?? error?.__type;
	const describe = `Check with: aws kms describe-key --key-id ${keyId}`;

	// The SDK reports an unresolved region as a plain Error, with no useful name.
	if (/region is missing/i.test(error?.message ?? "")) {
		return (
			`No AWS region resolved for ${operation} on ${keyId}.\n` +
			"Set AWS_REGION, or add `region = <region>` to the profile in ~/.aws/config. " +
			"KMS keys are regional — it must be the region the key was created in."
		);
	}

	switch (name) {
		case "UnsupportedOperationException":
			return (
				`KMS rejected ${operation} for key ${keyId}: this is not an asymmetric signing key.\n` +
				"Ethereum signing needs KeySpec=ECC_SECG_P256K1 and KeyUsage=SIGN_VERIFY. " +
				"A key created without --key-spec is SYMMETRIC_DEFAULT/ENCRYPT_DECRYPT, which cannot sign.\n" +
				"Key specs are immutable, so create a new key:\n" +
				"  aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY\n" +
				describe
			);

		case "NotFoundException":
			return `KMS could not find key ${keyId}. Check the id/alias, the AWS region, and that AWS_PROFILE points at the right account.\n${describe}`;

		case "DisabledException":
			return `KMS key ${keyId} is disabled. Re-enable it, or point AWS_KMS_KEY_ID at an active key.\n${describe}`;

		case "KMSInvalidStateException":
			return `KMS key ${keyId} is not in a usable state (it may be pending deletion or pending import).\n${describe}`;

		case "InvalidKeyUsageException":
			return (
				`KMS rejected ${operation} for key ${keyId}: the key's usage does not permit signing. ` +
				`It must be created with KeyUsage=SIGN_VERIFY.\n${describe}`
			);

		case "AccessDeniedException":
		case "KMSAccessDeniedException":
			return (
				`Access denied calling ${operation} on ${keyId}. The assumed role needs kms:GetPublicKey and kms:Sign ` +
				"on this key, granted via its IAM policy or the KMS key policy.\n" +
				"Confirm which identity you are using with: aws sts get-caller-identity"
			);

		case "ExpiredTokenException":
		case "ExpiredToken":
		case "UnrecognizedClientException":
			return `AWS credentials for ${operation} are expired or invalid. Run: aws sso login --profile ${process.env.AWS_PROFILE ?? "<profile>"}`;

		case "CredentialsProviderError":
			return (
				"No AWS credentials found. Run `aws sso login --profile <profile>` and export AWS_PROFILE, " +
				"or unset DEPLOYER_SIGNER=kms to sign with the local key instead."
			);

		default:
			return undefined;
	}
}
