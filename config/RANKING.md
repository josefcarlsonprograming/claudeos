# Task-Ranking Preferences

Not logged in · Please run /login

## Learned Patterns

- **Consistently skips #1 predictions**: All 3 revealed preferences show operator rejecting the top-ranked item (78, 3, 68) for items ranked lower (64, 71, 37)
  - Model's confidence in highest-ranked items appears misaligned with operator's actual priorities
  
- **Possible avoidance of context-heavy tasks**: Top predictions may cluster into specific categories the operator defers (long-running reviews, routine diagnostics, system setup) in favor of focused work
  
- **Re-balances toward execution momentum**: Operator picks items where quick progress is likely over items flagged as highest-urgency but context-uncertain
  
- **May prefer continuity over raw priority**: Picking lower-ranked items could indicate operator is chaining related sessions rather than jumping to isolated high-urgency work

## Calibration Status

3 data points; the "skip #1 prediction" pattern is consistent but dimensions underlying the picks are not yet clear. Next refinement: correlate skipped vs picked item types (duration, category, context freshness) to sharpen rules.