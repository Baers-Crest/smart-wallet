# Deploying

| Stack | Deploys | Script | npm script |
| --- | --- | --- | --- |
| Token factory | `CurrencyToken` implementation + `TokenFactory` behind a transparent proxy | [`scripts/deployTokenFactory.ts`](../scripts/deployTokenFactory.ts) | `deploy:tokenFactory` |
| Wallet factory | `SmartWalletFactoryV1`, unproxied | [`scripts/deploySmartWalletFactory.ts`](../scripts/deploySmartWalletFactory.ts) | `deploy:smartWalletFactory` |

Two read-only helpers support them — neither signs or sends anything:

| Purpose | Script | npm script |
| --- | --- | --- |
| Preflight the deploy configuration | [`scripts/doctor.ts`](../scripts/doctor.ts) | `doctor` |
| Print the address behind `AWS_KMS_KEY_ID` | [`scripts/kmsAddress.ts`](../scripts/kmsAddress.ts) | `kms:address` |

Every script takes the network as an argument: `npm run <script> -- <network>` (`localhost`, `sepolia`, `amoy`, `mainnet`, `polygon`).

The wallet script deploys `SmartWalletFactoryV1` from [`contracts/SmartWalletV1/`](../contracts/SmartWalletV1/), **not** the older `SmartWalletFactory` in [`contracts/`](../contracts/). Nothing in `scripts/` deploys that one.

## Signing modes

Both scripts resolve their signer through [`scripts/signers/getDeployer.ts`](../scripts/signers/getDeployer.ts).

| Mode      | `DEPLOYER_SIGNER` | Key lives in             | Use for                  |
| --------- | ----------------- | ------------------------ | ------------------------ |
| Local key | `local` (default) | `PRIVATE_KEY` in `.env`  | localhost, Sepolia, Amoy |
| AWS KMS   | `kms`             | AWS KMS, never leaves it | Mainnet, Polygon         |

There is no fallback between them: a mistyped KMS variable fails the deploy rather than quietly signing with a raw key. Deploying to chain 1 or 137 with `local` is refused unless `ALLOW_RAW_KEY_ON_MAINNET=true` — a speed bump, not a security control.

Both scripts print the signing source, address, chain id and balance before sending anything.

## Environment variables

| Variable                   | Mode          | Meaning                                       |
| -------------------------- | ------------- | --------------------------------------------- |
| `DEPLOYER_SIGNER`          | both          | `kms` or `local` (default `local`)            |
| `INFURA_API_KEY`           | both          | RPC access                                    |
| `PRIVATE_KEY`              | local         | Raw deployer key                              |
| `ALLOW_RAW_KEY_ON_MAINNET` | local         | `true` to override the mainnet refusal        |
| `AWS_KMS_KEY_ID`           | kms           | Key id, ARN, or `alias/...`                   |
| `AWS_PROFILE`              | kms           | SSO profile to use                            |
| `AWS_REGION`               | kms           | Only if the profile sets no region            |
| `FACTORY_ADMIN_ADDRESS`    | token factory | Granted `DEFAULT_ADMIN_ROLE` + `PAUSER_ROLE`. |
| `TOKEN_DEPLOYER_ADDRESS`   | token factory | Granted `DEPLOYER_ROLE`.                      |
| `ETHERSCAN_API_KEY`        | verifying     | Used by every `verify:*` script               |
| `DOCTOR_TIMEOUT_MS`        | preflight     | Per-check timeout, default `15000`            |

`deploy:smartWalletFactory` reads no address variables — the factory takes no constructor arguments and grants no roles.

Neither address variable defaults to the deployer: `deploy:tokenFactory` throws before deploying anything unless both are set to valid, non-zero addresses, so the roles are always a deliberate choice rather than a side effect of who signed. `FACTORY_ADMIN_ADDRESS` is usually the KMS key itself; point `TOKEN_DEPLOYER_ADDRESS` at the hot key that will actually call `deployToken`. `npm run doctor` reports both before a deploy gets that far.

## Preflight — `npm run doctor`

```bash
npm run doctor -- amoy
```

Checks each dependency a deploy needs separately, so a failure names the thing responsible instead of surfacing mid-deploy. It signs nothing and sends nothing.

| Check | Verifies | On failure |
| --- | --- | --- |
| Environment | `DEPLOYER_SIGNER` is `kms` or `local`, and that mode's required variable is set — `AWS_KMS_KEY_ID` for `kms`, `PRIVATE_KEY` for `local` | Fails. `PRIVATE_KEY` is not required on `localhost`/`hardhat`, where accounts come from the node |
| `AWS_PROFILE` | Only reported when `DEPLOYER_SIGNER=kms` and it is unset | Warns — the rest of the AWS provider chain may still resolve credentials, and the KMS check settles it |
| Token factory roles | `FACTORY_ADMIN_ADDRESS` and `TOKEN_DEPLOYER_ADDRESS` are set, valid addresses, and not the zero address | Warns — needed by `deploy:tokenFactory` only, and `deploy:smartWalletFactory` reads neither |
| KMS | `kms:GetPublicKey` succeeds and an address derives from the key | Fails. Skipped in `local` mode |
| Deployer balance | The signer resolves through `getDeployer` and holds a non-zero balance | Fails. Skipped if Environment or KMS already failed |

