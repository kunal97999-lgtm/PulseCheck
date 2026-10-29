# Query performance notes

Data: <your monitors> monitors x <your rows> rows (about <your total> rows), PostgreSQL 16, local Docker, warm cache (second run).

| Query | Before index change | After index change |
|---|---|---|
| A. history, first page | ___ ms, plan: ___ | ___ ms, plan: ___ |
| B. history, next page | ___ ms, plan: ___ | ___ ms, plan: ___ |
| C1. stats 24h | ___ ms | ___ ms |
| C2. stats 7d | ___ ms | ___ ms |
| C3. stats 30d | ___ ms | ___ ms |

Index sizes before/after: ___ / ___. Table size: ___.

Caveat: ~1M rows on one machine shows plan shape and relative cost, not behavior at production scale.