-- ============================================================================
-- 0107 — Una migración no juzga datos
-- ============================================================================
--
-- La 0105 termina con un `DO` que se cae si **algún** plan `DISPONIBLE` no
-- incluye las funcionalidades esenciales. La regla es correcta —un plan
-- vendible sin contabilidad no es un plan— y **el lugar estaba mal**.
--
-- Se cayó en la primera base donde corrió después de la de desarrollo: la de
-- pruebas tenía treinta y cinco planes con nombres como `TEST-10009016`, que
-- dejaron corridas viejas de los tests de facturación antes de que esos tests
-- dejaran de crear planes globales. Ninguno tenía funcionalidades, porque
-- ninguno era un plan: eran basura de test.
--
-- El problema no es la basura. El problema es que **una migración que valida
-- datos que no creó es una mina**: se cae en la base de alguien más, por algo
-- que pasó meses antes, y bloquea un despliegue que no tiene nada que ver.
--
-- Una migración tiene que poder correr sobre cualquier base que llegue con el
-- esquema anterior. Sobre lo que la migración **escribe** puede exigir lo que
-- quiera; sobre lo que encuentra, no.
--
-- ## Dónde vive la regla ahora
--
-- En `tests/security/planes-vendibles.test.ts`, que la comprueba contra los
-- datos y falla el build. Es el mismo movimiento que S-17 y S-29: la regla no
-- se afloja, cambia de lugar — de un `DO` que corre una vez a un control que
-- corre siempre.
--
-- Y gana algo: el control puede distinguir un plan comercial de un resto de
-- test y decir cuál es cuál, cosa que un `RAISE EXCEPTION` en medio de una
-- migración no puede hacer.
--
-- ## Lo que esta migración hace
--
-- La función se queda: la usa el control. Lo que se documenta es que **no la
-- llama ninguna migración**, para que nadie la vuelva a poner en una.
-- ============================================================================

COMMENT ON FUNCTION plan_incluye_las_esenciales(uuid) IS
  'Sin contabilidad, fiscal, terceros, documentos y auditoría no hay producto. '
  'La usa tests/security/planes-vendibles.test.ts, NO una migración: una '
  'migración que valida datos que no creó se cae en la base de alguien más por '
  'algo que pasó meses antes (0107).';
