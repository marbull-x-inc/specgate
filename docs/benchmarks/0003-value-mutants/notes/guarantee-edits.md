# Edits to agent-written guarantees (before freezing, no implementation read)

- express-rate-limit `SECOND`, `HOUR`, `DAY`: the agent wrote 1000, 3600000 and 86400000, derived
  by arithmetic; the docs do not state them. Numbers removed per "a value the docs do not name is
  not invented". `MINUTE` = 60000 kept (the docs state it as the `windowMs` default).
- neverthrow: the agent reported 22 guarantees; the file holds 24. The file is what counts.
