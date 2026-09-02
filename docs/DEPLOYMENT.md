# Deploying the TokenFactory stack

Contracts can be signed for deployment in two ways:

| Mode | `DEPLOYER_SIGNER` | Key lives in | Use for |
| --- | --- | --- | --- |
| Local key | `local` (default) | `PRIVATE_KEY` in `.env` | localhost, Sepolia, Amoy |
| AWS KMS | `kms` | AWS KMS, never leaves it | Mainnet, Polygon |

The mode is explicit. There is no fallback between them — a mistyped KMS
variable fails the deploy rather than quietly signing with a raw key.

Deploying to Ethereum mainnet or Polygon with `local` is refused unless you also
set `ALLOW_RAW_KEY_ON_MAINNET=true`. That is a deliberate speed bump, not a
security control; the real control is using KMS.

---

## Mode 1 — local private key

For local and testnet work.

```bash
# .env
PRIVATE_KEY=0x<64 hex chars>
INFURA_API_KEY=<key>
TOKEN_DEPLOYER_ADDRESS=0x<address granted DEPLOYER_ROLE>
```

```bash
npm run deploy:tokenFactory -- amoy
```

`DEPLOYER_SIGNER` may be omitted; `local` is the default.

---

## Mode 2 — AWS KMS with SSO

The private key is generated inside KMS and cannot be exported. This repo reads
no AWS secrets: credentials come from the standard AWS provider chain, so an
`aws sso login` session is enough.

### Step 1 — Configure the SSO profile

Once per machine. Add to `~/.aws/config`:

```ini
[sso-session kumaapay]
sso_start_url = https://<your-org>.awsapps.com/start
sso_region = <region>
sso_registration_scopes = sso:account:access

[profile smart-wallet-deploy]
sso_session = kumaapay
sso_account_id = <account-id>
sso_role_name = <permission-set-name>
region = <region>
```

Or run `aws configure sso` and answer the prompts.

### Step 2 — Log in

Once per session — SSO credentials expire (typically 8–12 hours).

```bash
aws sso login --profile smart-wallet-deploy
export AWS_PROFILE=smart-wallet-deploy
```

Verify:

```bash
aws sts get-caller-identity
```

### Step 3 — Create the signing key

Once per environment. The key spec matters: Ethereum uses secp256k1, and KMS
calls that `ECC_SECG_P256K1`. A key created with any other spec cannot sign
Ethereum transactions.

```bash
aws kms create-key \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --description "smart-wallet contract deployer"

aws kms create-alias \
  --alias-name alias/smart-wallet-deployer \
  --target-key-id <key-id-from-previous-command>
```

Enable automatic key rotation? **No** — rotating the key changes the Ethereum
address, which would orphan the admin role on already-deployed contracts.
Ownership must be migrated on-chain instead, via `transferOwnership` /
`grantRole`.

### Step 4 — Grant the deploying role access to the key

The IAM role assumed through SSO needs exactly two actions. Attach this to the
permission set, or add it to the KMS key policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["kms:GetPublicKey", "kms:Sign"],
      "Resource": "arn:aws:kms:<region>:<account-id>:key/<key-id>"
    }
  ]
}
```

`kms:GetPublicKey` derives the Ethereum address; `kms:Sign` signs transaction
digests. Nothing else is required — in particular the role needs no
`kms:Decrypt` and no export permission.

### Step 5 — Find and fund the address

The Ethereum address is derived from the key's public key:

```bash
export AWS_KMS_KEY_ID=alias/smart-wallet-deployer
npm run kms:address -- polygon
```

```
KMS key:     alias/smart-wallet-deployer
AWS profile: smart-wallet-deploy
Address:     0x1234...abcd
```

Send gas to that address before deploying. It is read-only and signs nothing,
so it is safe to run any time.

### Step 6 — Deploy

```bash
export AWS_PROFILE=smart-wallet-deploy
export DEPLOYER_SIGNER=kms
export AWS_KMS_KEY_ID=alias/smart-wallet-deployer
export TOKEN_DEPLOYER_ADDRESS=0x<address granted DEPLOYER_ROLE>

npm run deploy:tokenFactory -- polygon
```

The script prints the signing source, address, chain id and balance before
sending anything. Check those before letting it proceed.

---

## Environment variables

| Variable | Mode | Meaning |
| --- | --- | --- |
| `DEPLOYER_SIGNER` | both | `kms` or `local` (default `local`) |
| `PRIVATE_KEY` | local | Raw deployer key |
| `AWS_KMS_KEY_ID` | kms | Key id, ARN, or `alias/...` |
| `AWS_PROFILE` | kms | SSO profile to use |
| `TOKEN_DEPLOYER_ADDRESS` | both | Address granted `DEPLOYER_ROLE` on the factory |
| `FACTORY_ADMIN_ADDRESS` | both | Factory admin. Defaults to the deployer address |
| `INFURA_API_KEY` | both | RPC access |
| `ALLOW_RAW_KEY_ON_MAINNET` | local | Set `true` to override the mainnet refusal |

---

## What gets deployed

1. **`CurrencyToken` implementation** — the shared logic every token proxy
   points at. Its constructor calls `_disableInitializers()`, so it holds no
   state and cannot be initialised directly.
2. **`TokenFactory` proxy** — a transparent proxy over the factory
   implementation, initialised with the admin, the token deployer, and the
   `CurrencyToken` implementation address.

Each token the factory later deploys is its own ERC-1967 (UUPS) proxy,
upgradeable only by that token's own owner. See
[`contracts/TokenFactory/`](../contracts/TokenFactory/).

Record all printed addresses. `.openzeppelin/<network>.json` is written by the
upgrades plugin and **must be committed** — without it, future upgrades cannot
be validated for storage compatibility.

---

## Verifying on the block explorer

```bash
npm run verify:tokenFactory -- polygon <implementation-address>
```

Use the *implementation* address printed by the deploy script, not the proxy.

---

## Preflight

Before deploying — especially to a new network or from a new machine — run:

```bash
npm run doctor -- polygon
```

It checks each dependency separately, so a failure names the endpoint
responsible instead of surfacing an anonymous stack trace:

```
  ✓ Environment        mode=kms, all required variables set
  ✓ Proxy env          no proxy variables set
  ✓ RPC                https://polygon-mainnet.infura.io/v3/<key> — chainId 137, block 93042742 [1350ms]
  ✓ KMS                alias/smart-wallet-deployer -> 0x1234…abcd (profile deploy, region eu-west-1) [820ms]
  ✓ Deployer balance   0x1234…abcd holds 2.5 ETH
