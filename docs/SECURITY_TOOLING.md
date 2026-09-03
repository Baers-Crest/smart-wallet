# Lint & static analysis

| Tool          | Version | Config                 | Fails on                        |
| ------------- | ------- | ---------------------- | ------------------------------- |
| solhint       | 6.x     | `.solhint.json`        | any `error` or `warn`           |
| slither       | 0.11.3  | `slither.config.json`  | any finding (`fail_on: pedantic`) |

Both run in CI on every PR (`.github/workflows/contracts-ci.yml`), alongside
`npm test`. Scope is **`contracts/TokenFactory/` only**; the other contract
trees are not clean against these configs yet.

## Commands

```bash
npm run lint:sol        # solhint
npm run lint:sol:fix    # solhint autofixes
npm run slither         # clean compile, then slither
npm run slither:report  # write slither-report.md (never fails; gitignored)
npm run slither:triage  # interactive triage, writes slither.db.json
npm run security        # lint:sol + slither
```

## Installing slither

Python tool, so it is pinned in `requirements-dev.txt`, not `package.json`:

```bash
pip install -r requirements-dev.txt
# pipx has no -r flag; pass the pin from the same file:
pipx install "$(grep -v '^#' requirements-dev.txt | tr -d '[:space:]')"
```

`slither --version` must match the pin — other versions report a different
finding set and desynchronise CI from local runs.

## Suppressing a finding

Annotate the line with the reason. Do not raise `fail_on`, add to
`detectors_to_exclude`, or turn a solhint rule off.

```solidity
/// @dev Assembly is unavoidable here: ERC-7201 requires binding a struct
///      pointer to a fixed slot, which Solidity has no expression for.
// slither-disable-next-line assembly
function _currencyTokenStorage() private pure returns (CurrencyTokenStorage storage $) {
    // solhint-disable-next-line no-inline-assembly
    assembly {
```

Both tools anchor to the **next source line**, not the enclosing declaration —
hence the solhint comment sitting above `assembly`, not above the function.

For a finding with no annotatable source location, use `npm run slither:triage`
(records it in `slither.db.json`, committed).

## Gotchas

**`npm run slither` must clean-compile first.** `hardhat_ignore_compile: true`
keeps crytic-compile from running `hardhat clean --global` and discarding the
solc cache. The cost is that an incremental `hardhat compile` leaves multiple
`build-info` files and slither analyses all of them, including stale ones. Run
bare `slither .` only if the artifacts are current.

**`include_paths` is a regex, not a glob**, matched after leading/trailing `.`
and `/` are stripped. Both obvious patterns are wrong: `contracts/TokenFactory/`
loses its slash and also matches `TokenFactoryLegacy`, while
`contracts/TokenFactory/\w+\.sol` silently skips subdirectories (`\w` excludes
`/`) — CI stays green while files go unanalysed. Committed pattern is
`contracts/TokenFactory/.+\.sol`. If you change it, verify both ends: a broken
contract in a new subdirectory is reported, and legacy-tree findings are not.

## Config decisions

`.solhint.json` cannot carry comments, so the non-obvious entries:

| Rule                       | Setting                    | Why                                                              |
| -------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `compiler-version`         | `^0.8.28`                  | Matches `hardhat.config.ts`; no undeclarable ranges.             |
| `func-visibility`          | `ignoreConstructors: true` | Constructor visibility is meaningless since 0.7.0.               |
| `no-inline-assembly`       | `warn`                     | ERC-7201 needs it, but new blocks should still surface.          |
| `max-line-length`          | `120`                      | Widest line in tree is 113 (ERC-7201 mapping, cannot wrap).      |
| `immutable-vars-naming`    | no `IMM_` prefix           | Matches OpenZeppelin's plain mixedCase.                          |
| `no-empty-blocks`          | `off`                      | UUPS `_authorizeUpgrade` body is empty by design.                |
| `import-path-check`        | `off`                      | Needs a Foundry-style remapping file this project lacks.         |
| `function-max-lines`       | `off`                      | Batch loops and initializers are intentionally long and linear.  |
| `code-complexity`          | `off`                      | Same.                                                            |
| `named-parameters-mapping` | `off`                      | The nested ERC-7201 replay mapping has no useful param names.    |
| `interface-starts-with-i`  | `off`                      | No interfaces in this tree.                                      |

Slither detectors excluded: `pragma` and `solc-version` (fire on OpenZeppelin's
mixed `^0.8.x` pragmas, which we do not control; our own sources are covered by
solhint's `compiler-version`), and `naming-convention` (solhint's naming rules
are the gate).
