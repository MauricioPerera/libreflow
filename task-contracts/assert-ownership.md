---
task: assert-ownership
intent: autorizar el acceso a un recurso solo a su dueño o a un admin
target: backend/src/db.ts
signature: "def assert_ownership(resource_owner_id: str, requester_id: str, requester_is_admin: bool) -> bool"
budget:
  cyclomatic_max: 5
  nesting_max: 2
  params_max: 5
  lines_max: 25
deps_allowed: []
forbids:
  - "diferenciar 403 de 404 hacia afuera"
tests: assert-ownership.test.ts
spec_version: "0.1"
require_test_approval: true
---

## Intent
Decidir si un solicitante puede acceder a un recurso según su dueño o su rol admin.

## Interface
- Entrada: `resource_owner_id` (owner_id del recurso; puede ser vacío si huérfano), `requester_id`, `requester_is_admin`.
- Salida: `true` si autorizado, `false` si no. La capa de ruta traduce `false` a 404 (no 403).

## Invariants
- `requester_is_admin=true` autoriza siempre (`true`).
- `resource_owner_id == requester_id` autoriza (`true`).
- Dueño distinto y no admin niega (`false`).
- `resource_owner_id` vacío/None y no admin niega (`false`): un recurso sin dueño no es de nadie salvo admin.

## Examples
- `("user-A", "user-A", false)` da `true`.
- `("user-B", "user-A", false)` da `false`.
- `("user-B", "user-A", true)` da `true`.
- `("", "user-A", false)` da `false`.

## Do / Don't
- DO: función pura, sin I/O (la carga del recurso ocurre fuera).
- DON'T: lanzar; devolver booleano. DON'T: revelar al cliente si el recurso existe.

## Tests
- Oráculo independiente con los 4 casos de Examples más combinaciones con semilla fija.
- Aserta el booleano exacto en cada caso.

## Constraints
- Sin dependencias nuevas. PARAR y reportar si el budget no se cumple sin violar la interfaz (no meter workarounds silenciosos).
