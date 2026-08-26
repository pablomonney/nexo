# Sistema de Contabilidad Inteligente — Argentina

Plataforma de contabilidad asistida por IA para empresas y estudios contables argentinos.

> **Estado: FASES 0 a 12 construidas. Quedan integraciones (13) e IA avanzada (14).**
>
> - ✅ Documentación técnica y arquitectura (FASE 0)
> - ✅ **21 documentos normativos oficiales archivados con SHA-256** (FASE 1a)
> - ✅ **Monorepo, esquema SQL con los candados, `@aai/shared`, puertas de CI** (FASE 1b)
> - ✅ **API con autenticación, MFA, RBAC granular y tenancy** (FASE 2)
> - ✅ **Integración con ARCA desacoplada, con mocks y datos de prueba** (FASE 3a)
> - ✅ **Ingesta, extracción con las cuatro dimensiones del §10, coherencia y duplicados** (FASE 3b)
> - ✅ **Clasificación asistida: salida cerrada, citas verificadas, la persona aprueba** (FASE 4)
> - ✅ **Motor contable: once validaciones, numeración sin huecos, contraasientos, balance** (FASE 5)
> - ✅ **Motor normativo: vigencia bitemporal, adopción jurisdiccional, citas verificables** (FASE 5b)
> - ✅ **Libro Diario con los controles de forma del CCyC y Mayor como proyección** (FASES 6 y 7)
> - 🟡 **IVA: subdiarios, notas de crédito y Libro de IVA Digital** (FASE 8) — el motor funciona,
>   pero `tax_rates` está vacía hasta archivar la Ley 23.349, así que responde
>   `SIN_ALICUOTAS_RELEVADAS` en vez de suponer 21%
> - ✅ **Bancos: importación con mapeo declarado y conciliación asistida** (FASE 9)
> - 🟡 **Estados contables: plantilla versionada, cada cifra con su origen** (FASE 10) — el motor
>   funciona, pero `statement_templates` está vacía hasta sembrar la Ley 19.550
>   (`npm run statements:seed` dice cómo)
> - ✅ **Notas con cada cifra referenciada al estado, no escrita** (FASE 11)
> - ✅ **Los ocho invariantes A-1..A-8 como puerta de CI que rompe el build** (FASE 12)
> - ✅ **25 migraciones aplicadas y 602/602 tests en verde contra PostgreSQL 18.6**
> - 🟡 Criterio de salida de FASE 3: falta el corpus de 100 comprobantes reales anonimizados
>   (ver `corpus/README.md`). El certificado de ARCA ya está emitido; queda correr
>   `npm run arca:check -- --cert … --key … --cuit …` para que el propio sistema confirme que la
>   delegación funciona. El certificado **no entra al repositorio**: el script lo lee del disco
> - 🟡 El motor normativo funciona pero no tiene reglas cargadas: falta transcribir articulado y
>   archivar la Res. CPCECABA 460/2024 (ver `packages/normative-engine/README.md`)
> - ⬜ Integraciones oficiales ampliadas e IA avanzada (FASES 13 y 14 — ver `ROADMAP.md`)

## Puesta en marcha

```bash
npm install
cp .env.example .env   # completar DATABASE_URL
npm run db:setup       # crea la base y aplica las migraciones
npm run verify
```

Si preferís no instalar PostgreSQL en el host:

```bash
docker compose -f infrastructure/docker-compose.yml up -d
```

`npm run verify` corre las siete puertas: typecheck, ESLint, lint de arquitectura, prohibición de
floats en importes, integridad del archivo normativo, tests y cobertura —con umbral propio del 95%
para el motor contable—. Sin PostgreSQL levantado, los tests de integración se saltean en vez de
fallar; en CI siempre corren.

---

## La idea en una frase

Un motor contable **determinístico y auditable**, gobernado por normativa argentina **versionada y
citada**, con una capa de IA que **propone** y un profesional que **decide**.

No es un chatbot contable. La IA nunca escribe un asiento.

---

## Los tres principios que gobiernan cada decisión

| Principio | Consecuencia concreta |
|-----------|----------------------|
| **PRECISIÓN > AUTOMATIZACIÓN** | El sistema prefiere decir "requiere revisión del contador" antes que generar un asiento incorrecto |
| **Toda cifra tiene origen** | Cualquier número navega hasta el asiento, el comprobante, el documento original y la norma aplicada, con hash |
| **La norma manda, no el modelo** | Ninguna regla existe sin fuente oficial verificada. Sin fuente: `FUENTE NO ENCONTRADA` |

---

## Documentación

### Entregables de FASE 0 (§51 del pliego)

