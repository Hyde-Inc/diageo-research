# Local datasets available via duckdb_query

## bls_ces_alcohol (VIEW)
`series_id` (VARCHAR), `dimension_kind` (VARCHAR), `dimension_label` (VARCHAR), `year` (BIGINT), `mean_expenditure_usd` (DOUBLE)

## bls_cpi_alcohol (VIEW)
`series_id` (VARCHAR), `scope` (VARCHAR), `region` (VARCHAR), `year` (BIGINT), `month` (BIGINT), `date` (TIMESTAMP), `cpi_value` (DOUBLE)

## census_retail_4453 (VIEW)
`date` (TIMESTAMP), `year` (INTEGER), `month` (INTEGER), `series_id` (VARCHAR), `adjustment` (VARCHAR), `retail_sales_millions` (BIGINT)

## fred_macro (VIEW)
`date` (TIMESTAMP), `year` (INTEGER), `month` (INTEGER), `series_id` (VARCHAR), `series_name` (VARCHAR), `description` (VARCHAR), `value` (DOUBLE)

## statcan_alcohol (VIEW)
`ref_date` (VARCHAR), `geo` (VARCHAR), `dguid` (VARCHAR), `type_of_sales` (VARCHAR), `type_of_beverage` (VARCHAR), `value,_volume_and_absolute_volume` (VARCHAR), `uom` (VARCHAR), `uom_id` (BIGINT), `scalar_factor` (VARCHAR), `scalar_id` (BIGINT), `vector` (VARCHAR), `coordinate` (VARCHAR), `value` (DOUBLE), `status` (DOUBLE), `symbol` (DOUBLE), `terminated` (DOUBLE), `decimals` (BIGINT), `year` (BIGINT)

## ttb_beer_annual (VIEW)
`year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (BIGINT), `value` (BIGINT), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## ttb_beer_monthly (VIEW)
`cy_month_number` (BIGINT), `year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (BIGINT), `value` (BIGINT), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## ttb_spirits_monthly (VIEW)
`cy_month_number` (BIGINT), `year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (DOUBLE), `value` (DOUBLE), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## ttb_spirits_yearly (VIEW)
`year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (DOUBLE), `value` (DOUBLE), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## ttb_wine_monthly (VIEW)
`cy_month_number` (BIGINT), `year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (DOUBLE), `value` (DOUBLE), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## ttb_wine_yearly (VIEW)
`year` (BIGINT), `statistical_group` (VARCHAR), `statistical_category` (VARCHAR), `statistical_detail` (VARCHAR), `count_ims` (DOUBLE), `value` (DOUBLE), `commodity` (VARCHAR), `stat_redaction` (BOOLEAN), `source_url` (VARCHAR)

## Strategy analytics macros (use these instead of hand-rolling math)
- `yoy_pct(curr_value, prev_value) -> DOUBLE` — Year-over-year percent change. Returns NULL if prev_value is 0 or NULL.
- `cumulative_pct(end_value, start_value) -> DOUBLE` — Cumulative percent change between two snapshots, e.g. 2024 vs 2021.
- `real_growth(nominal_pct, deflator_pct) -> DOUBLE` — Approx. real growth given nominal growth % and deflator (e.g. CPI) %. Uses (1+nom)/(1+def) - 1 with percent inputs.
- `elasticity_estimate(volume_pct_change, price_pct_change) -> DOUBLE` — Simple own-price elasticity estimate = pct volume change / pct price change. Returns NULL if price change is 0.

Example: `SELECT cumulative_pct(290.8, 262.8) AS spirits_cpi_2021_to_2024;`