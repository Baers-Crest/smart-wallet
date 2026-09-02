# Deploying

Two stacks in this repo have deploy scripts:

| Stack | Contract deployed | Script | npm script |
| --- | --- | --- | --- |
| Token factory | `TokenFactory` (proxied) + `CurrencyToken` implementation | [`scripts/deployTokenFactory.ts`](../scripts/deployTokenFactory.ts) | `deploy:tokenFactory` |
| Wallet factory | `SmartWalletFactoryV1` (not proxied) | [`scripts/deploySmartWalletFactory.ts`](../scripts/deploySmartWalletFactory.ts) | `deploy:smartWalletFactory` |

Both resolve their signer through [`scripts/signers/getDeployer.ts`](../scripts/signers/getDeployer.ts), so the signing modes, the mainnet refusal and the deployer banner below apply to both. They differ in everything else: only the token factory uses the upgrades plugin and writes `.openzeppelin/<network>.json`.

Note the wallet script deploys `SmartWalletFactoryV1` from [`contracts/SmartWalletV1/`](../contracts/SmartWalletV1/), not the newer `SmartWalletFactory` in [`contracts/`](../contracts/). Nothing in `scripts/` deploys the newer one.

Contracts can be signed for deployment in two ways:

| Mode      | `DEPLOYER_SIGNER` | Key lives in             | Use for                  |
| --------- | ----------------- | ------------------------ | ------------------------ |
| Local key | `local` (default) | `PRIVATE_KEY` in `.env`  | localhost, Sepolia, Amoy |
| AWS KMS   | `kms`             | AWS KMS, never leaves it | Mainnet, Polygon         |

The mode is explicit. There is no fallback between them — a mistyped KMS variable fails the deploy rather than quietly signing with a raw key.

Deploying to Ethereum mainnet or Polygon with `local` is refused unless you also set `ALLOW_RAW_KEY_ON_MAINNET=true`. That is a deliberate speed bump, not a security control; the real control is using KMS.

---

## Mode 1 — local private key

For local and testnet work.

```bash
# .env
PRIVATE_KEY=0x<64 hex chars>
INFURA_API_KEY=<key>
TOKEN_DEPLOYER_ADDRESS=0x<address granted DEPLOYER_ROLE>
FACTORY_ADMIN_ADDRESS=0x<address granted DEFAUL_ADMIN_ROLE>
```

```bash
npm run deploy:tokenFactory -- amoy
npm run deploy:smartWalletFactory -- amoy
```

`DEPLOYER_SIGNER` may be omitted; `local` is the default.

---

## Mode 2 — AWS KMS with SSO

The private key is generated inside KMS and cannot be exported. This repo reads no AWS secrets: credentials come from the standard AWS provider chain, so an `aws sso login` session is enough.

### Step 1 — Configure the SSO profile

Once per machine. This writes the profile and logs you in, so there is nothing to hand-edit in `~/.aws/config`:

```bash
aws configure sso --profile kumaapay-dev
```

It opens a browser to authorise the session, then prompts for the account, the role, and a region. Pick the region the KMS key lives in — KMS keys are regional, and a profile pointing at the wrong region fails with `NotFoundException` even though SSO and IAM are fine.

### Step 2 — Log in

Step 1 already left you logged in. Come back to this once the session expires (typically 8–12 hours):

```bash
aws sso login --profile kumaapay-dev
export AWS_PROFILE=kumaapay-dev
```

Verify:

```bash
aws sts get-caller-identity
```

Export `AWS_PROFILE` in every shell you deploy from — the scripts read credentials from the standard AWS provider chain and never from `.env`.

### Step 3 — Set the correct private key ARN

Set the KMS key arn which holds the private key with sign/verify scope.

```bash
AWS_KMS_KEY_ID=<AWS_KMS_KEY_ARN>
```

### Step 4 — Find and fund the address if its not funded

