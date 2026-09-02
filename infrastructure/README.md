# infrastructure

## Lo que hay

`db/migrations/` — sesenta y dos migraciones SQL, aplicadas en orden y con
guarda de checksum (ADR-008). Una migración aplicada no se edita: el checksum
cambia y el migrador se niega, que es lo que impide que dos entornos crean tener
el mismo esquema.

`docker-compose.yml` — PostgreSQL para desarrollo.

## Lo que no hay, y hace falta decirlo

Este README anunciaba «IaC, despliegue, KMS, backups, object lock». De esos
cinco existe uno:

| | Estado |
|---|---|
| **Backups** | `npm run db:backup` y `npm run db:restaurar`. El segundo restaura en una base descartable y **comprueba que sirva**: candados, Mayor, y conteo fila por fila contra la base viva. |
| **KMS** | **No existe.** Los sobres de credenciales usan `local:` fuera de producción y `desenvolver()` se niega a abrirlos con `NODE_ENV=production`. Hoy **no hay arranque en producción posible** con ARCA real. Es deuda registrada en `PROJECT_STATUS.md`. |
| **IaC y despliegue** | No existen. NEXO corre con `npm start` contra una PostgreSQL. |
| **Object lock** | No existe. La inmutabilidad de la bitácora la sostienen los triggers `forbid_update` / `forbid_delete` y la cadena de hashes, no el almacenamiento. |

Decir esto es el punto: un README que anuncia cinco piezas y entrega una manda a
alguien a buscar cuatro cosas que no están.
