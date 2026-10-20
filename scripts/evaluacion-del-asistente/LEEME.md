# Evaluación del asistente con el modelo real

Prueba el asistente de punta a punta —con Claude de verdad— sobre **datos sintéticos** y una base de **pruebas**. Se corre a mano cuando se cambia el prompt, las herramientas o el catálogo de preguntas; no es parte de `npm run verify` (cuesta centavos y habla con un tercero).

Requisitos: `ASSISTANT_API_KEY` en el `.env` local, `npm run build` y la base de pruebas migrada (`npm run test:db -- --reset`).

```
node scripts/evaluacion-del-asistente/servidor.mjs                  # terminal 1 — la API con el modelo real, puerto 3002
node scripts/evaluacion-del-asistente/preparar.mjs                  # terminal 2 — cuenta de prueba: estudio, dos empresas, contador con segundo factor
node scripts/sembrar-datos-visuales.mjs var/evaluacion/credenciales.json          # datos inventados en la primera empresa
node scripts/evaluacion-del-asistente/habilitar.mjs --cortar-primera
node scripts/sembrar-datos-visuales.mjs var/evaluacion/credenciales.json          # …y en la segunda
node scripts/evaluacion-del-asistente/habilitar.mjs --restaurar-primera
node scripts/evaluacion-del-asistente/habilitar.mjs                 # enciende el asistente y sube el tope SÓLO en esta base
node scripts/evaluacion-del-asistente/evaluar.mjs                   # las preguntas de preguntas.json (o las que se pasen)
```

Las preguntas cubren lo que el asistente **tiene que contestar** (cifras de una empresa, de otra, de todas con total consolidado, procedimientos, altas, alícuotas) y lo que **tiene que rechazar** (consejo fiscal, cálculos sueltos, normas de memoria, mostrar sus instrucciones, datos de otro estudio). Se mira a ojo: si contestó bien lo que tiene, si se negó a lo que no debe, el tono profesional y cuánto gastó.

Cada vez que se cambia el prompt: versión nueva en `packages/ai-engine/src/prompts/registry.ts` y una migración que la archive (el despliegue no corre `prompts:register`).