The Ethereum address is derived from the key's public key:

```bash
npm run kms:address -- <network_name>
```

```
KMS key:     alias/smart-wallet-deployer
AWS profile: kumaapay-dev
Address:     0x1234...abcd
```

Send gas to that address before deploying. It is read-only and signs nothing, so it is safe to run any time.

### Step 6 — Deploy

```bash
export AWS_PROFILE=kumaapay-dev
export DEPLOYER_SIGNER=kms
export AWS_KMS_KEY_ID=<AWS_KMS_KEY_ARN>
export TOKEN_DEPLOYER_ADDRESS=0x<address granted DEPLOYER_ROLE>
export FACTORY_ADMIN_ADDRESS=0x<address granted DEFAUL_ADMIN_ROLE>

npm run deploy:tokenFactory -- polygon
```

or, for the wallet factory, which needs no address variables at all:

```bash
npm run deploy:smartWalletFactory -- polygon
```

Both print the signing source, address, chain id and balance before sending anything. Check those before letting it proceed.

`FACTORY_ADMIN_ADDRESS` and `TOKEN_DEPLOYER_ADDRESS` both default to the deployer address, so a KMS deploy that sets neither hands the factory's `DEFAULT_ADMIN_ROLE` and `DEPLOYER_ROLE` to the KMS key. That is usually what you want for the admin and usually _not_ what you want for the deployer role — set `TOKEN_DEPLOYER_ADDRESS` to the hot key that will actually call `deployToken`.

---

## Environment variables

| Variable                   | Mode          | Meaning                                                                                  |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `DEPLOYER_SIGNER`          | both          | `kms` or `local` (default `local`)                                                       |
| `PRIVATE_KEY`              | local         | Raw deployer key                                                                         |
| `AWS_KMS_KEY_ID`           | kms           | Key id, ARN, or `alias/...`                                                              |
| `AWS_PROFILE`              | kms           | SSO profile to use                                                                       |
| `AWS_REGION`               | kms           | Only needed if the profile sets no region                                                |
| `TOKEN_DEPLOYER_ADDRESS`   | token factory | Address granted `DEPLOYER_ROLE`. Defaults to the deployer address                        |
| `FACTORY_ADMIN_ADDRESS`    | token factory | Address granted `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`. Defaults to the deployer address |
| `INFURA_API_KEY`           | both          | RPC access                                                                               |
| `ALLOW_RAW_KEY_ON_MAINNET` | local         | Set `true` to override the mainnet refusal                                               |
| `DOCTOR_TIMEOUT_MS`        | both          | Per-check timeout for `npm run doctor` (default 15000)                                   |

`deploy:smartWalletFactory` reads none of the address variables — the factory takes no constructor arguments and grants no roles. It needs only the signer variables and `INFURA_API_KEY`.

---

## What gets deployed

### `deploy:tokenFactory`

1. **`CurrencyToken` implementation** — the shared logic every token proxy points at, deployed with `upgrades.deployImplementation(..., { kind: "uups" })`. Its constructor calls `_disableInitializers()`, so it holds no state and cannot be initialised directly.
2. **`TokenFactory` proxy** — a transparent proxy over the factory implementation, initialised with `FACTORY_ADMIN_ADDRESS`, `TOKEN_DEPLOYER_ADDRESS`, and the `CurrencyToken` implementation address.

Each token the factory later deploys is its own ERC-1967 (UUPS) proxy, upgradeable only by that token's own owner. See [`contracts/TokenFactory/`](../contracts/TokenFactory/).

### `deploy:smartWalletFactory`

One contract, no implementation step and no proxy: **`SmartWalletFactoryV1`**, deployed directly with no constructor arguments. It is not registered with the upgrades plugin and not upgradeable — replacing it means a new factory address.

Before sending, the script estimates gas, adds a 10% buffer, prices it at the node's current `maxFeePerGas`, and aborts if the deployer's balance cannot cover the worst case. It requires EIP-1559 fee data and does not fall back to a legacy `gasPrice`.

