# Libro Diario y Libro Mayor

> Fuente de todo este documento: **Ley 26.994 — Código Civil y Comercial de la
> Nación, arts. 320 a 331**, archivada en
> [`docs/normative-sources/originals/SAIJ_CCyC_Ley_26994.pdf`](docs/normative-sources/originals/)
> con su sha256 en `checksums.sha256`. Vigencia desde el 01/08/2015 (art. 7° de
> la ley, texto sustituido por el art. 1° de la ley 27.077).

## 1. Un libro no es un reporte

Es la distinción de la que sale todo lo demás.

| | Reporte | Libro |
|---|---|---|
| Se vuelve a correr y da | otra cosa, si los datos cambiaron | lo mismo, o hay un problema |
| Contenido | lo que hay | lo que hay **más si está bien llevado** |
| Vida útil | hasta la próxima consulta | diez años desde el último asiento (art. 328) |
| Valor | informativo | prueba en juicio (art. 330) |

El art. 330 le da eficacia probatoria a la contabilidad *«llevada en la forma y
con los requisitos prescritos»*. Un sistema que emite el Diario sin decir si esos
requisitos se cumplen deja al contador afirmando algo que no verificó.

## 2. Qué entra al Diario

**Solo `APROBADO` y `ANULADO`.** Un asiento en `BORRADOR` o `PROPUESTO` no entra:
nadie lo firmó, y un libro con eficacia probatoria no puede contener propuestas.

**El anulado sí entra**, con su contraasiento al lado. El art. 324 inc. c es
explícito: las equivocaciones se salvan *«mediante un nuevo asiento hecho en la
fecha en que se advierta la omisión o el error»*. No borrando el anterior.

Lo que queda afuera se devuelve en `excluidos` con su motivo. Quien pidió el
Diario de un mes y ve menos asientos de los que esperaba tiene derecho a saber
por qué.

## 3. Los siete controles de forma

Ninguno bloquea la emisión. Un Diario con un hueco de numeración existe y hay que
poder verlo — justamente para poder arreglarlo. Lo que no puede pasar es que se
emita sin decirlo: `cumpleFormalidades` viaja con el libro, se imprime en el pie
y queda grabado en `book_emissions.controles`.

| Control | Artículo | Qué mira |
|---|---|---|
| `ORDEN_CRONOLOGICO` | 324 inc. a | Que el número no vaya para atrás en el tiempo, dentro de cada libro auxiliar |
| `NUMERACION_CORRELATIVA` | 324 inc. b | Huecos en la numeración: el equivalente digital del blanco donde se intercala |
| `SIN_DUPLICADOS` | 324 inc. b | Dos asientos con el mismo número en el mismo libro |
| `PARTIDA_DOBLE` | 321 | Debe = Haber y al menos dos líneas |
| `MONEDA_DE_REGISTRO` | 325 | Que el registro esté en moneda nacional y que toda conversión lleve cotización, fuente y fecha |
| `CORRECCIONES_SALVADAS` | 324 inc. c | Que toda anulación tenga contraasiento, y que no esté antedatado |
| `RESPALDO_DOCUMENTAL` | 321 | Comprobante o justificación firmada detrás de cada asiento |

### El que más se saltea: el contraasiento antedatado

Un contraasiento con fecha anterior al asiento que corrige es imposible: nadie
advierte un error antes de cometerlo. Es la forma más común de antedatar sin que
se note, porque cada asiento por separado parece legítimo. El control mira los
dos juntos.

### El que parece redundante y no lo es

`PARTIDA_DOBLE` verifica algo que la base ya impide con `je_balanced` y
`je_entry_consistent`. Se verifica igual, y el mensaje lo dice: *«Esto no debería
poder pasar»*. Si aparece, el problema está antes de este control — y es mejor
enterarse acá que en una inspección.

## 4. Diario resumido (art. 327)

El art. 327 permite registrar *«en registros resumidos que cubran períodos de
duración no superiores al mes»*, con una condición: *«Estos resúmenes deben
surgir de anotaciones detalladas practicadas en subdiarios»*.

Agrupar por mes y sumar es trivial, y el resultado se ve igual. Lo que cambia es
que en un caso hay un registro detallado atrás y en el otro no — y esa es
exactamente la diferencia que el artículo exige. Por eso `resumirPorMes` **se
niega** si:

- no hay subdiario declarado para ese libro auxiliar (`SUBDIARIO_NO_DECLARADO`);
- el subdiario no cubre todo el tramo resumido (`SUBDIARIO_NO_CUBRE_EL_PERIODO`);
- el grupo abarca más de un mes calendario (`PERIODO_MAYOR_A_UN_MES`).

Devuelve **todos** los motivos, no el primero: quien está por cerrar el mes
necesita saber de una vez qué le falta.

Si hay un rechazo, no hay resumen y el Diario va detallado. Detallado siempre es
legal; resumido sin subdiario, no.

## 5. El Mayor es una proyección

No tiene ningún dato propio. Cada movimiento sale de una línea de asiento y de
nada más. De ahí las tres decisiones de la migración `0019`:

