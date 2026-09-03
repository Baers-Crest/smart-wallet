# Lint & static analysis

Two tools gate the contracts:

| Tool                                        | Config               | Gate                                              |
| ------------------------------------------- | -------------------- | ------------------------------------------------- |
| [solhint](https://protofire.github.io/solhint/) 6.x | `.solhint.json`      | `--max-warnings 0` — **any** `error` *or* `warn`   |
| [slither](https://github.com/crytic/slither) 0.11.x | `slither.config.json`| `fail_on: pedantic` — **any** finding             |

Both run in CI (`.github/workflows/contracts-ci.yml`) on every pull request.

## Scope

**Only `contracts/TokenFactory/**` is checked today.** Both configs are scoped:

- solhint via the glob in the `lint:sol` script;
- slither via `include_paths` in `slither.config.json`.

`contracts/SmartWallet*.sol`, `contracts/SmartWalletV1/`, `contracts/TokenFactoryLegacy/`
and `contracts/mocks/` are **not** clean against these configs yet. Bring a tree
up to the config and then widen the scope — do not relax a rule to make another
tree pass.

Note on the slither regex: `include_paths` is `re.search`-ed against the resolved
source path *after* leading/trailing `.` and `/` are stripped, so a plain
`contracts/TokenFactory/` would also match `contracts/TokenFactoryLegacy/`. The
pattern is `contracts/TokenFactory/\w+\.sol` for that reason.

## Commands

```bash
npm run lint:sol        # solhint report; exits non-zero on any `error`
npm run lint:sol:fix    # apply solhint's autofixes
npm run slither         # clean compile, then slither; exits non-zero on any finding
npm run slither:report  # write slither-report.md (never fails; gitignored)
npm run slither:triage  # interactive triage, writes slither.db.json
npm run security        # solhint + slither
```

### Installing slither

slither is a Python tool, so it is not in `package.json`. Pinned in
`requirements-dev.txt`:

```bash
pipx install -r requirements-dev.txt   # or: pip install -r requirements-dev.txt
```

`slither --version` must print the pinned version; a different version can
report a different finding set and desynchronise CI from local runs.

### Why `npm run slither` cleans first

`slither.config.json` sets `hardhat_ignore_compile: true` so slither reads
Hardhat's existing artifacts rather than driving its own build (crytic-compile
otherwise runs `hardhat clean --global`, which discards the downloaded solc
cache on every run). The trade-off is that an *incremental* `hardhat compile`
can leave several `build-info` files behind, and slither analyses all of them —
including stale ones, producing findings against source that no longer exists.
`npm run slither` therefore goes through `compile:clean` (`hardhat clean &&
hardhat compile`) so exactly one `build-info` is present. Run `slither .`
directly only if you know the artifacts are current.

## Severity policy (solhint)

The `TokenFactory` tree is at **zero warnings and zero errors**, so `lint:sol`
runs with `--max-warnings 0` and the distinction below is about *intent*, not
about what gates: both severities fail the build.

- **`error` marks a defect** — a security or correctness rule, or a naming
  convention this tree conforms to.
- **`warn` marks a smell** — gas and NatSpec rules. They gate only because the
  tree is already clean; keeping them at zero is cheaper than paying down a
  backlog later. If you need to land a change that trips one, fix the warning
  rather than raising the threshold.
- **`off` is a deliberate deviation.** Each one is listed below with its reason,
  since `.solhint.json` cannot carry comments.

A rule that fires somewhere it genuinely should not gets a
`// solhint-disable-next-line <rule>` comment at that line with a `@dev` note
giving the reason — the same convention as slither below. Note that solhint
anchors the comment to the *next source line*, not to the enclosing
declaration, so for `no-inline-assembly` it goes directly above the `assembly`
block rather than above the function.

### Rules turned off, and why

| Rule                        | Reason                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `no-empty-blocks`           | UUPS `_authorizeUpgrade` has an empty body by design; the access check lives entirely in the `onlyOwner` modifier. |
| `interface-starts-with-i`   | No interfaces in this tree yet.                                                                              |
| `import-path-check`         | Resolves `[~dependenciesPath]` against a Foundry-style remapping file this project does not have.            |
| `function-max-lines`        | The batch-transfer loops and initializers are intentionally long and linear.                                 |
| `code-complexity`           | Same.                                                                                                        |
| `named-parameters-mapping`  | The nested ERC-7201 replay mapping has no useful parameter names.                                            |

### Rules deliberately re-tuned

- `compiler-version` is pinned to `^0.8.28`, matching `hardhat.config.ts`, so a
  contract can never declare a range the toolchain does not actually build.
- `func-visibility` uses `ignoreConstructors: true` — constructor visibility has
  been meaningless since 0.7.0, and the rule would otherwise flag every
  `_disableInitializers()` constructor.
- `immutable-vars-naming` uses `immutablesAsConstants: false` and
  `var-name-mixedcase` drops the recommended `IMM_` prefix, matching
  OpenZeppelin's plain mixedCase convention.
- `no-inline-assembly` is `warn`, not `off`: ERC-7201 namespaced storage
  genuinely needs `assembly { $.slot := ... }`, but a *new* assembly block should
  still show up in the report.
- `max-line-length` is 120. The widest line in the tree is 113 — the ERC-7201
  nested mapping declaration, which cannot be wrapped readably.

## Suppressing a slither finding

`fail_on: pedantic` means every new finding fails CI. Two legitimate ways out:

1. **Inline, preferred** — a `// slither-disable-next-line <detector>` comment
   directly above the reported element, always with a `@dev` note giving the
   reason. The one in the tree today:

   ```solidity
   /// @dev Assembly is unavoidable here: ERC-7201 requires binding a struct
   ///      pointer to a fixed slot, which Solidity has no expression for.
   // slither-disable-next-line assembly
   function _currencyTokenStorage() private pure returns (CurrencyTokenStorage storage $) {
   ```

2. **Triage database** — `npm run slither:triage` records reviewed findings in
   `slither.db.json` (committed). Use this only for findings that cannot be
   annotated at a source location.

Do not raise `fail_on` or add to `detectors_to_exclude` to clear a finding.

### Detectors excluded globally

- `pragma` and `solc-version` — both fire on the OpenZeppelin dependency tree's
  mixed `^0.8.x` pragmas, which this repo does not control. The compiler version
  is pinned in `hardhat.config.ts` and enforced on our own sources by solhint's
  `compiler-version` rule instead.
- `naming-convention` — overlaps solhint's naming rules, which are the gate.
