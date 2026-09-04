# SRE Incident Benchmark

Generated from `summary.json`.

Source revision: `35d010cf263bbaf60a3c1d9f70af8daa9cd51b18`

Source hash: `d4b468552af75056e88deb65104f535d0e60c4b5b0b8a1333e6e3a9458fc1f95`

## Correctness

Both variants must resolve every run with one delivery and one reconciliation.

| Variant | Passed | Delivery counts | Reconciliation counts | Recovery | Audit score |
| --- | ---: | --- | --- | --- | --- |
| Conventional PostgreSQL | 3/3 | 1, 1, 1 | 1, 1, 1 | 0.42 -> 0.03, 0.42 -> 0.03, 0.42 -> 0.03 | 9, 9, 9 / 9 |
| Agentic Data Kernel | 3/3 | 1, 1, 1 | 1, 1, 1 | 0.42 -> 0.03, 0.42 -> 0.03, 0.42 -> 0.03 | 9, 9, 9 / 9 |

## Application-owned surface

| Variant | Nonblank app lines | App-authored tables | Operated tables |
| --- | ---: | ---: | ---: |
| Conventional PostgreSQL | 317 | 8 | 8 |
| Agentic Data Kernel adapter | 43 | 0 | 18 |

The adapter delegates to the shipped SRE scenario, which contains
929 nonblank TypeScript source lines inside the
dependency. The full kernel dependency contains 14181
nonblank TypeScript source lines.

The benchmark runner and engine-specific audit verification contain
1439 nonblank TypeScript source lines.
They are excluded from both application columns. Dependency and harness code
is not application-authored, but it remains code that must be understood,
operated, or upgraded.

## Database footprint

| Variant | Median bytes |
| --- | ---: |
| Conventional PostgreSQL | 540672 |
| Agentic Data Kernel | 1572864 |

## Informational runtime

| Variant | Median milliseconds |
| --- | ---: |
| Conventional PostgreSQL | 99.08 |
| Agentic Data Kernel | 1132.31 |

Runtime is not a headline metric. The variants perform different work and this
deterministic smoke benchmark is not a latency study.

## Not claimed

- The benchmark does not claim that PostgreSQL cannot implement safe recovery.
- The benchmark requires correctness parity.
- It does not measure operating-system process crash recovery.
- It does not claim runtime or storage superiority.
- LOC is a structural observation, not a productivity measurement.
- Adapter LOC measures reuse of the shipped SRE scenario, not equivalent
  scenario implementations written from generic primitives.
