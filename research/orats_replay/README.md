# Real-quote replay of the bull put package

Replays the monthly bull put credit spreads (three Russell 2000 sleeves, Fri/Mon/Tue entries) on recorded
option quotes, next to the same replay on the price model, so the two can be compared trade by trade.

- `orats_replay.py`: market calendar, chain providers (price model and recorded quotes), strike rule, exits,
  account simulation.
- `run_real.py`: extracts slim per-year parquet from the raw daily strike files, finds the newest unbroken
  window of data, runs both replays and writes `result.json`, `summary.txt` and `trades.pkl`.
- `improve_real.py`: one-change-at-a-time tests against the same base on recorded quotes: entry-day chain
  readings (richness vs the model, skew, term slope, implied minus realised) and sizing on them with a
  month-shuffle placebo, which passing strike to sell, exit triggers, days to expiry, and the S&P 500 sleeve.

```
python run_real.py --strikes <data>/strikes --cache <data>/parquet/slim \
                   --daily <repo>/api/data/spread_history/daily --out <data>/replay
```

The option data is licensed and is not part of this repository. Keep the raw files, the parquet cache and
every output of the runner outside the repository.
