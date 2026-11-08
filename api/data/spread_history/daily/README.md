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
