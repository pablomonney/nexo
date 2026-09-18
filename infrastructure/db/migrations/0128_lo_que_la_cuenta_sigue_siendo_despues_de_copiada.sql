-- ---------------------------------------------------------------------------
-- Lo que la cuenta sigue siendo después de copiada
-- ---------------------------------------------------------------------------
--
-- La 0127 dejó anotado de qué plantilla salió un plan. Falta lo otro: que la
-- copia conserve lo que el modelo sabía de cada cuenta. Hoy la materialización
-- escribe código, nombre, padre, tipo, naturaleza, imputable, `tax_role` y
-- `closing_role`, y **pierde el resto**. El catálogo sabe que `5.1.03` tiene que
-- quedar en cero con inventario permanente, y la cuenta materializada no lo
-- sabe: el runtime la ve igual que a cualquier otra.
--
-- ## Por qué estas tres y no las cinco
--
-- El catálogo tiene cinco metadatos y solo tres describen a **la cuenta**. Los
-- otros dos describen al **modelo**:
--
--     nucleo   el criterio de NEXO sobre qué necesita una PYME al empezar
--     usos     los dominios funcionales previstos dentro del modelo
--
-- Las dos siguen siendo verdad sobre el plan modelo y dejan de significar algo
-- adentro de una empresa: una vez copiadas, las 185 cuentas son igual de suyas.
-- Convertirlas en columna las volvería configuración editable por empresa, que
-- es justo lo que no son. Viven en `packages/shared/src/plan-de-cuentas.ts` y
-- quien las necesite las resuelve desde ahí, por código de cuenta.
--
-- Las tres que sí entran siguen describiendo a la cuenta después de la copia:
--
--     regularizadora  resta dentro del rubro que corrige
--     especializada   pide criterio profesional para usarse
--     nota            la advertencia contable que hay que poder leer al imputar
--
-- ## `regularizadora` no se deriva, y esa es la razón de la columna
--
-- Parece calculable —«naturaleza distinta de la que le toca al tipo»— y no lo
-- es: las dos cuentas de orden acreedoras (`7.2.01`, `7.2.02`) tienen la
-- naturaleza invertida **y no regularizan nada**. Son el otro lado del par.
-- Derivarla daría dos falsos positivos, y un falso positivo acá significa
-- restar en un estado contable algo que suma.
--
-- ## `especializada` no es una prohibición
--
-- Dice que la cuenta pide criterio profesional —participaciones permanentes sin
-- VPP, impuesto diferido sin el método, RECPAM sin ajuste por inflación—. **No
-- dice que no pueda sugerirse.** Si algún día hace falta esa política, será una
-- propiedad propia y una decisión escrita, no una lectura de esta.
--
-- ## El valor por defecto es el de una cuenta creada a mano
--
-- `false` y `NULL`: una cuenta que alguien da de alta en `POST /accounts` no
-- regulariza nada, no es especializada y no trae advertencia. Es el caso normal
-- y no hay que declararlo.
-- ---------------------------------------------------------------------------

ALTER TABLE accounts
  ADD COLUMN regularizadora boolean NOT NULL DEFAULT false,
  ADD COLUMN especializada  boolean NOT NULL DEFAULT false,
  ADD COLUMN nota           text;

COMMENT ON COLUMN accounts.regularizadora IS
  'La cuenta resta dentro del rubro que corrige: previsiones, amortizaciones '
  'acumuladas, devoluciones. NO se deriva de la naturaleza: las cuentas de orden '
  'acreedoras la tienen invertida y no regularizan nada.';

COMMENT ON COLUMN accounts.especializada IS
  'Requiere criterio profesional para usarse. NO significa que no pueda '
  'sugerirse: una politica de ese tipo seria una propiedad propia.';

COMMENT ON COLUMN accounts.nota IS
  'Advertencia contable sobre esta cuenta, disponible donde alguien la va a '
  'imputar. Viene del catalogo al materializar y la empresa la puede editar.';
