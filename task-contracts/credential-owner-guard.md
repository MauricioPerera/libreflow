---
task: credential-owner-guard
intent: rechazar una credencial cuyo dueño no coincide con el dueño del flujo
target: backend/src/registry.ts
signature: "def resolve_credential_auth(credential_id: str, flow_owner_id: str, requester_is_admin: bool) -> dict"
budget:
  cyclomatic_max: 8
  nesting_max: 3
  params_max: 5
  lines_max: 40
deps_allowed: []
forbids:
  - "cache sin owner"
tests: credential-owner-guard.test.ts
spec_version: "0.1"
require_test_approval: true
---

## Intent
Resolver la auth de una credencial solo si pertenece al dueño del flujo (o el solicitante es admin).

## Interface
- Entrada: `credential_id`, `flow_owner_id` (owner_id del workflow en ejecución), `requester_is_admin`.
- Salida: objeto `{ headers, query }` con la auth resuelta.
- Error: lanza si la credencial no existe o su `owner_id` != `flow_owner_id` y no es admin.

## Invariants
- Credencial de otro dueño con `requester_is_admin=false` lanza (nunca devuelve auth).
- `requester_is_admin=true` resuelve cualquier credencial existente.
- Credencial inexistente lanza, idéntico mensaje que la ajena (no filtra existencia).
- Sin `credential_id` devuelve `{ headers: {}, query: {} }` (sin auth).

## Examples
- `("cred-A", "user-A", false)` con cred-A de user-A devuelve `{headers, query}` resuelto.
- `("cred-B", "user-A", false)` con cred-B de user-B lanza.
- `("cred-B", "user-A", true)` resuelto.
- `("", "user-A", false)` devuelve `{headers: {}, query: {}}`.

## Do / Don't
- DO: comparar `owner_id` antes de descifrar/usar el secreto.
- DON'T: cachear la credencial sin clavar el dueño. DON'T: distinguir "ajena" de "inexistente" en el mensaje.

## Tests
- Oráculo independiente que congela los 4 casos de Examples más entradas con semilla fija.
- Aserta igualdad exacta del shape `{headers, query}` y que los casos de rechazo lanzan.

## Constraints
- Sin dependencias nuevas. PARAR y reportar si el budget no se cumple sin violar la interfaz (no meter workarounds silenciosos).
