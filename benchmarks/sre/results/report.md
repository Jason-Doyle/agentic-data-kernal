# SRE Incident Benchmark

Generated from `summary.json`.

Source revision: `b11e26f47b7fab96b04d28a604658b2fcabb6d43`

Source hash: `7896ded0768493c0e9694b5df9f8da9bcda16a96d9a51f117ed2f1bdb39cd108`

## Correctness

Both variants must resolve every run with one delivery and one reconciliation.

| Variant | Passed | Delivery counts | Reconciliation counts | Audit score |
| --- | ---: | --- | --- | --- |
| Conventional PostgreSQL | 3/3 | 1, 1, 1 | 1, 1, 1 | 9, 9, 9 / 9 |
| Agentic Data Kernel | 3/3 | 1, 1, 1 | 1, 1, 1 | 9, 9, 9 / 9 |

## Application-owned surface

| Variant | Nonblank app lines | App-authored tables | Operated tables |
| --- | ---: | ---: | ---: |
| Conventional PostgreSQL | 308 | 8 | 8 |
| Agentic Data Kernel adapter | 40 | 0 | 18 |

The adapter delegates to the shipped SRE scenario, which contains
884 nonblank TypeScript source lines inside the
dependency. The full kernel dependency contains 13247
nonblank TypeScript source lines.

The benchmark runner and engine-specific audit verification contain
1289 nonblank TypeScript source lines.
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
| Conventional PostgreSQL | 65.48 |
| Agentic Data Kernel | 1002.14 |

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