| Entregable | Documento |
|-----------|-----------|
| A · Mapa de arquitectura | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| B · Diagrama de módulos | [`ARCHITECTURE.md`](ARCHITECTURE.md) §3 |
| C · Modelo de base de datos | [`DATABASE.md`](DATABASE.md) |
| D · Mapa de fuentes oficiales | [`OFFICIAL_SOURCES.md`](OFFICIAL_SOURCES.md) |
| E · Mapa normativo | [`docs/normative-sources/mapa-normativo.md`](docs/normative-sources/mapa-normativo.md) |
| F · APIs oficiales | [`docs/api/official-apis.md`](docs/api/official-apis.md) |
| G · Roadmap | [`ROADMAP.md`](ROADMAP.md) |
| H · Riesgos legales y técnicos | [`docs/RISKS.md`](docs/RISKS.md) |
| I · Estrategia de seguridad | [`SECURITY.md`](SECURITY.md) |
| J · Estrategia de pruebas | [`docs/TESTING_STRATEGY.md`](docs/TESTING_STRATEGY.md) |
| K · Propuesta de MVP | [`docs/product/MVP.md`](docs/product/MVP.md) |

### Documentación de módulos

- [`NORMATIVE_ENGINE.md`](NORMATIVE_ENGINE.md) — vigencia bitemporal, resolución de reglas, citas
- [`ACCOUNTING_ENGINE.md`](ACCOUNTING_ENGINE.md) — partida doble, períodos, contraasientos
- [`AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md) — agentes, anti-alucinación, confianza
- [`AUDIT_TRAIL.md`](AUDIT_TRAIL.md) — bitácora encadenada y linaje bidireccional
- [`docs/product/UX.md`](docs/product/UX.md) — criterios de diseño de interfaz (§41, §42)
- [`docs/architecture/adr/`](docs/architecture/adr/) — decisiones de arquitectura
- [`docs/database/schema.draft.prisma`](docs/database/schema.draft.prisma) — borrador de esquema

**Por dónde empezar a leer:** `OFFICIAL_SOURCES.md` primero. Todo lo demás se deriva de lo que
ahí está verificado y —sobre todo— de lo que ahí está declarado como *no* verificado.

---

## Hallazgos que cambiaron el diseño

1. **La vigencia normativa no es nacional — y está confirmado por texto oficial.** La RT 54 tuvo
   tres fechas sucesivas: 01/01/2024 (texto original), 01/07/2024 (tras la RT 56) y 01/01/2025 en
   CABA. El art. 226 del Anexo A de la RG IGJ 15/2024, sustituido por la RG 9/2026, remite a las RT
   *"adoptadas por el Consejo Profesional de Ciencias Económicas de la CABA"*. El organismo de
   control no manda aplicar "la RT vigente", sino la adoptada por el consejo de la jurisdicción.
   → tabla `norm_adoptions` y clave `(norma, jurisdicción, fecha)`.

2. **No existe API oficial de "Mis Comprobantes".** La automatización total de la ingesta de
   compras no es posible por vía oficial. → ADR-004: sin scraping de portales con Clave Fiscal.

3. **El marco contable es una opción del ente, no un dato derivable.** El art. 230 sustituido dice
   que las sociedades *"podrán optar"* por NIIF o NIIF para PyMES. → se registra con respaldo
   documental, no se infiere.

4. **El Boletín Oficial no sirve como fuente de texto.** Sus páginas de aviso son una SPA y el HTML
   servido no contiene el articulado. → InfoLeg es la fuente de texto del sistema; el BO se usa
   para datar y citar.

5. **La documentación técnica de un organismo no prueba vigencia.** El catálogo de web services de
   ARCA publica `wsseg` citando la RG 2668, derogada por la RG 5866/2026. → los manuales son
   jerarquía P4 y jamás fundan una regla.

6. **Dos fuentes secundarias que "se contradicen" pueden estar ambas en lo cierto.** El supuesto
   conflicto de fechas de la RG 5616/2024 eran dos hitos de normas distintas. → citar el texto
   oficial, nunca la interpretación de terceros.

---

## Estructura

```
/apps          web (Next.js) · api (Node/TS)
/packages      accounting-engine · tax-engine · normative-engine · document-engine
               financial-statements · audit-engine · ai-engine · shared
/docs          architecture · normative-sources · accounting-rules · tax-rules · api · database · product
/tests         unit · integration · accounting · tax · normative · security · ocr · regression
/scripts       utilidades y verificadores
/infrastructure
```

---

## Reglas del repositorio

1. Ninguna regla contable o fiscal sin `norm_version_id` y documento oficial archivado con hash.
2. Ninguna alícuota, monto ni plazo escrito en el código. Son parámetros normativos versionados.
3. `packages/ai-engine` no puede importar `accounting-engine` ni el cliente de base. Verificado en CI.
4. Prohibido `float` en cálculos monetarios. Verificado en CI.
5. Prohibido `DELETE` en tablas contables, documentales y de auditoría.
6. Sin secretos en el repositorio.
7. Ante duda normativa: investigar la fuente oficial. Si no está disponible, escribir
   `NO VERIFICABLE CON FUENTE OFICIAL DISPONIBLE`. **Nunca inventar.**

---

## Advertencia de uso

Este software es una herramienta de **automatización, asistencia, trazabilidad y control
profesional**. No sustituye el juicio de un contador público matriculado ni constituye
asesoramiento profesional. Toda registración contable requiere aprobación de un profesional
responsable identificado.
