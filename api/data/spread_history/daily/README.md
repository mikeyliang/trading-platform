# Daily index history

Downloaded 2026-11-08. Values kept as published by each source; only dates were normalized to YYYY-MM-DD and column names to Date/Open/High/Low/Close.
VVIX and SKEW (Cboe) and FRED series are close-only. FRED marks holidays with an empty Close.
Cboe VIX, FRED VIXCLS and Yahoo ^VIX closes matched on 5 random spot-check dates.
Yahoo ^RVX returned no data (use cboe_RVX.csv or fred_RVXCLS.csv).

| File | Source | Rows | First | Last |
|---|---|---|---|---|
| cboe_RVX.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/RVX_History.csv | 4308 | 2009-09-16 | 2026-11-06 |
| cboe_SKEW.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/SKEW_History.csv | 9265 | 1990-01-02 | 2026-11-06 |
| cboe_VIX.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv | 9311 | 1990-01-02 | 2026-11-06 |
| cboe_VIX3M.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX3M_History.csv | 4311 | 2009-09-18 | 2026-11-06 |
| cboe_VIX9D.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX9D_History.csv | 3985 | 2011-01-04 | 2026-11-06 |
| cboe_VVIX.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VVIX_History.csv | 5142 | 2006-03-06 | 2026-11-06 |
| fred_RVXCLS.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=RVXCLS | 5960 | 2004-01-02 | 2026-11-05 |
| fred_VIXCLS.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS | 9613 | 1990-01-02 | 2026-11-05 |
| yahoo_GSPC.csv | yfinance ticker ^GSPC (start 2000-01-01, auto_adjust=False) | 6753 | 2000-01-03 | 2026-11-06 |
| yahoo_RUT.csv | yfinance ticker ^RUT (start 2000-01-01, auto_adjust=False) | 6753 | 2000-01-03 | 2026-11-06 |
| yahoo_VIX.csv | yfinance ticker ^VIX (start 2000-01-01, auto_adjust=False) | 6755 | 2000-01-03 | 2026-11-06 |
| yahoo_VIX3M.csv | yfinance ticker ^VIX3M (start 2000-01-01, auto_adjust=False) | 5111 | 2006-07-17 | 2026-11-06 |

## Fear-gauge and credit history (added 2026-11-09)

Date/Close per observation (blank and '.' values dropped); AAII is Date,Bullish,Neutral,Bearish; Yahoo files are OHLC.
Notes: FRED only serves the last 3 years of the ICE BofA spreads (BAMLH0A0HYM2, BAMLC0A4CBBB) because of licensing. Cboe's put/call files stop on 2019-10-04. STLFSI4, NFCI and ANFCI are weekly. CNN Fear & Greed was not downloaded: the endpoint blocks automated requests (HTTP 418).

| File | Source | Rows | First | Last |
|---|---|---|---|---|
| fred_BAMLH0A0HYM2.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLH0A0HYM2 | 786 | 2023-11-07 | 2026-11-05 |
| fred_BAMLC0A4CBBB.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAMLC0A4CBBB | 786 | 2023-11-07 | 2026-11-05 |
| fred_STLFSI4.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=STLFSI4 | 1714 | 1993-12-31 | 2026-10-30 |
| fred_NFCI.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=NFCI | 2913 | 1971-01-08 | 2026-10-30 |
| fred_ANFCI.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=ANFCI | 2913 | 1971-01-08 | 2026-10-30 |
| fred_T10Y3M.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y3M | 11215 | 1982-01-04 | 2026-11-06 |
| fred_T10Y2Y.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y2Y | 12606 | 1976-06-01 | 2026-11-06 |
| cboe_PC_TOTAL.csv | https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/totalpc.csv (P/C Ratio column) | 3253 | 2006-11-01 | 2019-10-04 |
| cboe_PC_EQUITY.csv | https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/equitypc.csv (P/C Ratio column) | 3253 | 2006-11-01 | 2019-10-04 |
| cboe_PC_INDEX.csv | https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/indexpc.csv (P/C Ratio column) | 3253 | 2006-11-01 | 2019-10-04 |
| aaii_SENTIMENT.csv | https://www.aaii.com/files/surveys/sentiment.xls (weekly) | 2048 | 1987-07-24 | 2026-11-05 |
| yahoo_HYG.csv | yfinance ticker HYG (full history, auto_adjust=False) | 4927 | 2007-04-11 | 2026-11-06 |
| yahoo_LQD.csv | yfinance ticker LQD (full history, auto_adjust=False) | 6109 | 2002-07-30 | 2026-11-06 |
| yahoo_IEF.csv | yfinance ticker IEF (full history, auto_adjust=False) | 6109 | 2002-07-30 | 2026-11-06 |
| yahoo_MOVE.csv | yfinance ticker ^MOVE (full history, auto_adjust=False) | 5932 | 2002-11-12 | 2026-11-06 |
| yahoo_VXN.csv | yfinance ticker ^VXN (full history, auto_adjust=False) | 6487 | 2001-01-23 | 2026-11-06 |

