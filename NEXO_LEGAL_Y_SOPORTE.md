# NEXO_LEGAL_Y_SOPORTE — lo que hay que tener antes del primer cliente

**Actualizado:** 2026-09-08, al cerrar B-1.

Este archivo **no contiene documentos legales**. Contiene la lista de lo que
hace falta, qué tiene que decir cada uno y qué del sistema lo condiciona — para
que quien los redacte no tenga que deducir el comportamiento del producto leyendo
código.

> **REQUIERE REVISIÓN LEGAL.** Todo lo de la sección 1 lo tiene que escribir o
> revisar un abogado. Acá está el insumo, no el documento.

---

## 1. Documentos legales

### Términos y condiciones — **REQUIERE REVISIÓN LEGAL**

Lo que el sistema hace y el documento tiene que reflejar:

| Hecho del producto | Dónde se verifica |
|---|---|
| La prueba dura 14 días y **no pide medio de pago** | `DIAS_DE_PRUEBA`, `POST /onboarding/empresa` |
| Al vencer la prueba, la suscripción queda **suspendida**, no cancelada, y **no se borra nada** | `vencerPruebas`, `tests/integration/prueba-y-planes.test.ts` |
| Los precios publicados son **finales**, con IVA incluido | `plan_prices.incluye_impuestos = true`, y `GET /planes` lo deriva de ahí |
| Exceder un tope del plan **no bloquea**: avisa | `routes/suscripciones.ts` |
| Suspender por falta de pago conserva datos, contabilidad e historial | `avanzarCobranza` |
| El cliente puede **exportar su empresa completa** | rutas de exportación |
| Los asientos **no se borran**: se anulan, y queda el rastro | bitácora encadenada |
| Hay conservación de la documentación por plazos legales | parámetro configurable, no constante |

Falta decidir, y es del fundador: plazo de preaviso para cancelar, qué pasa con
los datos después de la baja (cuánto se conservan y con qué acceso), y si hay
período mínimo.

### Política de privacidad — **REQUIERE REVISIÓN LEGAL**

- Ley 25.326 y su régimen sucesor: minimización, finalidad, derechos del titular.
- **El registro de IP en la bitácora está condicionado a evaluación legal** — el
  §21 del pliego lo dice, y el sistema lo respeta: `config.recordIpInAudit`
  gobierna si se guarda, y por defecto no.
- Secreto profesional del contador: el diseño asume que el operador del sistema
  no debe poder leer la contabilidad de los clientes sin dejar rastro.
- **Dónde viven los datos** depende del hosting, que no está decidido. Es un dato
  del documento, no un detalle técnico: son datos contables de terceros.

### Tratamiento de datos y encargado — **REQUIERE REVISIÓN LEGAL**

Un estudio contable que use NEXO es responsable de los datos de **sus** clientes
y NEXO es encargado del tratamiento. Eso necesita su propio acuerdo, y hoy no
existe.

### Cancelaciones y reembolsos — **DECISIÓN DEL FUNDADOR, después legal**

El sistema soporta cancelar con motivo y no permite volver de `CANCELADA`. Lo
que falta decidir: si hay reembolso proporcional, y en qué plazo.

### SLA — **FUTURO**

No hay compromiso de disponibilidad que se pueda sostener: no hay monitoreo con
destino, ni guardia, ni historial de disponibilidad medido. **Prometer un SLA sin
eso es prometer un número que nadie está mirando.**

### Uso de IA — **REQUIERE REVISIÓN LEGAL**

Lo que el sistema garantiza hoy, y conviene que el documento diga con estas
palabras:

- ningún agente de IA escribe en la contabilidad — lo impide el grafo de
  dependencias, no una política;
- toda propuesta de IA pasa por aprobación humana antes de convertirse en
  asiento;
- una cita a una norma que no existe **rechaza** la propuesta y la registra;
- **no hay proveedor de modelo conectado**: hoy lo que corre es determinístico.

### Propiedad intelectual y responsabilidad — **REQUIERE REVISIÓN LEGAL**

Especialmente: el alcance de la responsabilidad sobre determinaciones fiscales.
El sistema **calcula y muestra de dónde sale cada número**, y no reemplaza el
juicio del profesional. Eso debería estar escrito.

---

## 2. Soporte

**Estado: FUTURO.** No hay sistema de tickets, ni SLA, ni cola. Decirlo importa
porque el §71 lo pide y no está.

### Lo que sí existe

