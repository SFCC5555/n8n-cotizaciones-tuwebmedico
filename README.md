# Cotización automática con n8n · tuwebmedico.com

> **English summary.** Production automation for [tuwebmedico.com](https://tuwebmedico.com), my business building websites
> for surgeons and doctors in Ecuador. In the sales proposal, a doctor builds a package of modules in a pricing calculator and
> requests a quote: it arrives by email within seconds, with the price guaranteed for 30 days, the chosen maintenance plan and
> a contract draft for those exact modules.
>
> **Flow:** Next.js API route (validates input, recalculates prices server-side, generates the quote code) → n8n webhook
> (header auth) → Google Sheets log (3 retries; if it fails, nothing is sent) → email via Resend (2 retries, Idempotency-Key)
> → Slack notification. An error branch alerts me on Slack and the site offers the client WhatsApp instead; a separate error
> workflow reports any other failure with a link to the execution.
>
> **Key decisions:** never trust prices from the browser (only module IDs are sent); secrets live in environment variables
> and every credential has least privilege (Resend: send-only, own domain; Slack: a bot with `chat:write` only); each failure
> is handled by its impact; idempotency so a retry never sends the same email twice; the failure path was tested by forcing
> an error; DKIM, SPF and DMARC on the sending domain.
>
> **Files:** `nextjs/route.ts` (excerpt of the Next.js route; the main project is private), `n8n/cotizaciones.json` and
> `n8n/alertas.json` (exported workflows, without credentials or test data), `GUIA.md` (step-by-step build guide, in Spanish).
> The rest of this README is in Spanish.

Automatización en producción de [tuwebmedico.com](https://tuwebmedico.com), mi negocio de páginas web para cirujanos y
médicos. En la propuesta comercial, el doctor arma su paquete de módulos y pide la cotización por correo: le llega al
instante con **precio garantizado por 30 días**, el mantenimiento que eligió y el **borrador del contrato** con esos
mismos módulos y precios.

**Pruébalo en vivo:** en [tuwebmedico.com/plastica/propuesta](https://tuwebmedico.com/plastica/propuesta) arma un paquete en
la calculadora y pide la cotización; te llega en segundos.

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
   → HTTP «Enviar (Resend)»       correo al doctor (respuestas a contacto@tuwebmedico.com y copia oculta a mi correo) · 2 reintentos · Idempotency-Key
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

Hecho por Fernando Carrasco · desarrollador full-stack · [Portafolio](https://www.fernando-carrasco.com/) · [LinkedIn](https://www.linkedin.com/in/fernando-carrasco-dev/)
