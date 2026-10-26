# Cotización automática con n8n · tuwebmedico.com

Automatización en producción de [tuwebmedico.com](https://tuwebmedico.com), mi negocio de páginas web para cirujanos y
médicos. En la propuesta comercial, el doctor arma su paquete de módulos y pide la cotización por correo: le llega al
instante con **precio garantizado por 30 días**, el mantenimiento que eligió y el **borrador del contrato** con esos
mismos módulos y precios.

```
Calculadora (navegador)
   │  correo + módulos + mantenimiento
   ▼
Next.js  POST /api/cotizacion     valida, recalcula precios en el servidor, crea el código y la «foto» de la cotización
   │  POST + encabezado secreto
   ▼
n8n  Webhook (Header Auth)
   → Code «Armar correo»          HTML y texto del correo (escapa lo que escribe el usuario)
   → Google Sheets «Registrar»    una fila por cotización · 3 reintentos · si falla, detiene el flujo
   → HTTP «Enviar (Resend)»       correo al doctor · 2 reintentos · Idempotency-Key = código de la cotización
        ├─ éxito → Slack «Aviso»  (bot con solo chat:write) → responde { ok: true }
        └─ error → Slack «Alerta» (2 reintentos)            → responde { ok: false } → el sitio ofrece WhatsApp
Workflow «Alertas»: Error Trigger → Slack, con el nodo que falló, el error y el enlace a la ejecución.
```

## Decisiones

- **No confiar en el navegador:** los precios se recalculan en el servidor con la misma función que usa la calculadora.
- **Secretos fuera del código:** la URL del webhook y su clave viven en variables de entorno; n8n rechaza pedidos sin
  la clave. Cada credencial tiene permisos mínimos (Resend solo envío y solo el dominio propio; Slack, un bot con
  `chat:write`).
- **Cada fallo según su impacto:** sin registro no se envía nada; si falla el correo, alerta y alternativa para el
  cliente; si falla el aviso interno, el flujo sigue, porque el cliente ya tiene su cotización.
- **Idempotencia:** un reintento no duplica el correo (Resend reconoce el código); cada cotización nueva trae otro código.
- **Probado el camino de fallo:** forcé el error del correo y comprobé la alerta y la respuesta `ok: false`.
- **Correo:** DKIM, SPF y DMARC en dominio propio.

## Archivos

- `nextjs/route.ts`: la ruta de Next.js que valida, arma la cotización y llama al webhook. Es un extracto del proyecto (privado): importa los precios y el contrato de otros archivos que no están aquí.
- `n8n/cotizaciones.json` y `n8n/alertas.json`: los flujos exportados de n8n (sin credenciales ni datos de prueba).
- `GUIA.md`: cómo construir el flujo nodo por nodo.

Hecho por Fernando Carrasco · desarrollador full-stack · [LinkedIn y portafolio en mi perfil de GitHub](https://github.com/SFCC5555)
