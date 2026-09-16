# ============================================================================
# NEXO — imagen de la aplicación
# ============================================================================
#
# Dos etapas: una compila y otra corre. La que corre no lleva el compilador, ni
# las dependencias de desarrollo, ni el código fuente — una imagen con `tsc`
# adentro es superficie de ataque que no sirve para nada en producción.
#
# No elige proveedor de hosting ni orquestador: es una imagen que corre en
# cualquier lado. Lo que falta decidir está en `docs/DESPLIEGUE.md`.
# ----------------------------------------------------------------------------

# --- Etapa 1: compilar -------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Primero los manifiestos y después el código: mientras las dependencias no
# cambien, esta capa se reutiliza y la compilación no vuelve a bajar nada.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# Las migraciones **entran a la imagen**, y no es para poder migrar desde el
# contenedor —eso sigue prohibido, ver el CMD—. Es porque el preflight de
# `arranque.ts` compara los `.sql` del disco contra `schema_migrations` y **se
# niega a arrancar** si la base quedó atrás.
#
# Sin esta línea, el preflight no encuentra el directorio y contesta «no se pudo
# comprobar el esquema», que es un arranque fallido con un mensaje que parece un
# problema de permisos. Le pasó a este despliegue el 2026-09-10.
#
# Se copia en la etapa de build y se arrastra a la de runtime desde el build,
# igual que todo lo demás. Copiarla en runtime `--from=build` sin haberla traído
# acá primero es la dependencia circular que ya se cometió una vez.
COPY infrastructure ./infrastructure

# Misma regla que la línea de arriba, y por la misma lección: lo que la etapa de
# runtime trae con `--from=build` tiene que haber entrado acá primero. Los
# scripts son las tareas periódicas; el motivo de que estén en la imagen está en
# la etapa de runtime.
COPY scripts ./scripts

# `npm ci` respeta el lockfile exacto. `npm install` podría traer una versión
# distinta de la que se probó, que es la peor forma de que producción y CI dejen
# de ser lo mismo.
RUN npm ci
RUN npm run build

# Las dependencias de producción, en un árbol limpio.
RUN npm prune --omit=dev

# --- Etapa 2: correr ---------------------------------------------------------
FROM node:22-alpine AS runtime

# `dumb-init` para que el proceso reciba las señales y termine bien: sin él,
# Node corre como PID 1 y un SIGTERM no cierra las conexiones abiertas.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Nunca como root. El usuario `node` ya viene en la imagen oficial.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages ./packages
COPY --from=build --chown=node:node /app/apps ./apps
COPY --from=build --chown=node:node /app/package.json ./package.json
# El preflight las lee al arrancar. Ver la nota de la etapa de build.
COPY --from=build --chown=node:node /app/infrastructure ./infrastructure

# Las tareas periódicas viven acá, y por eso `scripts/` entra a la imagen.
#
# No estaba, y la ausencia era invisible mientras nadie las corriera: el
# despliegue monta el repo (`-v ${RAIZ}:/repo`) para migrar, y con eso alcanzaba.
# El agendador no puede depender de eso. Un timer que corre cada cinco minutos
# contra un checkout del host se rompe —en silencio— el día que alguien mueva el
# directorio, haga un `git pull` a medias o despliegue una imagen que ya no
# coincide con lo que hay en disco. Peor: correría **código de otra versión**
# contra la base de esta.
#
# Con los scripts adentro, `docker run --rm nexo:production node
# scripts/<tarea>.mjs` corre exactamente el código de la imagen desplegada, que
# es la propiedad que hace que el agendado sea reproducible.
COPY --from=build --chown=node:node /app/scripts ./scripts

# El almacén de documentos es un volumen: si vive adentro del contenedor, se
# pierde en el primer redespliegue.
VOLUME ["/app/var/documents"]

USER node
EXPOSE 3001

# La sonda pregunta por la base, no solo por el proceso. Un servidor que
# responde y no llega a PostgreSQL está caído para todo lo que importa.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/health/db').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]

# Las migraciones **no** corren acá: ver `docs/DESPLIEGUE.md`. Un contenedor que
# migra al arrancar convierte cada réplica nueva en una carrera contra las otras.
CMD ["node", "apps/api/dist/index.js"]
