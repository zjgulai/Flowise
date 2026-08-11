# Flowise UI copy baseline ratchet

This contract prevents new static English UI copy debt from entering `packages/ui/src`. It complements, and does not replace, the zero-debt G1 route gate or the compiled component metadata localization validator.

## Scope and evidence

-   Source root: `packages/ui/src`.
-   Included extensions: `.js`, `.jsx`, `.ts`, and `.tsx`.
-   Excluded inputs: `*.test.*` and `*.spec.*` files.
-   Evidence ceiling: local static/fixture evidence (`L2`). A passing receipt does not prove runtime-exhaustive coverage, translation quality, full-product internationalization, or production deployment.
-   The baseline stores module/path, semantic sink, SHA-256 literal identity, occurrence count, and a bounded review reason. It does not store the original copy.

The scanner uses the repository's existing `@typescript-eslint/parser`. It follows statically resolvable JSX text, display properties, notification calls, identifiers, object members, templates, and binary expressions. Chinese content in machine-sensitive fields such as `permissionId`, `path`, `route`, and `data-testid` fails before baseline comparison.

## Normal check

Run with the repository's supported Node and pnpm versions:

```bash
pnpm ui:copy:check
```

The command fails closed when the source tree, parser input, baseline, schema shape, or baseline digest is missing or invalid. An exact match emits a low-sensitivity JSON receipt with `status: "exact"` and exits successfully. New debt, an increased occurrence count, or an equal-count replacement fails; there is no fixed numeric ceiling.

If debt was removed, the scanner detects `ratchet_tightened`. Normal `check` then fails with `BASELINE_TIGHTENING_REQUIRED` so the old allowance cannot silently permit reintroduction.

## Reviewed baseline update

Prefer translating or removing new copy. Updating the baseline is an explicit exception and must include an allowlisted reason plus a traceable uppercase reference:

```bash
node scripts/contracts/ui-copy-baseline.mjs update \
  --reason feature-gap \
  --reference FLOWISE-1234
```

Allowed reasons for added/increased debt are `feature-gap`, `temporary-migration`, and `upstream-compatibility`. Existing unchanged records keep their prior review reason; new or increased records receive the new reason.

After a debt reduction, tighten the baseline explicitly:

```bash
node scripts/contracts/ui-copy-baseline.mjs update \
  --reason debt-reduction \
  --reference FLOWISE-1234
```

`debt-reduction` is rejected if the same update adds or increases any debt. Review the baseline diff, rerun `pnpm ui:copy:check`, and require an `exact` receipt before committing.

The `init` mode exists only to establish the first checked-in baseline. It refuses to overwrite an existing file and must not be used as a routine bypass.

## Required regression evidence

For scanner or classification changes, run:

```bash
node --test scripts/contracts/ui-copy-baseline.test.mjs
pnpm ui:copy:check
pnpm --filter flowise-ui test --runInBand \
  src/routes/g1ChineseCopyGate.test.js \
  src/routes/productionUiContracts.test.js
pnpm metadata:i18n:validate
```

The mutation fixture must remain non-vacuous for JSX text, accessibility labels, placeholders, notifications/dialogs, split/template strings, machine fields, and the non-display case. The test suite must keep the digest-drift, missing/empty input, equal-count replacement, and unknown-classification cases.