## Option-strategy benchmarks, correlation, credit and dealer gamma (added 2026-11-09)

Cboe strategy indices are real-option-price benchmarks (PutWrite, Iron Condor, Butterfly etc.) useful for checking the option-pricing model; values are index levels as published. Early CNDR/BFLY/RXM/PPUT rows from 1986 are Cboe backfill. Baa/Aaa spreads fill the pre-2023 gap in the ICE BofA series. DIX/GEX columns are as published by SqueezeMetrics (free CSV).

| File | What | Source | Rows | First | Last |
|---|---|---|---|---|---|
| cboe_PUT.csv | S&P 500 PutWrite (ATM puts, cash-secured) | https://cdn.cboe.com/api/global/us_indices/daily_prices/PUT_History.csv | 5001 | 1991-03-04 | 2026-11-06 |
| cboe_CNDR.csv | S&P 500 Iron Condor index | https://cdn.cboe.com/api/global/us_indices/daily_prices/CNDR_History.csv | 10169 | 1986-06-20 | 2026-11-06 |
| cboe_BXM.csv | S&P 500 BuyWrite | https://cdn.cboe.com/api/global/us_indices/daily_prices/BXM_History.csv | 6195 | 2002-03-22 | 2026-11-06 |
| cboe_WPUT.csv | S&P 500 weekly PutWrite | https://cdn.cboe.com/api/global/us_indices/daily_prices/WPUT_History.csv | 5223 | 2006-01-31 | 2026-11-06 |
| cboe_PPUT.csv | S&P 500 5% put protection | https://cdn.cboe.com/api/global/us_indices/daily_prices/PPUT_History.csv | 10163 | 1986-06-30 | 2026-11-06 |
| cboe_CLL.csv | S&P 500 95-110 collar | https://cdn.cboe.com/api/global/us_indices/daily_prices/CLL_History.csv | 4538 | 2008-08-26 | 2026-11-06 |
| cboe_BFLY.csv | S&P 500 iron butterfly | https://cdn.cboe.com/api/global/us_indices/daily_prices/BFLY_History.csv | 10169 | 1986-06-20 | 2026-11-06 |
| cboe_PUTR.csv | Russell 2000 PutWrite | https://cdn.cboe.com/api/global/us_indices/daily_prices/PUTR_History.csv | 6478 | 2001-01-31 | 2026-11-06 |
| cboe_RXM.csv | Russell 2000 BuyWrite | https://cdn.cboe.com/api/global/us_indices/daily_prices/RXM_History.csv | 10169 | 1986-06-20 | 2026-11-06 |
| cboe_VIX1D.csv | 1-day VIX | https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX1D_History.csv | 1126 | 2022-05-13 | 2026-11-06 |
| cboe_COR3M.csv | 3-month implied correlation | https://cdn.cboe.com/api/global/us_indices/daily_prices/COR3M_History.csv | 5230 | 2006-01-03 | 2026-11-06 |
| cboe_COR1M.csv | 1-month implied correlation | https://cdn.cboe.com/api/global/us_indices/daily_prices/COR1M_History.csv | 5245 | 2006-01-03 | 2026-11-06 |
| fred_BAA10Y.csv | Moody's Baa minus 10y Treasury (credit spread, full history) | https://fred.stlouisfed.org/graph/fredgraph.csv?id=BAA10Y | 10212 | 1986-01-02 | 2026-11-05 |
| fred_AAA10Y.csv | Moody's Aaa minus 10y Treasury | https://fred.stlouisfed.org/graph/fredgraph.csv?id=AAA10Y | 10959 | 1983-01-03 | 2026-11-05 |
| squeeze_DIX_GEX.csv | SqueezeMetrics dark-pool index and dealer gamma exposure | https://squeezemetrics.com/monitor/static/DIX.csv | 3904 | 2011-05-02 | 2026-11-06 |