| | |
|---|---|
| Mensajes de error con causa y salida | Cada error de dominio dice qué pasó y qué hacer |
| Preguntas frecuentes | En la página pública |
| Bitácora completa | Para reconstruir qué pasó en una cuenta sin preguntarle al cliente |
| Trazabilidad de un saldo hasta su comprobante | Para resolver una discrepancia sin adivinar |
| `/health` y `/health/db` | Para saber si el sistema está arriba |

### Lo mínimo que hace falta antes del primer cliente

No es una organización de soporte. Es que **un cliente con un problema no quede
solo**:

1. **Una dirección de contacto visible** en la aplicación y en la página
   pública. Hoy no está. Es lo más barato de la lista y lo más grave si falta.
2. **Un procedimiento escrito de recuperación de cuenta** — sin correo no hay
   recuperación de contraseña automática, así que hoy es un procedimiento manual
   y tiene que estar escrito para que sea el mismo siempre.
3. **Un procedimiento de incidente**: qué se mira, en qué orden, qué se le dice
   al cliente y cuándo. Ver `docs/OPERACION.md`.
4. **Un registro de lo que se responde.** Sin eso, la tercera vez que pregunten
   lo mismo nadie va a saber que ya pasó dos veces.

### Recuperación de cuenta — **BLOQUEADO por el proveedor de correo**

Sin correo no hay «olvidé mi contraseña». El procedimiento manual, mientras
tanto:

1. el cliente escribe desde la dirección registrada;
2. se verifica contra `users.email` **y** contra un dato de la empresa que solo
   el titular pueda saber;
3. el operador genera una contraseña temporal;
4. queda en la bitácora quién la generó y por qué.

**Esto es explícitamente peor que un flujo por correo** y hay que reemplazarlo:
depende de que quien atiende haga la verificación, y una verificación que depende
de la disciplina de una persona falla el día que hay apuro.

---

## 3. Checklist de salida (§29)

### Producto

- [x] Registro
- [x] Login (con MFA obligatorio por rol)
- [x] Empresa — alta autoservicio en un pedido
- [x] Usuarios
- [x] Roles
- [x] Onboarding — registro → empresa → plan → prueba
- [x] Trial de 14 días, con vencimiento real
- [x] Planes, con matriz de funcionalidades y topes
- [ ] Billing — el ciclo está entero; **falta la pasarela**
- [x] Cancelación
- [x] Dashboard

### Seguridad

- [x] RLS — 118 tablas, todas con `FORCE`
- [x] Aislamiento entre empresas — barrido sobre todos los endpoints
- [ ] Secrets — 🟡 PREPARADO, **sin gestor externo conectado**
- [x] Autenticación
- [x] Límites de intentos
- [x] Logs con redacción
- [x] Auditoría encadenada

### Fiscal

- [x] ARCA — consulta y constatación, contra homologación
- [ ] Certificados de producción — **trámite del contribuyente**
- [ ] Emisión de comprobantes — fuera del MVP, aislada por lint
- [x] IVA y subdiarios
- [x] Comprobantes

### Infraestructura

- [ ] Backups — los scripts existen, **nadie los agenda y el restore no se probó**
- [ ] Monitoreo — hay `/metrics`, **falta destino**
- [ ] Seguimiento de errores — no hay
- [ ] Deploy — documentado, **sin proveedor elegido**
- [ ] Recuperación — **RPO y RTO declarados, no medidos**

### Comercial

- [x] Precios — decididos y declarados
- [x] Landing — con los precios de la API
- [x] Trial
- [ ] Checkout — el camino está; **falta cobrar**
- [x] FAQ
- [ ] Demo — hay sandbox aislado; falta un guion de demostración

### Legal

- [ ] Términos y condiciones — **REQUIERE REVISIÓN LEGAL**
- [ ] Privacidad — **REQUIERE REVISIÓN LEGAL**
- [ ] Política de cancelación — decisión del fundador, después legal
- [ ] Revisión legal completa — **no hecha**

---

## 4. Lo que este archivo no resuelve

Nada de la sección 1 queda resuelto por haberlo escrito acá. Lo que cambia es
que quien vaya a redactarlo **no tiene que deducir el comportamiento del sistema
leyendo código**: cada afirmación de arriba dice dónde se verifica, y si el
sistema cambia y el documento no, el que quede desactualizado va a ser el
documento — que es exactamente el problema que este archivo intenta evitar.