```
Preflight — network 'amoy', timeout 15000ms

  ✓ Environment          mode=local, all required variables set
  ! Token factory roles  FACTORY_ADMIN_ADDRESS is not set — needed by deploy:tokenFactory only
  ✓ KMS                  skipped (DEPLOYER_SIGNER=local)
  ✓ Deployer balance     0x1234...abcd holds 102.335807423868975 ETH

All checks passed with 1 warning(s): Token factory roles
```

`✓` passed, `!` warning, `✗` failure. It exits `1` if any check failed and `0` otherwise, so it can gate a deploy in CI; warnings never affect the exit code.

Both network-bound checks are capped by `DOCTOR_TIMEOUT_MS` (default 15s): the KMS check bounds its `kms:GetPublicKey` call and reports the elapsed milliseconds, and the balance check bounds signer resolution, `kms:GetPublicKey` and `eth_getBalance` together, so a node that answers and then stalls cannot hang the preflight. A timeout is recorded as a failure naming the call that hung — raise the value on a slow link rather than reading it as a broken key.

Two things it does not prove:

- **That the balance is sufficient**, only that it is non-zero. `deploy:smartWalletFactory` does the real arithmetic against estimated gas immediately before sending.
- **That the deploy will succeed.** It is a configuration check, not a dry run.

It does, however, catch the mainnet raw-key refusal: the balance check resolves the signer through `getDeployer`, so a chain 1/137 deploy in `local` mode is rejected during preflight rather than at the moment of deploy.

## Mode 1 — local private key

```bash
# .env
PRIVATE_KEY=0x<64 hex chars>
INFURA_API_KEY=<key>
FACTORY_ADMIN_ADDRESS=0x<address>
TOKEN_DEPLOYER_ADDRESS=0x<address>
```

```bash
npm run doctor -- amoy          # preflight; exits 1 if anything is missing
npm run deploy:tokenFactory -- amoy
npm run deploy:smartWalletFactory -- amoy
```

## Mode 2 — AWS KMS with SSO

The key is generated inside KMS and cannot be exported. This repo reads no AWS secrets — credentials come from the standard AWS provider chain, so an `aws sso login` session is enough.

**1. Configure the SSO profile** (once per machine; writes `~/.aws/config` and logs you in):

```bash
aws configure sso --profile blockchain-wallet
```

It prompts for the account, the role, and a region. Give it the region the KMS key lives in — KMS keys are regional, and a wrong region fails with `NotFoundException` even when SSO and IAM are fine.

**2. Log in** (again whenever the session expires, typically 8–12h):

```bash
aws sso login --profile blockchain-wallet
export AWS_PROFILE=blockchain-wallet
aws sts get-caller-identity   # verify
```

`AWS_PROFILE` must be exported in every shell you deploy from; it is never read from `.env`. No code here reads it directly, so any other source in the AWS provider chain (an instance, container or OIDC role in CI) serves just as well — which is why `npm run doctor` treats a missing `AWS_PROFILE` as a warning and lets the KMS check decide whether the credentials it did resolve reach the key.

**3. Point at the key.** It must be `KeySpec=ECC_SECG_P256K1`, `KeyUsage=SIGN_VERIFY`:

```bash
export AWS_KMS_KEY_ID=<key arn or alias>
```

**4. Find and fund the address.** Read-only — it calls `kms:GetPublicKey` and signs nothing:

```bash
npm run kms:address -- polygon
```

```
KMS key:     alias/smart-wallet-deployer
AWS profile: blockchain-wallet
Address:     0x1234...abcd
```

**5. Preflight, then deploy:**

```bash
export DEPLOYER_SIGNER=kms
export FACTORY_ADMIN_ADDRESS=0x<address>
export TOKEN_DEPLOYER_ADDRESS=0x<address>

npm run doctor -- polygon
npm run deploy:tokenFactory -- polygon
npm run deploy:smartWalletFactory -- polygon
```

## What gets deployed

**`deploy:tokenFactory`**

1. **`CurrencyToken` implementation** — the shared logic every token proxy points at, via `upgrades.deployImplementation(..., { kind: "uups" })`. Its constructor calls `_disableInitializers()`.
2. **`TokenFactory` proxy** — a transparent proxy, initialised with the admin, the token deployer, and the `CurrencyToken` implementation address.

Each token the factory later deploys is its own ERC-1967 (UUPS) proxy, upgradeable only by that token's own owner. See [`contracts/TokenFactory/`](../contracts/TokenFactory/).

`.openzeppelin/<network>.json` is written by the upgrades plugin and **must be committed** — without it, future upgrades cannot be validated for storage compatibility. Only chains the plugin recognises get a file named after the network; Amoy is not one, so it lands as `.openzeppelin/unknown-80002.json`, keyed by chain id. `deployImplementation` is idempotent against that manifest, so re-running the script reuses an unchanged implementation rather than orphaning the previous one.

