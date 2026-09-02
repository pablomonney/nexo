-- ============================================================================
-- 0062 — Depósito por defecto: la salida de stock deja de ser un trámite
-- ============================================================================
--
-- La bandeja avisa `VENTA_SIN_SALIDA_DE_STOCK` desde la 0054, y ese aviso está
-- bien puesto: el comprobante no dice de qué depósito salió la mercadería, así
-- que descontar automáticamente sería inventar el dato más importante del
-- movimiento.
--
-- Lo que la 0054 no consideró es que **hay una tercera opción** entre inventar
-- y no hacer nada: que la empresa lo declare.
--
-- ## Declarado no es inventado
--
-- Es el mismo mecanismo que ya usan `parties.dias_de_pago`, `products.stock_minimo`
-- y `analysis_thresholds`: sin declaración el sistema no afirma nada; con
-- declaración, la afirmación es de la empresa y no del software.
--
-- Una empresa con un solo depósito declara ese, y deja de tipear el mismo dato
-- cien veces por mes. Una con cinco puede no declarar ninguno, y entonces todo
-- sigue exactamente como antes: la bandeja avisa y alguien elige cada vez.
--
-- ## Lo que sigue sin pasar
--
-- **La salida no se genera sola.** Ni siquiera con depósito declarado. El
-- depósito declarado *precarga* la sugerencia; registrarla sigue siendo un acto
-- de una persona, porque la mercadería pudo salir de otro lado y solo quien
-- despachó lo sabe.
--
-- La bandeja tampoco cambia: sigue avisando hasta que la salida exista de
-- verdad. Un aviso que desapareciera porque se declaró un default estaría
-- informando sobre la configuración, no sobre el hecho.
-- ============================================================================

ALTER TABLE companies ADD COLUMN default_warehouse_id uuid;

-- La empresa viaja dentro de la clave foránea, como en todo el resto del
-- esquema. Acá el `company_id` del depósito tiene que ser el `id` de esta misma
-- fila: sin eso, una empresa podría declarar como default el depósito de otra y
-- la base lo aceptaría —las FK se verifican con privilegios del sistema y el
-- RLS no las alcanza—.
ALTER TABLE companies
  ADD CONSTRAINT companies_deposito_propio
    FOREIGN KEY (id, default_warehouse_id) REFERENCES warehouses (company_id, id);

COMMENT ON COLUMN companies.default_warehouse_id IS
  'De qué depósito sale la mercadería cuando nadie dice otra cosa. Nulo '
  'significa que la empresa no lo declaró, y entonces cada salida lo elige. '
  'Declararlo NO hace automática la salida: solo precarga la sugerencia.';
