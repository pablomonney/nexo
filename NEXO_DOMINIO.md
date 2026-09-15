# NEXO — dominio propio

**Auditado el 2026-09-12 contra el servidor de producción y contra NIC Argentina.**

---

## 1 · El hallazgo, en una línea

El dominio **está comprado y no está delegado**. Todo lo demás —servidor,
proxy, certificados, aplicación— está listo y esperando exactamente eso.

```
registrado    2026-09-10 14:06 UTC     vence 2027-09-10
titular       CUIT 20452148324
registrador   nicar
estado        inactive          ← el problema
nameservers   ninguno           ← la causa
```

`inactive` en NIC.ar significa: el dominio es tuyo, figura en el registro, y
**no tiene servidores de nombre asignados**. Sin eso ningún resolutor del mundo
sabe a dónde apuntarlo, y la consulta devuelve NXDOMAIN — que es lo que
devuelve hoy, tanto desde tu proveedor como desde `8.8.8.8`.

Comprobado que la cadena DNS funciona: la zona `com.ar` responde y
`afip.gob.ar` resuelve desde el mismo resolutor. El problema es solo este
dominio.

---

## 2 · Qué tenés que hacer vos

Es lo único de todo este documento que yo no puedo hacer.

### Paso 1 — entrar a NIC.ar

<https://nic.ar> → **Ingresar con AFIP** (Clave Fiscal) → *Mis dominios* →
`nexointelligence.com.ar` → **Delegación** / *DNS*.

### Paso 2 — elegir dónde vive la zona

| | Cuándo conviene | Qué implica |
|---|---|---|
| **DNS de NIC.ar** | Querés resolverlo hoy y sin otra cuenta | Cargás los registros en el mismo panel |
| **Cloudflare** (gratis) | Querés panel mejor, cambios rápidos, estadísticas | Crear cuenta, agregar el dominio, copiar sus dos nameservers a NIC.ar |

Las dos sirven. **Con NIC.ar terminás antes**; con Cloudflare el TTL bajo hace
que los cambios futuros se propaguen en minutos.

> ⚠ Si elegís Cloudflare: poné los registros en **modo DNS only (nube gris)**,
> no proxy. Con el proxy naranja activado Let's Encrypt no puede completar el
> desafío HTTP y Traefik no consigue certificado.

### Paso 3 — cargar los registros

| Tipo | Nombre | Valor | TTL |
|---|---|---|---|
| **A** | `@` (o `nexointelligence.com.ar`) | `2.24.94.71` | 3600 |
| **AAAA** | `@` | `2a02:4780:75:1f19::1` | 3600 |
| **A** | `www` | `2.24.94.71` | 3600 |

Verificado contra el servidor: esas son sus direcciones reales y Traefik
escucha en los puertos 80 y 443 de ambas.

> **Sobre el AAAA:** si querés minimizar riesgo en la primera emisión del
> certificado, cargá **solo el A** y agregá el AAAA después. Let's Encrypt
> prefiere IPv6 cuando existe, y si algo del camino v6 falla el certificado no
> sale. Traefik escucha en `*` así que debería funcionar — pero primero que
> salga el certificado, después optimizamos.

### Paso 4 — avisarme

Cuando `nslookup nexointelligence.com.ar 8.8.8.8` devuelva la IP, corro el
despliegue con TLS y el certificado se emite solo. Son dos minutos.

---

## 3 · Lo que ya está listo (no toques nada)

Auditado archivo por archivo:

| | Estado |
|---|---|
| **URLs propias en el código** | **Ninguna.** Las únicas absolutas son APIs de terceros: Resend, Mercado Pago, ARCA |
| **CORS** | No existe, y está bien: la consola la sirve la misma API, es mismo origen |
| **Cookie de sesión** | `sameSite: strict`, `secure` en producción, **sin `domain` fijo** → se adapta sola al host |
| **Enlace de verificación** | No hay enlace: el correo manda **un código para pegar**. El dominio no lo afecta |
| **Router de Traefik** | `Host(nexointelligence.com.ar)` — ya apunta al dominio correcto |
| **ACME** | Resolvedor `letsencrypt`, desafío HTTP, `ACME_EMAIL` cargado, volumen montado, `acme.json` creado y vacío |
| **Servidor** | `nexo-app`, `nexo-postgres` y `traefik` arriba hace 2 días, sanos. Versión `d998246` |

**No hay una sola URL temporal, IP incrustada ni dominio anterior que corregir.**
Es lo mejor que podía salir de esta auditoría: el sistema nació agnóstico del
dominio.

---

## 4 · Lo que cambia cuando el dominio resuelva

Tres cosas, y las tres son variables de entorno o un comando.

### 4.1 · El certificado (lo hago yo)

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d
```

`docker-compose.tls.yml` agrega `certresolver=letsencrypt` al router. Hoy está
deliberadamente **sin aplicar**: pedir un certificado para un dominio en
NXDOMAIN falla, Traefik reintenta, y **Let's Encrypt cuenta las validaciones
fallidas**. Gastarlas ahora significa esperar más el día que haga falta de
verdad.

`scripts/desplegar.sh` ya comprueba que el dominio resuelva antes de agregar
ese archivo, así que no hay forma de equivocarse.

### 4.2 · Las URLs de Mercado Pago

| Variable | Valor final |
|---|---|
| `PAYMENTS_BACK_URL` | `https://nexointelligence.com.ar/suscripcion/volver` |
| Webhook a registrar en el panel de MP | `https://nexointelligence.com.ar/webhooks/pagos` |

La ruta del webhook **ya existe y funciona** (`apps/api/src/routes/webhooks-pagos.ts`).

### 4.3 · El remitente del correo

`EMAIL_FROM` necesita un dominio verificado en Resend. Eso pide **sus propios
registros DNS** (SPF y DKIM, que Resend te da al agregar el dominio) y es
independiente de todo lo anterior. Se puede hacer el mismo día.

---

## 5 · Las URLs finales

| Para qué | URL |
|---|---|
| Consola | `https://nexointelligence.com.ar/consola` |
| Raíz (redirige a la consola) | `https://nexointelligence.com.ar/` |
| Sonda de salud | `https://nexointelligence.com.ar/health` |
| Sonda con base de datos | `https://nexointelligence.com.ar/health/db` |
| Webhook de Mercado Pago | `https://nexointelligence.com.ar/webhooks/pagos` |

> **`www` no está en el router.** Si cargás el registro `www`, agregame una
> línea a la regla de Traefik para que responda —o decime y lo dejo redirigiendo
> al dominio sin `www`, que es lo habitual.

---

## 6 · Mientras tanto: cómo entrar hoy

No hace falta esperar al DNS. Traefik enruta **por nombre**, así que entrando
por IP devuelve 404 (comprobado). La forma de saltearlo es decirle a tu máquina
a dónde va ese nombre.

**Windows** — abrir el Bloc de notas **como administrador**, abrir
`C:\Windows\System32\drivers\etc\hosts` y agregar al final:

```
2.24.94.71 nexointelligence.com.ar
```

Guardar y entrar a `https://nexointelligence.com.ar/consola`.

El navegador va a avisar que el certificado no es de confianza —es el
`TRAEFIK DEFAULT CERT`, autofirmado, porque el real todavía no se pudo emitir—.
Ahí se acepta y se entra. **Acordate de borrar esa línea** cuando el DNS ande.
