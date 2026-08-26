-- 0030_comentario_de_plantillas.sql — el comentario de statement_templates, otra vez.
--
-- La 0029 lo corrigió hace unas horas para decir que la Ley 19.550 ya estaba
-- sembrada y que faltaba transcribir los arts. 63 y 64. Se transcribieron. El
-- comentario vuelve a estar viejo.
--
-- Vale la pena decir por qué se corrige de nuevo en vez de dejarlo vago para que
-- aguante: un comentario que describe el estado tiene que envejecer, y esa es
-- precisamente su utilidad. Uno redactado para no quedar nunca desactualizado
-- ("acá van las plantillas de estados contables") no le dice nada a quien abre
-- `\d+ statement_templates` para entender por qué su balance no sale.

COMMENT ON TABLE statement_templates IS
  'Estructura de los estados contables, versionada y con su norma. Trae el ESP y el ER de la Ley 19.550 arts. 63 y 64 para SA / IGJ / RT FACPCE, publicados por `npm run statements:seed`. Los selectores usan prefijos de código: asumen una convención de plan de cuentas, y una empresa con otra carga la suya con company_id.';

-- La columna que hace posible que una empresa se aparte de la convención. Sin
-- este comentario, `company_id` nullable se lee como "todavía no lo usamos".
COMMENT ON COLUMN statement_templates.company_id IS
  'NULL = plantilla del sistema. Con valor, la plantilla propia de una empresa: es la salida para las que no siguen la convención de códigos que asumen las del sistema.';

-- Por qué una plantilla corregida entra como versión nueva y no se edita.
COMMENT ON COLUMN statement_templates.valid_to IS
  'Cierra la vigencia. Una corrección de transcripción se cierra con valid_to = valid_from —ventana de largo cero— y no con la fecha de hoy: la norma no cambió, cambió nuestra lectura, así que esa versión nunca tuvo un día aplicable. Cerrarla desde hoy haría que un estado de un ejercicio anterior volviera a tomarla.';