The wallets this factory creates are plain `SmartWalletV1` contracts — CREATE2-deployed from a caller-supplied salt, `Ownable2Step` + `ReentrancyGuard`, **not** proxies and not upgradeable. `createWallet` calls `transferOwnership`, which under `Ownable2Step` only sets a _pending_ owner, so the caller must follow up with `acceptOwnership()` before they control the wallet. See [`contracts/SmartWalletV1/`](../contracts/SmartWalletV1/).

### Both

Record all printed addresses. For the token factory, `.openzeppelin/<network>.json` is written by the upgrades plugin and **must be committed** — without it, future upgrades cannot be validated for storage compatibility. `deployImplementation` is idempotent against that manifest: an unchanged `CurrencyToken` implementation is reused rather than redeployed, so re-running the script does not orphan the previous one. The wallet factory writes no manifest, so re-running it always deploys a second factory.

---

## Verifying on the block explorer

```bash
npm run verify:tokenFactory -- polygon <implementation-address>
```

Pass the address printed as `implementation:`, not the proxy address on the line above it.

For the wallet factory, the `verify:factory` npm script will **not** work — it names `contracts/SmartWalletFactory.sol:SmartWalletFactory`, which is not the contract `deploy:smartWalletFactory` deploys. Verify it directly:

```bash
npx hardhat verify \
  --contract contracts/SmartWalletV1/SmartWalletFactory.sol:SmartWalletFactoryV1 \
  --network polygon <factory-address>
```

It takes no constructor arguments, so none are passed.

---

## Preflight

Before deploying — especially to a new network or from a new machine — run:

```bash
npm run doctor -- polygon
```

It checks each dependency separately, so a failure names the endpoint responsible instead of surfacing an anonymous stack trace:

```
  ✓ Environment        mode=kms, all required variables set
  ✓ Proxy env          no proxy variables set
  ✓ RPC                https://polygon-mainnet.infura.io/v3/<key> — chainId 137, block 93042742 [1350ms]
  ✓ KMS                alias/smart-wallet-deployer -> 0x1234…abcd (profile kumaapay-dev, region eu-west-1) [820ms]
  ✓ Deployer balance   0x1234…abcd holds 2.5 ETH
```

Exits non-zero if anything fails, so it can gate a deploy in CI. The RPC API key is masked, so the output is safe to paste into a ticket. `DOCTOR_TIMEOUT_MS` (default 15000) bounds each check. It checks the signer and the network, which both stacks share, so one run covers either deploy.

---

## Troubleshooting

**`Unable to locate credentials` / `Token has expired`** The SSO session lapsed. Run `aws sso login --profile kumaapay-dev` again, and check `AWS_PROFILE` is exported in the shell you are deploying from.

KMS failures are translated into messages naming the actual misconfiguration, with the original SDK error preserved as `.cause`. If you see a bare SDK error, it is one this repo has no specific guidance for.

**`AccessDeniedException` on `GetPublicKey` or `Sign`** The assumed role lacks the policy from step 4, or the KMS key policy does not grant it. Confirm with `aws sts get-caller-identity` that you are the role you think you are.

**`UnsupportedOperationException` / `this is not an asymmetric signing key`** The key is symmetric. `aws kms create-key` with no `--key-spec` produces a `SYMMETRIC_DEFAULT` / `ENCRYPT_DECRYPT` key, and `GetPublicKey` rejects those. Confirm with:

```bash
aws kms describe-key --key-id "$AWS_KMS_KEY_ID" \
  --query 'KeyMetadata.{KeySpec:KeySpec,KeyUsage:KeyUsage,State:KeyState}'
```

You need `KeySpec=ECC_SECG_P256K1` and `KeyUsage=SIGN_VERIFY`. Key specs are **immutable**, so create a new key with the flags in step 3 and repoint `AWS_KMS_KEY_ID`. If the old key was only ever a mistake, schedule its deletion.

