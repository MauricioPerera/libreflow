# task-contracts/

**Task-contracts (CCDD)** para las unidades atómicas de la auth multi-usuario (Fase 2).
Cada `.md` es un contrato hueco-cero: front-matter YAML (`task`, `intent`, `target`,
`signature`, `budget`, `tests`, …) + cuerpo (Intent · Interface · Invariants · Examples ·
Do/Don't · Tests · Constraints). El `.test.ts` de al lado son los **property-tests congelados**
del contrato — se escriben ANTES de implementar y no se ablandan.

## Para qué
Que un implementador (humano o modelo pequeño) ataque la unidad **sin dudar**: interfaz,
invariantes y ejemplos input→output prescriptivos, con una regla de parada explícita.

## Validar un contrato
Vía el MCP `ccdd-complexity` (`lint_task_contract`) o por CLI:
```
python D:/repos/ccdd-gate/runners/tc_lint.py task-contracts/<contrato>.md
```
Los contratos de esta carpeta linten **verde** (`ok: true, errors: 0`).

## Límite honesto (LibreFlow es TypeScript)
ccdd-gate mide complejidad con **AST de Python** (`measure_complexity`, `scan_guardrails`),
así que el **veredicto determinista de complejidad NO corre sobre la implementación TS**. De
ccdd-gate aquí se usa la **disciplina del contrato** (intent atómico, tests congelados, regla
de parada), no el gate de complejidad sobre el código. La `signature` se expresa como `def`
Python (lo que exige `tc_lint`); el nombre/firma real en el código es TypeScript.

## Contratos
| Contrato | Unidad | Issue |
|---|---|---|
| `credential-owner-guard.md` | resolución de credenciales acotada al dueño del flujo (F2b) | #53 |
| `assert-ownership.md` | autorización de acceso a recurso por dueño/admin (F2a) | #52 |

Las tareas de feature (scoping de 33 endpoints, UI, etc.) NO son task-contracts atómicos —
viven como issues de GitHub (#51–#61).
