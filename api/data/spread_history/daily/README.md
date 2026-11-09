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

## Macro, cross-asset and extra Cboe vol (added 2026-11-09, batch 2 group 1)

FRED values as published (blank/'.' dropped). Yahoo rows end 2026-11-06 (today's partial bar removed). BAMLH0A0HYM2EY skipped: FRED serves only 3 years.

| File | Source | First | Last | Rows | Publication lag |
|---|---|---|---|---|---|
| fred_ICSA.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=ICSA | 1967-01-07 | 2026-10-31 | 3122 | weekly, Thursday for the week ending prior Saturday |
| fred_CCSA.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=CCSA | 1967-01-07 | 2026-10-24 | 3121 | weekly, Thursday, one week behind ICSA |
| fred_USEPUINDXD.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=USEPUINDXD | 1985-01-01 | 2026-11-08 | 15287 | daily, next day |
| fred_WLEMUINDXD.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=WLEMUINDXD | 1985-01-01 | 2026-11-08 | 15287 | daily, next day |
| fred_WALCL.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=WALCL | 2002-12-18 | 2026-11-04 | 1247 | weekly, Thursday for Wednesday |
| fred_RRPONTSYD.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=RRPONTSYD | 2003-02-07 | 2026-11-06 | 3363 | daily, same day |
| fred_WTREGEN.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=WTREGEN | 2002-12-18 | 2026-11-04 | 1247 | weekly, Thursday for Wednesday |
| fred_DTWEXBGS.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS | 2006-01-02 | 2026-10-30 | 5222 | daily, about 1 week (weekly H.10 release) |
| fred_DCOILWTICO.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO | 1986-01-02 | 2026-11-03 | 9537 | daily, ~1-2 days |
| fred_SAHMREALTIME.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=SAHMREALTIME | 1959-12-01 | 2026-10-01 | 802 | monthly, with the jobs report (first Friday) |
| fred_UMCSENT.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=UMCSENT | 1952-11-01 | 2026-09-01 | 677 | monthly, final at month end (prelim mid-month) |
| fred_DFII10.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10 | 2003-01-02 | 2026-11-05 | 5966 | daily, next day |
| fred_DGS2.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS2 | 1976-06-01 | 2026-11-05 | 12605 | daily, next day |
| fred_DGS10.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10 | 1962-01-02 | 2026-11-05 | 16197 | daily, next day |
| fred_KCFSI.csv | https://fred.stlouisfed.org/graph/fredgraph.csv?id=KCFSI | 1990-02-01 | 2026-10-01 | 441 | monthly, early following month |
| cboe_DSPX.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/DSPX_History.csv | 2014-06-19 | 2026-11-06 | 3116 | daily, same day |
| cboe_VXD.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VXD_History.csv | 2009-09-18 | 2026-11-06 | 4311 | daily, same day |
| cboe_VXEEM.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VXEEM_History.csv | 2011-03-16 | 2026-11-06 | 3932 | daily, same day |
| cboe_OVX.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/OVX_History.csv | 2009-09-18 | 2026-11-06 | 4309 | daily, same day |
| cboe_GVZ.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/GVZ_History.csv | 2009-09-18 | 2026-11-06 | 4309 | daily, same day |
| cboe_VXTLT.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/VXTLT_History.csv | 2004-01-02 | 2026-11-06 | 5737 | daily, same day |
| cboe_BXR.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/BXR_History.csv (Cboe Russell 2000 strategy index; exact construction per Cboe) | 2000-12-29 | 2026-11-06 | 6499 | daily, same day |
| cboe_BXRD.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/BXRD_History.csv (Cboe Russell 2000 strategy index; exact construction per Cboe) | 2001-01-31 | 2026-11-06 | 6478 | daily, same day |
| cboe_WPTR.csv | https://cdn.cboe.com/api/global/us_indices/daily_prices/WPTR_History.csv (Cboe Russell 2000 strategy index; exact construction per Cboe) | 2011-02-28 | 2026-11-06 | 3945 | daily, same day |
| yahoo_RSP.csv | yfinance RSP (Close unadjusted, Adj Close for dividends/splits) | 2003-05-01 | 2026-11-06 | 5919 | daily, same day |
| yahoo_SPY.csv | yfinance SPY (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_IWM.csv | yfinance IWM (Close unadjusted, Adj Close for dividends/splits) | 2000-05-26 | 2026-11-06 | 6652 | daily, same day |
| yahoo_IWN.csv | yfinance IWN (Close unadjusted, Adj Close for dividends/splits) | 2000-07-28 | 2026-11-06 | 6609 | daily, same day |
| yahoo_IWO.csv | yfinance IWO (Close unadjusted, Adj Close for dividends/splits) | 2000-07-28 | 2026-11-06 | 6609 | daily, same day |
| yahoo_MDY.csv | yfinance MDY (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_QQQ.csv | yfinance QQQ (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLY.csv | yfinance XLY (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLP.csv | yfinance XLP (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLU.csv | yfinance XLU (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLF.csv | yfinance XLF (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLK.csv | yfinance XLK (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLI.csv | yfinance XLI (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLE.csv | yfinance XLE (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLB.csv | yfinance XLB (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_XLV.csv | yfinance XLV (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6753 | daily, same day |
| yahoo_KRE.csv | yfinance KRE (Close unadjusted, Adj Close for dividends/splits) | 2006-06-22 | 2026-11-06 | 5127 | daily, same day |
| yahoo_SMH.csv | yfinance SMH (Close unadjusted, Adj Close for dividends/splits) | 2000-06-05 | 2026-11-06 | 6647 | daily, same day |
| yahoo_JNK.csv | yfinance JNK (Close unadjusted, Adj Close for dividends/splits) | 2007-12-04 | 2026-11-06 | 4762 | daily, same day |
| yahoo_TLT.csv | yfinance TLT (Close unadjusted, Adj Close for dividends/splits) | 2002-07-30 | 2026-11-06 | 6109 | daily, same day |
| yahoo_SHY.csv | yfinance SHY (Close unadjusted, Adj Close for dividends/splits) | 2002-07-30 | 2026-11-06 | 6109 | daily, same day |
| yahoo_GLD.csv | yfinance GLD (Close unadjusted, Adj Close for dividends/splits) | 2004-11-18 | 2026-11-06 | 5527 | daily, same day |
| yahoo_UUP.csv | yfinance UUP (Close unadjusted, Adj Close for dividends/splits) | 2007-03-01 | 2026-11-06 | 4955 | daily, same day |
| yahoo_HGF.csv | yfinance HG=F (Close unadjusted, Adj Close for dividends/splits) | 2000-08-30 | 2026-11-06 | 6577 | daily, same day |
| yahoo_CLF.csv | yfinance CL=F (Close unadjusted, Adj Close for dividends/splits) | 2000-08-23 | 2026-11-06 | 6581 | daily, same day |
| yahoo_TNX.csv | yfinance ^TNX (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6747 | daily, same day |
| yahoo_IRX.csv | yfinance ^IRX (Close unadjusted, Adj Close for dividends/splits) | 2000-01-03 | 2026-11-06 | 6747 | daily, same day |
| yahoo_BTC-USD.csv | yfinance BTC-USD (Close unadjusted, Adj Close for dividends/splits) | 2014-09-17 | 2026-11-08 | 4436 | daily, same day |
| yahoo_SPHB.csv | yfinance SPHB (Close unadjusted, Adj Close for dividends/splits) | 2011-05-05 | 2026-11-06 | 3901 | daily, same day |
| yahoo_SPLV.csv | yfinance SPLV (Close unadjusted, Adj Close for dividends/splits) | 2011-05-05 | 2026-11-06 | 3901 | daily, same day |
| yahoo_EEM.csv | yfinance EEM (Close unadjusted, Adj Close for dividends/splits) | 2003-04-14 | 2026-11-06 | 5931 | daily, same day |

## CFTC Traders in Financial Futures positioning (added 2026-11-09, batch 2 group 2)

Date = report date (Tuesday positions). Columns: open_interest and long/short for dealers, asset managers, leveraged funds and other reportables (spread positions omitted).

| File | Source | First | Last | Rows | Publication lag |
|---|---|---|---|---|---|
| cftc_tff_VIX.csv | https://www.cftc.gov/files/dea/history/fin_fut_txt_2006_2016.zip + fut_fin_txt_2017..2026.zip, Traders in Financial Futures, futures only, code 1170E1 | 2006-08-29 | 2026-11-03 | 1024 | weekly; positions as of Tuesday, published Friday 3:30pm ET (3 days later; delayed by holidays/shutdowns) |
| cftc_tff_RTY.csv | https://www.cftc.gov/files/dea/history/fin_fut_txt_2006_2016.zip + fut_fin_txt_2017..2026.zip, Traders in Financial Futures, futures only, codes 239742 (CME E-mini, 2006-08 and 2017-) and 23977A (ICE mini, 2008-07..2018-06); overlap 2017-18 has one row per code | 2006-06-13 | 2026-11-03 | 1117 | weekly; positions as of Tuesday, published Friday 3:30pm ET (3 days later; delayed by holidays/shutdowns) |
| cftc_tff_ES.csv | https://www.cftc.gov/files/dea/history/fin_fut_txt_2006_2016.zip + fut_fin_txt_2017..2026.zip, Traders in Financial Futures, futures only, code 13874A | 2006-06-13 | 2026-11-03 | 1065 | weekly; positions as of Tuesday, published Friday 3:30pm ET (3 days later; delayed by holidays/shutdowns) |
