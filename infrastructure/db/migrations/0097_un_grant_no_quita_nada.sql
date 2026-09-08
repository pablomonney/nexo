-- ============================================================================
-- 0097 — Un GRANT no quita nada
-- ============================================================================
--
-- La 0096 dice, en su encabezado y en tres archivos de código, que `aai_app`
-- tiene **solo `SELECT`** sobre las tablas de facturación, y que por eso
-- ninguna ruta puede emitir un cargo aunque alguien escriba el `INSERT`.
--
-- **Era falso.** Lo escribió como `GRANT SELECT`, y un `GRANT` agrega: no saca
-- lo que ya estaba. Y ya estaba: la 0009 hace
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT SELECT, INSERT, UPDATE ON TABLES TO aai_app;
--
-- así que **cada tabla nueva nace con `INSERT` y `UPDATE` concedidos**. Las seis
-- tablas de la 0096 nacieron escribibles por la aplicación mientras el
-- comentario decía lo contrario.
--
-- ## Es la tercera vez
--
-- La 0086 dejó escrito el mismo hallazgo, con las mismas palabras: «el `REVOKE`
-- no es decorativo… sin revocarlo, el comentario de arriba sería falso». Estaba
-- documentado, se leyó al escribir la 0096, y volvió a pasar.
--
-- Lo que cambió esta vez es **quién lo encontró**. En la 0086 lo encontró un
-- 500 en producción de desarrollo; acá lo encontró un test que intentaba el
-- `UPDATE` prohibido y esperaba un 42501. Escribir la defensa y no intentar
-- romperla habría dejado el agujero abierto detrás de tres comentarios que lo
-- negaban. Por eso `tests/integration/facturacion.test.ts` intenta las dos
-- escrituras y exige el código de error exacto, y no «cualquier cosa menos que
-- funcione».
--
-- ## Y por eso además hay un barrido
--
-- Un `REVOKE` por tabla es una lista que alguien tiene que acordarse de
-- ampliar. `tests/security/solo-lectura-de-verdad.test.ts` recorre las tablas
-- que se declaran de solo lectura para la aplicación y comprueba los
-- privilegios reales contra el catálogo: la próxima tabla que nazca escribible
-- sin quererlo la encuentra el barrido, no el próximo incidente.
-- ============================================================================

REVOKE INSERT, UPDATE, DELETE ON billing_periods FROM aai_app;
REVOKE INSERT, UPDATE, DELETE ON billing_documents FROM aai_app;
REVOKE INSERT, UPDATE, DELETE ON billing_document_lines FROM aai_app;
REVOKE INSERT, UPDATE, DELETE ON payment_intents FROM aai_app;
REVOKE INSERT, UPDATE, DELETE ON collection_steps FROM aai_app;

-- Los precios y la política son declaraciones del operador de NEXO, no de una
-- empresa cliente. La aplicación los lee para mostrar el catálogo y nada más.
REVOKE INSERT, UPDATE, DELETE ON plan_prices FROM aai_app;
REVOKE INSERT, UPDATE, DELETE ON collection_policies FROM aai_app;

-- `payment_events` es el diario de integración del operador: la aplicación no
-- lo lee ni lo escribe. La 0096 no le dio `SELECT` y el DEFAULT PRIVILEGES le
-- dio escritura igual.
REVOKE INSERT, UPDATE, DELETE ON payment_events FROM aai_app;

-- La secuencia de numeración: sin esto, la aplicación puede consumir números.
-- No emite documentos, pero dejar la secuencia abierta significa que un número
-- puede desaparecer sin que exista el documento que lo usó, y explicar el hueco
-- después es imposible.
REVOKE USAGE ON SEQUENCE billing_documents_numero_seq FROM aai_app;

COMMENT ON TABLE billing_documents IS
  'Lo que NEXO le cobra a una empresa. La aplicación SOLO lo lee: el INSERT y '
  'el UPDATE están revocados (0097), no simplemente no concedidos. NO es un '
  'comprobante fiscal mientras es_comprobante_fiscal sea falso.';