```

Exits non-zero if anything fails, so it can gate a deploy in CI. The RPC API key
is masked, so the output is safe to paste into a ticket. `DOCTOR_TIMEOUT_MS`
(default 15000) bounds each check.

---

## Troubleshooting

**`Unable to locate credentials` / `Token has expired`**
The SSO session lapsed. Run `aws sso login --profile <profile>` again.

KMS failures are translated into messages naming the actual misconfiguration,
with the original SDK error preserved as `.cause`. If you see a bare SDK error,
it is one this repo has no specific guidance for.

**`AccessDeniedException` on `GetPublicKey` or `Sign`**
The assumed role lacks the policy from step 4, or the KMS key policy does not
grant it. Confirm with `aws sts get-caller-identity` that you are the role you
think you are.

**`UnsupportedOperationException` / `this is not an asymmetric signing key`**
The key is symmetric. `aws kms create-key` with no `--key-spec` produces a
`SYMMETRIC_DEFAULT` / `ENCRYPT_DECRYPT` key, and `GetPublicKey` rejects those.
Confirm with:

```bash
aws kms describe-key --key-id "$AWS_KMS_KEY_ID" \
  --query 'KeyMetadata.{KeySpec:KeySpec,KeyUsage:KeyUsage,State:KeyState}'
```

You need `KeySpec=ECC_SECG_P256K1` and `KeyUsage=SIGN_VERIFY`. Key specs are
**immutable**, so create a new key with the flags in step 3 and repoint
`AWS_KMS_KEY_ID`. If the old key was only ever a mistake, schedule its deletion.

Note this failure is authentication-independent: an HTTP 400 with a request id
means SSO and IAM already worked, and only the key type is wrong.

**`is not an uncompressed secp256k1 point — check KeySpec is ECC_SECG_P256K1`**
The key is asymmetric but on the wrong curve (most often `ECC_NIST_P256`). Same
fix: key specs are immutable, so create a new key.

**`does not recover to <address>`**
The signature did not recover to the key's own address. Fails closed and signs
nothing. Check that `AWS_KMS_KEY_ID` refers to the key you expect.

**`ConnectTimeoutError` / `UND_ERR_CONNECT_TIMEOUT`**
This is *never* KMS. `undici` is Hardhat's HTTP client; the AWS SDK uses Node's
native `https` through `@smithy/node-http-handler`. So a connect timeout is the
JSON-RPC endpoint or a block explorer.

A *connect* timeout means the TCP handshake never completed — a network-path
problem, not authentication. Common causes, in order:

1. **A proxy or VPN.** `undici` **ignores `HTTP_PROXY` / `HTTPS_PROXY`**, so
   Hardhat bypasses the proxy even though `curl` and the AWS CLI honour it. This
   is the usual explanation for "everything else works but Hardhat times out".
   Either connect to the network directly, or route Node through the proxy
   explicitly (for example with `global-agent`/`undici.setGlobalDispatcher`).
2. **A firewall** blocking outbound 443 to the RPC host.
3. **A missing or wrong `INFURA_API_KEY`**, giving a URL ending in `/undefined`.

Isolate it with `npm run doctor -- <network>`, then confirm reachability
independently:

```bash
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "https://polygon-mainnet.infura.io/v3/$INFURA_API_KEY"
```

If `curl` succeeds while the doctor's RPC check times out, it is the proxy issue
in cause 1.

**`Region is missing`**
No AWS region resolved. KMS keys are regional. Set `AWS_REGION`, or add
`region = <region>` to the profile in `~/.aws/config` — it must be the region the
key was created in.

**`Refusing to deploy to chain 137 with a raw private key`**
Intended. Use `DEPLOYER_SIGNER=kms`, or set `ALLOW_RAW_KEY_ON_MAINNET=true` if
you genuinely mean to use a raw key.

**Deploy reverts with `InvalidInitialization`**
Something tried to initialise an implementation directly instead of through a
proxy. Deploy via the script, which uses `upgrades.deployProxy`.

---

## How the KMS signer works

[`scripts/signers/KmsSigner.ts`](../scripts/signers/KmsSigner.ts) is an ethers
v6 `AbstractSigner`. Three details are not obvious:

1. **Address derivation.** `GetPublicKey` returns SPKI DER; the trailing 65
   bytes are the uncompressed point that the address is hashed from.
2. **Low-`s` normalisation.** KMS may return a high-`s` signature. Ethereum
   rejects those under EIP-2, so `s` is folded into the lower half of the curve
   order.
3. **Recovery id.** KMS does not return `v`. Both candidates are tried and the
   one recovering to the key's own address is used; if neither does, signing
   fails rather than emitting a signature that would authorise the wrong sender.

`test/KmsSigner.test.ts` covers all three against a fake KMS backend that
returns real DER — including the high-`s` path — so the logic is exercised
without contacting AWS, and ends with a full deployment of this stack.

```bash
npx hardhat test test/KmsSigner.test.ts --network hardhat
```
