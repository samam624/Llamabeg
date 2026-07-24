# State Trade and Tax Income

This document records how Llamabeg reads government trade and tax revenue from an EU5
save, why those values can differ from the Economy screen immediately after loading the
same save, and which similarly named save fields must not be substituted for them.

## What the columns mean

The Economy tables use two state-revenue fields:

| Llamabeg column | Save field | Meaning |
| --- | --- | --- |
| State Trade Income (Last Month) | `countries.database.*.last_months_trade_income` | The Crown's completed-month share of merchant-route profit |
| State Tax Income (Last Month) | `countries.database.*.last_months_tax_income` | Taxes paid to the Crown by all estates during the completed month |

These are treasury values for the government. They are not the gross value of all trade,
nor the private income retained by estates.

Current binary saves encode `last_months_trade_income` as fixed token `0x36f8`.
`last_months_tax_income` is fixed token `0x38f6`.

## Why estate trade income is wrong for this metric

`estate_manager.database` contains one income-summary record per country and estate type.
Each summary has a `last_month.trade_income` value, but that value belongs to the estate's
private economy. The same record has its own `gold` and `balance`, separate from the
country treasury.

Summing those estate values therefore measures private estate trade income, not the
Crown's Trade Income line. The Economy tables and automatic recorder must use the
country-level `last_months_trade_income` field instead.

The estate summaries remain useful elsewhere—for example, the modifier optimizer records
their private trade income as `estateTradeIncome`—but that field must stay explicitly
separate from state revenue.

## Why tax income can be read directly

The estate summary's `last_month.paid_taxes` is different from its `trade_income`: it is
the amount that estate actually transferred to the Crown. Consequently:

```text
country.last_months_tax_income
  = sum(estate.last_month.paid_taxes for every estate in that country)
```

The country field is still preferred by Llamabeg. It is canonical, compact, and available
even when the optional estate/location parse is disabled.

On the supplied 1486-02-01 save, every one of the 1,878 countries carrying
`last_months_tax_income` matched its summed estate `paid_taxes` records within floating-point
precision.

## BYZ benchmark

Source save:

```text
autosave_3baa76aa-825a-4655-ae49-02edd3b90a4b.eu5
Date: 1486.2.1
Country: BYZ (country number 203)
```

Save-backed completed-month values:

| Value | Amount |
| --- | ---: |
| State Trade Income | `320.49149` |
| State Tax Income | `371.19028` |
| Private estate `trade_income` sum | `619.00846` |
| Stored Gross Income | `777.27038` |
| Stored Gross Expense | `557.39702` |

The private estate trade sum is almost twice the Crown's state trade revenue and must not
be displayed as government Trade Income.

## Reconciling the live Economy screen

After this save is loaded, EU5 recalculates a current-month projection. The supplied
Economy screenshot showed:

```text
Estate taxes:
  Dynatoi       58.00
  Kleros         0.00
  Astoi        130.81
  Agroikoi     119.48
  Barbaroi       0.00
               ------
               308.29

Other income:
  Minting       65.26
  Trade        306.58
  Selling Food   0.71
  Diplomacy     11.14
  Buildings      3.00
               ------
               386.69

Visible rows: 308.29 + 386.69 = 694.98
Displayed Income total:             695.02
```

The `0.04` difference is caused by summing individually rounded row displays while the
game totals the underlying higher-precision values. Similarly, the displayed
`695.02 - 559.82` differs from the shown `135.19` balance by one cent because the balance
uses unrounded internal values.

The live screen's `306.58` trade and `308.29` tax values are current-month projections
calculated after loading. Those exact projection values do not appear in the country's or
estate manager's serialized save record. Llamabeg therefore shows the authoritative saved
completed-month values and labels their period explicitly; it must not pretend that they
are the post-load projection.

## Data path

1. `js/eu5-fixed-ids.js` resolves binary tokens `0x36f8` and `0x38f6`.
2. `js/clausewitz.js` extracts `lastMonthsTradeIncome` and `lastMonthsTaxIncome` on each
   country.
3. `js/clausewitz-binary.js` uses the same country extractor, keeping text and binary
   parsing aligned.
4. `js/parse-worker.js` returns the compact country records.
5. `js/app.js` maps those fields to `tradeIncome` and `taxIncome`, then renders the
   explicitly labeled last-month columns.
6. `llama-score-automatic-logging-machine/llama-log-machine.js` writes the same
   country-level state values into compact campaign snapshots.

Browser cache versions must be bumped whenever this path changes. Parsed-result schema
versions must also be bumped when a newly required field would be missing from saved
IndexedDB/shared results.

## Regression checks

At minimum, verify:

```powershell
node --check js/app.js
node --check js/clausewitz.js
node --check js/clausewitz-binary.js
node --check js/parse-worker.js
node test/trade-income.js
npm.cmd run build
```

For an end-to-end check, parse the benchmark save with `js/clausewitz-binary.js` and assert:

```text
BYZ lastMonthsTradeIncome = 320.49149
BYZ lastMonthsTaxIncome   = 371.19028
```