**1. La aplicación no lo escribe.** Lo escribe un trigger diferido cuando un
asiento pasa a `APROBADO`, y a `aai_app` se le revoca el `INSERT`. Una proyección
que se puede escribir a mano deja de ser una proyección.

**2. Un movimiento no se borra nunca**, ni cuando el asiento se anula. El
contraasiento ya lo compensa; borrarlo además lo contaría dos veces — y borrar es
lo que el art. 324 inc. c prohíbe.

**3. Los saldos se recalculan enteros**, no se acumulan de a poco. Un acumulador
que se actualiza con cada asiento se desincroniza en silencio la primera vez que
algo falla a mitad de camino.

### Cuando el Mayor y el Diario discrepan, gana el Diario

No es una preferencia de diseño. El Diario es el libro con eficacia probatoria
del art. 330; el Mayor materializado es una tabla que existe por rendimiento.

```bash
npm run ledger:verify
```

Sale con código distinto de cero si alguna empresa discrepa, y el resultado queda
en `ledger_verifications` con fecha y nombre. La verificación corre en SQL, no
trayendo los movimientos a memoria: un ejercicio con medio millón de movimientos
no entra en un proceso de Node, y un control que solo funciona en libros chicos
no sirve para el caso en el que hace falta.

Las tres discrepancias posibles no son igual de graves:

| Tipo | Qué significa |
|---|---|
| `FALTA_EN_MAYOR` | Proyección incompleta. El saldo de esa cuenta está corto |
| `DATO_DISTINTO` | El Mayor dice otra cosa que el Diario |
| `SOBRA_EN_MAYOR` | **La grave.** Un movimiento sin asiento detrás: un saldo que nadie puede explicar |

## 6. Del número al PDF

El punto 8 del MVP: *tomar cualquier número, hacer clic, y llegar al PDF
original*. La cadena está escrita una sola vez, en la vista `ledger_trace`:

```
movimiento → línea de asiento → asiento → comprobante → documento (con su sha256)
```

Se expone en `GET /books/trace/:movementId`. Que esté en una vista y no en un
JOIN por pantalla es a propósito: cada pantalla que rearma el camino por su
cuenta es una oportunidad de que se le escape una punta.

Los asientos de cierre y los manuales **no tienen documento**, y la vista lo dice
en vez de inventarlo. El `JOIN` se acota por `source_type`: un `source_id` que
coincidiera por casualidad con el id de un documento haría aparecer un respaldo
que nunca existió.

## 7. Exportación: una forma canónica y su hash

El objetivo no es "generar un CSV". Es que el Diario de marzo emitido hoy y el
emitido en 2031 sean **el mismo archivo**, byte por byte, y que eso se pueda
demostrar sin abrir los dos.

- **Punto decimal, no coma.** Un número formateado según el locale de la máquina
  hace que el hash dependa de dónde se corrió la exportación.
- **Sin `toLocaleString`, sin `Intl`, sin `Date`.** Las tres cambian de salida con
  el entorno o con la versión de ICU.
- **LF siempre**, aunque se genere en Windows.
- **BOM al principio, incluido en el hash.** Lo que se descarga es exactamente lo
  que se hashea.

> **Contrapartida real:** Excel en es-AR no abre bien estos CSV con doble clic —
> hay que importarlos eligiendo el punto como separador decimal. Es un costo de
> usabilidad asumido a cambio de reproducibilidad. Si algún día pesa más lo
> primero, la salida amigable se agrega **al lado** de la canónica, nunca en su
> lugar: el hash tiene que seguir siendo el de un archivo que existe.

## 8. Emitir es un acto del profesional

`POST /books/emissions` exige el permiso `book:emit`, que solo tiene el Contador.
No el Administrador — es la misma línea que la migración `0011` trazó con
`journal_entry:approve`: administrar el sistema y responder por lo que un libro
dice son responsabilidades distintas.

La emisión queda en `book_emissions`, inmutable: no se corrige, se emite otra y
quedan las dos.

### Lo que el pie del libro no afirma

El art. 329 exige autorización del Registro Público para llevar los libros por
medios electrónicos, y pide que los medios alternativos sean equivalentes *«en
cuanto a inviolabilidad, verosimilitud y completitud»*. El hash es la parte de
esa equivalencia que le toca al software.

La autorización **no**. Es un hecho del expediente. Cuando no está cargada, el pie
dice que *el sistema no la tiene* — no que falte. Puede existir y no haberse
cargado acá, y afirmar lo contrario sería inventar un hecho jurídico.

## 9. Gaps declarados

- **Foliatura y rúbrica del art. 323.** El sistema numera folios para el listado;
  la individualización en el Registro Público es un trámite, no un dato que el
  software pueda producir.
- **Domicilio de los libros (art. 325, último párrafo).** No modelado.
- **Conservación por diez años (art. 328).** El sistema no borra nada, pero no hay
  todavía una política de retención explícita ni un control que la verifique.
- **Subdiarios como libros propios.** `SubdiarioDeclarado` los referencia, no los
  lleva. Los subdiarios de IVA llegan en FASE 8.
- **Exportación a PDF.** Hoy sale CSV y el texto del pie. El PDF con formato de
  libro rubricado no está.