**`deploy:smartWalletFactory`**

One contract, no proxy: `SmartWalletFactoryV1`, no constructor arguments. Not registered with the upgrades plugin and not upgradeable — replacing it means a new address, and re-running the script always deploys a second factory.

Before sending it estimates gas, adds 10%, prices it at the node's `maxFeePerGas`, and aborts if the balance cannot cover the worst case. It requires EIP-1559 fee data and will not fall back to a legacy `gasPrice`.

The wallets it creates are plain `SmartWalletV1` contracts — CREATE2 from a caller-supplied salt, `Ownable2Step` + `ReentrancyGuard`, not proxies and not upgradeable. `createWallet` calls `transferOwnership`, which under `Ownable2Step` only sets a _pending_ owner, so the caller must follow up with `acceptOwnership()`. See [`contracts/SmartWalletV1/`](../contracts/SmartWalletV1/).

Record all printed addresses.

## Verifying

```bash
npm run verify:tokenFactory -- polygon <implementation-address>
```

Pass the address printed as `implementation:`, not the proxy address on the line above it.

The `verify:factory` script does **not** work for the wallet factory — it names `contracts/SmartWalletFactory.sol:SmartWalletFactory`, a different contract. Verify directly (no constructor arguments):

```bash
npx hardhat verify \
  --contract contracts/SmartWalletV1/SmartWalletFactory.sol:SmartWalletFactoryV1 \
  --network polygon <factory-address>
```

## Troubleshooting

Start with `npm run doctor -- <network>`: isolating which dependency is at fault is most of the diagnosis. Everything below is what the resulting failure means.

KMS failures are translated into messages naming the actual misconfiguration, with the SDK error preserved as `.cause`. A bare SDK error is one this repo has no specific guidance for.

**`Token has expired` / `No AWS credentials found`** — the SSO session lapsed. `aws sso login --profile blockchain-wallet`, and check `AWS_PROFILE` is exported in _this_ shell.

**`Region is missing`** — no region resolved. Set `AWS_REGION`, or re-run step 1 with the region the key was created in.

**`AccessDeniedException`** — the assumed role needs `kms:GetPublicKey` and `kms:Sign` on the key, via IAM or the KMS key policy. Confirm your identity with `aws sts get-caller-identity`.

**`this is not an asymmetric signing key`** — the key is symmetric. `aws kms create-key` without `--key-spec` produces `SYMMETRIC_DEFAULT`/`ENCRYPT_DECRYPT`, which cannot sign. This failure is authentication-independent: an HTTP 400 with a request id means SSO and IAM already worked.

**`is not an uncompressed secp256k1 point`** — asymmetric but on the wrong curve (usually `ECC_NIST_P256`).

Both of the above need a new key, since key specs are immutable:

```bash
aws kms describe-key --key-id "$AWS_KMS_KEY_ID" \
  --query 'KeyMetadata.{KeySpec:KeySpec,KeyUsage:KeyUsage,State:KeyState}'
aws kms create-key --key-spec ECC_SECG_P256K1 --key-usage SIGN_VERIFY
```

**`does not recover to <address>`** — the signature did not recover to the key's own address. Fails closed, signs nothing. Check `AWS_KMS_KEY_ID`.

**`unknown DEPLOYER_SIGNER '<value>' — expected 'kms' or 'local'`** — from `doctor`, and from `getDeployer` at deploy time. There is no fallback, so a typo like `kmss` fails rather than quietly signing with the local key.

**`Refusing to deploy to chain 137 with a raw private key`** — intended. Use `DEPLOYER_SIGNER=kms`.

**`Unable to fetch gas fee data`** — from `deploy:smartWalletFactory`, on a node reporting no EIP-1559 fees. It refuses rather than guessing.

**`❌ Insufficient ETH.`** — the pre-send balance check. Nothing was sent; fund the deployer and re-run.

**`InvalidInitialization`** — something tried to initialise an implementation directly instead of through a proxy.

## How the KMS signer works

[`scripts/signers/KmsSigner.ts`](../scripts/signers/KmsSigner.ts) is an ethers v6 `AbstractSigner`. Three details are not obvious:

1. **Address derivation.** `GetPublicKey` returns SPKI DER; the trailing 65 bytes are the uncompressed point the address is hashed from.
2. **Low-`s` normalisation.** KMS may return a high-`s` signature, which Ethereum rejects under EIP-2, so `s` is folded into the lower half of the curve order.
3. **Recovery id.** KMS does not return `v`. Both candidates are tried and the one recovering to the key's own address is kept; if neither does, signing fails rather than emitting a signature authorising the wrong sender.

[`test/KmsSigner.test.ts`](../test/KmsSigner.test.ts) covers all three against a fake KMS returning real DER — including the high-`s` path — and ends with a full deployment of this stack, without contacting AWS.

```bash
npx hardhat test test/KmsSigner.test.ts --network hardhat
```
