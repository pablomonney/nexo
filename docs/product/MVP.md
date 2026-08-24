# MVP.md — Propuesta de Producto Mínimo Viable

> Entregable K del §51.

## 1. Criterio de recorte

El MVP no es "una versión chica de todo". Es **la cadena completa de un extremo a otro para un
caso acotado**, porque la propiedad que vende este producto —trazabilidad total— solo existe si la
cadena está entera. Media cadena no tiene valor: un OCR bonito sin libro Diario es una demo, y un
libro Diario sin origen documentado es una planilla.

```
MVP = una empresa tipo × un flujo completo × trazabilidad íntegra
```

## 2. Alcance

### Empresa objetivo

| Dimensión | MVP |
|-----------|-----|
| Tipo de ente | SRL o SA **no** comprendida en art. 299 LGS |
| Jurisdicción | CABA (IGJ) — la mejor documentada en FASE 0 |
| Marco contable | RT FACPCE (NUA), declarado explícitamente por empresa |
| Régimen IVA | Responsable Inscripto |
| Moneda | Pesos, con soporte de comprobante en USD y su diferencia de cambio |

Elegir **una** jurisdicción y **un** marco no es una limitación de esfuerzo: es la única forma
honesta de arrancar, dado que la vigencia normativa es jurisdiccional (R-02).

### Incluido

| Módulo | Alcance MVP |
|--------|-------------|
| Multiempresa | Estudio con N empresas, aislamiento completo |
| Usuarios y roles | Administrador, Contador, Cargador, Solo lectura |
| Plan de cuentas | Plantilla + edición; centros de costo |
| Ingesta | PDF, JPG, PNG, XML de comprobante electrónico; subida manual y por lote |
| Extracción | Campos del §10, con valor original + interpretado + confianza + método |
| Validación fiscal | WSAA + `wscdcv1` + padrón `a13`, con los tres tipos de validación separados |
| Duplicados | Por hash y por clave lógica |
| Clasificación IA | Compras: gastos e insumos. Salida cerrada al plan real |
| Confianza | Tres niveles + disparadores duros |
| Motor contable | Completo. Sin recortes — es el núcleo |
| Libro Diario y Mayor | Completos, trazables, exportables |
| IVA | Compras y ventas, crédito y débito, notas de crédito/débito, subdiarios |
| Bancos | Importación de extracto CSV + conciliación asistida |
| Balance | Sumas y saldos |
| Estados contables | ESP y ER con plantilla versionada |
| Trazabilidad | Bidireccional completa, botón "¿de dónde salió este importe?" |
| Auditoría | Bitácora encadenada + alertas críticas |
| Normativa | `Normative Engine` con las normas del backlog en `V1`; citas en UI |
| Sandbox | Simulación sobre esquema aislado |

### Explícitamente fuera del MVP

EEPN y EFE · notas y anexos automáticos · ajuste por inflación · sueldos y cargas sociales ·
IIBB y regímenes provinciales · cooperativas, asociaciones y fundaciones · NIIF y NIIF PyMES ·
`Contador IA` conversacional · `Normative Update Service` automático (relevamiento manual asistido
en el MVP) · integraciones de emisión de comprobantes · consolidación.

**Fuera con motivo, no por olvido:** cada exclusión corresponde a un gap normativo declarado o a un
módulo que no aporta a demostrar la cadena completa.

## 3. Criterio de éxito

El MVP está listo cuando un contador puede:

1. Dar de alta una empresa con su plan de cuentas y su ejercicio.
2. Subir 200 comprobantes de compra reales de un mes.
3. Ver cada uno constatado contra ARCA, con los tres sellos de validación separados.
4. Revisar propuestas 🟢/🟡/🔴, aprobar en lote las de alta confianza y resolver las bloqueadas.
5. Obtener Libro Diario, Mayor, subdiarios IVA y balance de sumas y saldos cuadrados.
6. Conciliar el extracto bancario del mes.
7. Emitir ESP y ER.
8. Tomar **cualquier** número de esos estados, hacer clic, y llegar al PDF original y a la norma
   citada con su hash.
9. Exportar todo a Excel y PDF.
10. Cerrar el período y verificar que ya no se puede modificar.

El punto 8 es el criterio de aceptación real. Si falla en un solo número, el MVP no está listo,
por bien que funcione todo lo demás.

## 4. Lo que el MVP debe poder decir

Un MVP honesto necesita saber declararse incompleto. Estas respuestas son **funcionalidad**, no
errores:

```
FUENTE NO ENCONTRADA
CONFLICTO NORMATIVO — REQUIERE REVISIÓN
NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE
NO HAY INFORMACIÓN SUFICIENTE
🔴 BLOQUEADO — requiere intervención profesional
```

## 5. Estimación de esfuerzo

Orientativa, para un equipo de 3–4 personas (backend con dominio contable, full-stack, IA/datos, y
un contador matriculado como *product owner* normativo — este último no es opcional).

| Bloque | Fases | Esfuerzo |
|--------|-------|----------|
| Fundaciones + tenancy + plan de cuentas | 1–2 | 4–6 semanas |
| Ingesta + OCR + validación ARCA | 3 | 6–8 semanas |
| Motor contable + Diario + Mayor | 5–7 | 6–8 semanas |
| Clasificación IA + confianza | 4 | 4–5 semanas |
| IVA | 8 | 4–6 semanas |
| Bancos | 9 | 3–4 semanas |
| Estados contables + trazabilidad UI | 10 | 4–5 semanas |
| Auditoría, alertas, exportaciones, sandbox | 12 | 3–4 semanas |
| **Total** | | **~34–46 semanas** |

Más, en paralelo desde el día uno: **carga normativa `V1`** del backlog de `OFFICIAL_SOURCES.md`
§8. Es trabajo de contador, no de programador, y es la ruta crítica real del proyecto — el software
puede estar listo y el sistema seguir sin poder aplicar una sola regla.