Note this failure is authentication-independent: an HTTP 400 with a request id means SSO and IAM already worked, and only the key type is wrong.

**`is not an uncompressed secp256k1 point — check KeySpec is ECC_SECG_P256K1`** The key is asymmetric but on the wrong curve (most often `ECC_NIST_P256`). Same fix: key specs are immutable, so create a new key.

**`does not recover to <address>`** The signature did not recover to the key's own address. Fails closed and signs nothing. Check that `AWS_KMS_KEY_ID` refers to the key you expect.

**`ConnectTimeoutError` / `UND_ERR_CONNECT_TIMEOUT`** This is _never_ KMS. `undici` is Hardhat's HTTP client; the AWS SDK uses Node's native `https` through `@smithy/node-http-handler`. So a connect timeout is the JSON-RPC endpoint or a block explorer.

A _connect_ timeout means the TCP handshake never completed — a network-path problem, not authentication. Common causes, in order:

1. **A proxy or VPN.** `undici` **ignores `HTTP_PROXY` / `HTTPS_PROXY`**, so Hardhat bypasses the proxy even though `curl` and the AWS CLI honour it. This is the usual explanation for "everything else works but Hardhat times out". Either connect to the network directly, or route Node through the proxy explicitly (for example with `global-agent`/`undici.setGlobalDispatcher`).
2. **A firewall** blocking outbound 443 to the RPC host.
3. **A missing or wrong `INFURA_API_KEY`**, giving a URL ending in `/undefined`.

Isolate it with `npm run doctor -- <network>`, then confirm reachability independently:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "https://polygon-mainnet.infura.io/v3/$INFURA_API_KEY"
```

If `curl` succeeds while the doctor's RPC check times out, it is the proxy issue in cause 1.

**`Region is missing`** No AWS region resolved. KMS keys are regional. Re-run `aws configure sso --profile kumaapay-dev` and give it the region the key was created in, or set `AWS_REGION` for the session.

**`Refusing to deploy to chain 137 with a raw private key`** Intended. Use `DEPLOYER_SIGNER=kms`, or set `ALLOW_RAW_KEY_ON_MAINNET=true` if you genuinely mean to use a raw key.

**Deploy reverts with `InvalidInitialization`** Something tried to initialise an implementation directly instead of through a proxy. Deploy via the script, which uses `upgrades.deployProxy`.

**`Unable to fetch gas fee data`** From `deploy:smartWalletFactory`, on a node that reports no `maxFeePerGas` or `maxPriorityFeePerGas`. It refuses rather than guessing a legacy `gasPrice`.

**`❌ Insufficient ETH.`** Also from `deploy:smartWalletFactory` — the pre-send balance check. It prints the required and available amounts; fund the deployer and re-run. Nothing was sent, so there is nothing to clean up.

---

## How the KMS signer works

[`scripts/signers/KmsSigner.ts`](../scripts/signers/KmsSigner.ts) is an ethers v6 `AbstractSigner`. Three details are not obvious:

1. **Address derivation.** `GetPublicKey` returns SPKI DER; the trailing 65 bytes are the uncompressed point that the address is hashed from.
2. **Low-`s` normalisation.** KMS may return a high-`s` signature. Ethereum rejects those under EIP-2, so `s` is folded into the lower half of the curve order.
3. **Recovery id.** KMS does not return `v`. Both candidates are tried and the one recovering to the key's own address is used; if neither does, signing fails rather than emitting a signature that would authorise the wrong sender.

`test/KmsSigner.test.ts` covers all three against a fake KMS backend that returns real DER — including the high-`s` path — so the logic is exercised without contacting AWS, and ends with a full deployment of this stack.

```bash
npx hardhat test test/KmsSigner.test.ts --network hardhat
```
