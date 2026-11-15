# Fix round 1 (#268)

- I1: `PusherCache.dispatchOwed`, set when a dispatch is skipped for a deployer run under 120 s old, cleared on a
  dispatch or when a queued run is found. While set, a tick with nothing new still does the run-list check (one call)
  and dispatches once the run is older. `deployerWaiting` now returns 'waiting' | 'starting' | 'none'. Tests added.
- M1: jitter doc comment says the 120 s window does most of the work.
- M2: skew allowance of 5 s (`age > -5_000`).
- M3: README pusher paragraph mentions the first-tick offset, the 2-minute window and the owed dispatch.
- Not done, as instructed: the 403/429 cut.
