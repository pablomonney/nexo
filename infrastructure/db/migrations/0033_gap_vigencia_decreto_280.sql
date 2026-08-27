-- 0033_gap_vigencia_decreto_280.sql — la vigencia que no se inventa.
--
-- `AR-IVA-CF-VINCULACION-001` declara `valid_from = 1997-04-15`, y esa fecha es
-- la de **publicación** del texto ordenado, no la de vigencia del artículo.
-- `norm_versions.fecha_vigencia` está en NULL para la Ley 23.349 porque nadie la
-- relevó, y el formato de reglas exige `vigencia.fundamento` justamente para que
-- esa diferencia quede escrita en vez de disimulada.
--
-- Lo que falta es concreto: el **texto completo del Decreto 280/1997**, que es
-- el que aprueba el t.o. y trae su cláusula de vigencia. Lo archivado hoy es su
-- *ficha* — 1.164 caracteres de metadatos, sin articulado—, y la propia ficha
-- ofrece el enlace al texto completo.
--
-- Se registra como gap en la base y no solo en un documento porque el motor
-- consulta esta tabla: un gap abierto es una respuesta que el sistema puede dar,
-- no una nota que alguien tiene que acordarse de leer.
--
-- Cuando la fuente exista, entra por el mismo camino que las demás —descarga,
-- SHA-256, registro en `registro-de-descargas.csv`— y recién ahí se corrige la
-- fecha de la regla. No antes, y no por deducción.

INSERT INTO normative_gaps (topic, description, blocks, status)
VALUES (
  'vigencia_to_1997_iva',
  'Falta el texto completo del Decreto 280/1997, que aprueba el t.o. 1997 de la Ley de IVA '
  'y contiene su cláusula de vigencia. Lo archivado es la ficha de INFOLEG (metadatos: emitido '
  '26/03/1997, B.O. 15/04/1997 N° 28626 p. 5), sin articulado. En consecuencia, '
  'norm_versions.fecha_vigencia sigue en NULL para la Ley 23.349.',
  'Establecer la vigencia real de AR-IVA-CF-VINCULACION-001, que hoy usa la fecha de publicación '
  'del t.o. como aproximación declarada. Bloquea su activación.',
  'ABIERTO'
)
ON CONFLICT DO NOTHING;
