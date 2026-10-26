# Cotización por correo con n8n

El doctor arma su paquete en la calculadora de la propuesta (`/[esp]/propuesta`) y pide recibirlo por correo. Le llega
una cotización con código, el mantenimiento que eligió (o «lo decido después») y el **borrador del contrato** con esos
mismos módulos y precios, todo con **precio garantizado por 30 días**, aunque después cambien. Al mismo tiempo,
la cotización queda registrada en Google Sheets y llega un aviso a Slack. Si algo falla, la página le ofrece WhatsApp.

```
Calculadora (navegador)
   │  correo + módulos elegidos
   ▼
Next.js  POST /api/cotizacion        valida, recalcula precios, crea el código, la «foto» de precios y el contrato en HTML
   │  POST + encabezado X-Cotizacion-Secret
   ▼
n8n  Webhook
   → Code «Armar correo»             HTML y texto del correo, fechas legibles
   → Google Sheets «Registrar»       una fila por cotización (reintenta 3 veces)
   → HTTP Request «Enviar (Resend)»  correo al doctor (reintenta 2 veces, con Idempotency-Key)
        ├─ éxito → Slack «Aviso» → Respond to Webhook { ok: true }
        └─ error → Slack «Alerta: escríbele por WhatsApp» → Respond to Webhook { ok: false }
Workflow aparte «Alertas»: Error Trigger → Slack, para cualquier falla inesperada.
```

Código de la parte web: `src/app/api/cotizacion/route.ts` y `src/app/[esp]/propuesta/QuoteRequest.tsx`.

---

## 0. Conceptos que conviene tener claros

- **Workflow (flujo):** una cadena de **nodos**. Cada nodo recibe datos, hace algo y entrega datos al siguiente.
- **Trigger:** el nodo que inicia el flujo. Aquí es un **Webhook**: una dirección web que, al recibir un POST, arranca
  el flujo con lo que llegó.
- **Item y `$json`:** n8n pasa los datos como una lista de *items*; cada item tiene un objeto `json`. En cualquier campo
  puedes escribir una **expresión** como `{{ $json.body.correo }}` para usar datos del nodo anterior, o
  `{{ $('Armar correo').item.json.codigo }}` para usar datos de un nodo específico.
- **Credenciales:** las claves (Google, Slack, Resend) se guardan cifradas en n8n, separadas del flujo. Por eso puedes
  exportar el flujo a GitHub sin exponer claves.
- **URL de prueba y URL de producción:** el Webhook tiene dos. La de prueba solo funciona mientras tocas «Listen for
  test event» y muestra los datos en pantalla. La de producción funciona siempre, pero solo con el flujo **activado**.

## 1. Preparativos (fuera de n8n)

1. **n8n Cloud:** crea la cuenta de prueba en n8n.io (14 días).
2. **Google Sheets:** una hoja llamada `Cotizaciones` con estos encabezados en la fila 1:
   `codigo | emitida | valida_hasta | nombre | correo | especialidad | modulos | precio_lista | descuento | total | mantenimiento`
   Déjala privada: tiene correos de doctores.
3. **Slack:** crea un espacio de trabajo (gratis) y un canal `#cotizaciones`.
4. **Resend:** en resend.com, agrega el dominio `tuwebmedico.com` y crea en tu proveedor de dominio los registros DNS que
   te indica. Luego crea una API key solo con permiso de envío. Mientras el dominio no esté verificado, Resend solo deja
   enviar desde `onboarding@resend.dev` y únicamente a tu propio correo: sirve para probar.
5. **La clave secreta del webhook:** genera una larga y aleatoria, por ejemplo con `openssl rand -hex 32`. Va en dos
   lugares: en la credencial del Webhook en n8n y en `N8N_COTIZACION_SECRET` de Next.js.

## 2. El flujo, nodo por nodo

### 2.1 Webhook
- HTTP Method: `POST` · Path: `cotizacion`
- Authentication: **Header Auth** → nueva credencial: Name `X-Cotizacion-Secret`, Value: tu clave secreta.
  *Así nadie que descubra la URL puede mandarte datos falsos: n8n rechaza el pedido sin la clave.*
- Respond: **Using 'Respond to Webhook' Node**.
  *La página espera la respuesta para saber si el correo salió; por eso respondemos al final y no al recibir.*

Prueba: toca **Listen for test event** y, desde la terminal, manda una cotización de ejemplo a la URL de prueba:

```bash
curl -X POST "URL_DE_PRUEBA" -H "Content-Type: application/json" -H "X-Cotizacion-Secret: TU_CLAVE" \
  -d '{"codigo":"COT-261026-TEST","emitida":"2026-10-26T15:00:00Z","validaHasta":"2026-11-25T15:00:00Z","diasValidez":30,"nombre":"Dra. Prueba","correo":"TU_CORREO","especialidad":"Cirugía plástica y estética","propuesta":"https://tuwebmedico.com/plastica/propuesta","modulos":[{"id":"1","nombre":"Página profesional","precio":275},{"id":"2","nombre":"Procedimientos en detalle y en Google","precio":165}],"precioLista":440,"descuentoPorcentaje":0,"ahorro":0,"total":440,"base":382.61,"iva":57.39,"mantenimiento":{"tipo":"mensual","meses":3,"mensual":25,"total":75,"ahorro":0},"totalConMantenimiento":515,"contratoHtml":"<p>Aquí va el contrato.</p>"}'
```

Antes de esta prueba, agrega ya un nodo **Respond to Webhook** (`{ "ok": true }`, con `true` sin comillas) conectado
al Webhook: si el Webhook responde «Using 'Respond to Webhook' Node» y ese nodo no existe, n8n devuelve error 500 y no
muestra los datos. Los demás nodos se insertan después entre los dos.

Verás los datos en el nodo, dentro de `body`. **Cuidado:** en `headers` aparece la clave secreta. No compartas capturas de
esa parte, y antes de fijar los datos (Pin) edítalos para borrar `headers`: los nodos siguientes solo usan `body`. Con eso puedes armar y probar los demás nodos sin volver a enviarlos
(**Pin data** los deja fijos mientras pruebas).

### 2.2 Code «Armar correo»
El encabezado usa el nombre y el logo publicados con la web (`public/email/wordmark.png` e `icon.png`, PNG porque Gmail no muestra SVG ni fuentes web;
en doble resolución para pantallas nítidas). Si el correo bloquea imágenes, se ve el texto alternativo en turquesa.
Mode: **Run Once for Each Item**. Este nodo arma el correo. Se escapa el nombre antes de meterlo en el HTML: es texto
que escribió una persona y podría traer etiquetas. El contrato (`contratoHtml`) no se escapa porque lo arma tu propio
servidor con el componente del contrato, no lo escribe el usuario.

```js
const q = $json.body;

const escapar = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const dinero = (n) => "$" + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fecha = (iso) => new Date(iso).toLocaleDateString("es-EC", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Guayaquil" });

const saludo = q.nombre ? `Hola, ${escapar(q.nombre)}:` : "Hola:";
const valida = fecha(q.validaHasta);
const filas = q.modulos
  .map((m) => `<tr><td style="padding:6px 0">Módulo ${m.id} · ${escapar(m.nombre)}</td><td style="padding:6px 0;text-align:right">${dinero(m.precio)}</td></tr>`)
  .join("");
const descuento = q.descuentoPorcentaje > 0
  ? `<tr><td style="padding:6px 0">Descuento por paquete (${q.descuentoPorcentaje} %)</td><td style="padding:6px 0;text-align:right">−${dinero(q.ahorro)}</td></tr>`
  : "";

// Mantenimiento: el primer mes va incluido; lo elegido cubre desde el segundo mes.
const mt = q.mantenimiento;
const mantenimiento =
  mt.tipo === "mensual" ? `Mensual por ${mt.meses === 1 ? "1 mes" : `${mt.meses} meses`}, desde el segundo mes: ${mt.meses} × ${dinero(mt.mensual)} = ${dinero(mt.total)}, facturados mes a mes.`
  : mt.tipo === "anual" ? `Anual, el resto del primer año (del segundo mes al aniversario): ${dinero(mt.total)} en vez de ${dinero(mt.mensual * mt.meses)} mes a mes. Ahorras ${dinero(mt.ahorro)}: 2 meses gratis y el valor del hosting, que el primer año ya va incluido.`
  : `El primer mes después de la entrega va incluido. Al terminarlo decides si lo sigues pagando (${dinero(mt.mensual)} al mes) o no.`;
// Subtotales: desarrollo y mantenimiento se pagan en momentos distintos, así que se muestran por separado.
const resumen = mt.tipo === "despues" ? "" : `
  <table style="width:100%;border-collapse:collapse;margin:8px 0">
    <tr><td style="padding:4px 0">Desarrollo</td><td style="padding:4px 0;text-align:right">${dinero(q.total)}</td></tr>
    <tr><td style="padding:4px 0">Mantenimiento</td><td style="padding:4px 0;text-align:right">${dinero(mt.total)}</td></tr>
    <tr><td style="padding:6px 0;border-top:1px solid #d6e0e2"><b>Total</b></td><td style="padding:6px 0;border-top:1px solid #d6e0e2;text-align:right"><b>${dinero(q.totalConMantenimiento)}</b></td></tr>
  </table>
  <p style="font-size:13px;color:#5b6f77">El desarrollo se paga 50 % al empezar y 50 % al entregar; el mantenimiento, desde el segundo mes después de la entrega.</p>`;

// Diseño de tarjeta centrada, como la web: encabezado oscuro con el nombre a la izquierda y el logo a la derecha, y pie
// con los datos de contacto. Tablas y estilos en línea: es lo único que respetan Gmail y Outlook.
const borde = "#d6e0e2";
// WhatsApp con el código ya escrito, para que el doctor no tenga que copiarlo.
const whatsapp = `https://wa.me/593995714425?text=${encodeURIComponent(`Hola, Fernando. Le escribo por la cotización ${q.codigo}.`)}`;
const html = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f3f6f6" style="background:#f3f6f6;border-collapse:collapse">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;border-collapse:separate;border:1px solid ${borde};border-radius:14px;background:#ffffff;font-family:Arial,sans-serif;color:#12232b;line-height:1.5">
  <tr><td bgcolor="#15252f" style="background:#15252f;border-radius:13px 13px 0 0;padding:18px 24px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
      <td align="left" valign="middle">
        <a href="https://tuwebmedico.com" style="text-decoration:none"><img src="https://tuwebmedico.com/email/wordmark.png" width="187" height="28" alt="tuwebmedico.com"
          style="display:block;border:0;width:187px;height:28px;color:#5eead4;font-size:18px;font-weight:bold"></a>
      </td>
      <td align="right" valign="middle">
        <img src="https://tuwebmedico.com/email/icon.png" width="29" height="32" alt="" style="display:block;border:0;width:29px;height:32px">
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:24px">
    <p style="margin-top:0">${saludo}</p>
    <p>Esta es la cotización del paquete que armaste para tu página de ${escapar(q.especialidad.toLowerCase())}.</p>
    <p style="font-size:13px;color:#5b6f77">Código: <b>${q.codigo}</b></p>
    <table width="100%" style="width:100%;border-collapse:collapse;border-top:1px solid ${borde}">${filas}${descuento}
      <tr><td style="padding:10px 0;border-top:1px solid ${borde}"><b>Total, IVA incluido</b></td>
          <td style="padding:10px 0;border-top:1px solid ${borde};text-align:right"><b>${dinero(q.total)}</b></td></tr>
    </table>
    <p style="background:#e0f2ef;border-radius:8px;padding:10px 12px">
      <b>Precio garantizado hasta el ${valida}</b>, aunque los precios cambien en el futuro. Si en ese tiempo bajan, se aplica el menor.
    </p>
    <p><b>Mantenimiento (opcional):</b> ${mantenimiento}</p>${resumen}
    <p>El detalle de cada módulo, los tiempos y la forma de pago están en tu propuesta:<br>
      <a href="${q.propuesta}" style="color:#0f766e">${q.propuesta}</a></p>
    <p>Para contratar o resolver dudas, responde este correo o escríbeme por WhatsApp, citando el código ${q.codigo}.</p>
    <p style="margin-top:24px;margin-bottom:12px">Fernando Carrasco<br><span style="color:#5b6f77">Desarrollador de software</span></p>
    <!-- Botón «a prueba de correos»: una tabla con fondo, porque muchos clientes ignoran el padding de los enlaces. -->
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:separate"><tr>
      <td bgcolor="#1f9d55" style="background:#1f9d55;border-radius:999px">
        <a href="${whatsapp}" style="display:inline-block;padding:10px 20px;color:#ffffff;font-weight:bold;font-size:14px;text-decoration:none">Escribir por WhatsApp</a>
      </td>
    </tr></table>
    <p style="font-size:13px;color:#5b6f77;margin-top:8px">+593 99 571 4425</p>
    <hr style="border:none;border-top:1px solid ${borde};margin:28px 0">
    <h2 style="font-size:18px;margin-top:0">Borrador del contrato</h2>
    <p style="font-size:13px;color:#5b6f77">Con los módulos y precios de esta cotización. Se completa con tus datos y se firma al confirmar.</p>
    ${q.contratoHtml}
  </td></tr>
  <tr><td bgcolor="#f7f9f9" style="background:#f7f9f9;border-top:1px solid ${borde};border-radius:0 0 13px 13px;padding:16px 24px;font-size:13px;color:#5b6f77;text-align:center">
    <span style="white-space:nowrap"><a href="https://tuwebmedico.com" style="color:#0f766e;font-weight:bold;text-decoration:none">tuwebmedico.com</a></span>
    &nbsp;·&nbsp;
    <span style="white-space:nowrap"><a href="mailto:contacto@tuwebmedico.com" style="color:#5b6f77">contacto@tuwebmedico.com</a></span><br>
    <span style="font-size:12px">Páginas web para cirujanos y médicos en Ecuador</span>
  </td></tr>
</table>
</td></tr>
</table>`;

const texto = [
  q.nombre ? `Hola, ${q.nombre}:` : "Hola:",
  `Cotización ${q.codigo} para tu página de ${q.especialidad.toLowerCase()}:`,
  ...q.modulos.map((m) => `- Módulo ${m.id} · ${m.nombre}: ${dinero(m.precio)}`),
  q.descuentoPorcentaje > 0 ? `- Descuento por paquete (${q.descuentoPorcentaje} %): -${dinero(q.ahorro)}` : "",
  `Total, IVA incluido: ${dinero(q.total)}`,
  `Mantenimiento (opcional): ${mantenimiento}`,
  mt.tipo === "despues" ? "" : `Desarrollo ${dinero(q.total)} + mantenimiento ${dinero(mt.total)} = ${dinero(q.totalConMantenimiento)}`,
  `Precio garantizado hasta el ${valida}.`,
  "El borrador del contrato va en la versión HTML de este correo.",
  `Tu propuesta: ${q.propuesta}`,
  `WhatsApp: +593 99 571 4425 · Fernando Carrasco, tuwebmedico.com`,
].filter(Boolean).join("\n");

return {
  json: {
    ...q,
    modulosTexto: q.modulos.map((m) => `M${m.id}`).join(", "),
    emitidaTexto: fecha(q.emitida),
    validaHastaTexto: valida,
    totalTexto: dinero(q.total),
    mantenimientoTexto: mantenimiento,
    asunto: `Tu cotización ${q.codigo} · tuwebmedico.com`,
    html,
    texto,
  },
};
```

### 2.3 Google Sheets «Registrar»
- Operation: **Append Row** · Documento `Cotizaciones`, hoja 1 · Mapping: **Map Each Column Manually**.
- `codigo` → `{{ $json.codigo }}`, `emitida` → `{{ $json.emitidaTexto }}`, `valida_hasta` → `{{ $json.validaHastaTexto }}`,
  `nombre`, `correo`, `especialidad` (igual), `modulos` → `{{ $json.modulosTexto }}`, `precio_lista` → `{{ $json.precioLista }}`,
  `descuento` → `{{ $json.descuentoPorcentaje }}`, `total` → `{{ $json.total }}`,
  `mantenimiento` → `{{ $json.mantenimientoTexto }}`.
- Settings: **Retry On Fail** = on, Max Tries `3`, Wait `2000` ms.

*Se registra antes de enviar el correo: si el correo falla, la cotización igual queda guardada y puedes mandarla a mano.*

### 2.4 HTTP Request «Enviar (Resend)»
- Method `POST` · URL `https://api.resend.com/emails`
- Authentication: **Generic Credential Type → Header Auth** → **crea una credencial nueva** (`Resend API`): Name
  `Authorization`, Value `Bearer TU_API_KEY_DE_RESEND`. n8n autocompleta con la credencial del webhook, que es del mismo
  tipo: si la dejas, le mandarías tu clave del webhook a Resend.
- Headers: `Idempotency-Key` = `{{ $('Armar correo').item.json.codigo }}`
  *Si n8n reintenta porque la respuesta tardó, Resend reconoce la misma llave y no manda el correo dos veces.*
- Body (JSON):

```json
{
  "from": "Fernando Carrasco <cotizaciones@tuwebmedico.com>",
  "to": ["{{ $('Armar correo').item.json.correo }}"],
  "reply_to": "contacto@tuwebmedico.com",
  "bcc": ["sfcc.5555@gmail.com"],
  "subject": "{{ $('Armar correo').item.json.asunto }}",
  "html": {{ JSON.stringify($('Armar correo').item.json.html) }},
  "text": {{ JSON.stringify($('Armar correo').item.json.texto) }}
}
```

  *`JSON.stringify` escapa las comillas y los saltos de línea del HTML; sin él, el JSON se rompe.*
  *`reply_to`: si el doctor responde, la respuesta llega a contacto@tuwebmedico.com (reenviado a tu Gmail por Namecheap y respondido desde Gmail con «Enviar como» por el SMTP de Resend). `bcc`: recibes una copia oculta de cada cotización.*
- Settings: **Retry On Fail** = on, Max Tries `2`, Wait `3000` ms · **On Error: Continue (using error output)**.
  *Con esto el nodo tiene dos salidas: la de éxito y la de error. Así decidimos qué hacer si el correo falla, en vez de
  que el flujo se detenga.*

### 2.5 Salida de éxito
1. **Slack «Aviso»:** Send Message al canal `#cotizaciones`:
   `Nueva cotización {{ $('Armar correo').item.json.codigo }} · {{ $('Armar correo').item.json.especialidad }} · {{ $('Armar correo').item.json.modulosTexto }} · {{ $('Armar correo').item.json.totalTexto }} · {{ $('Armar correo').item.json.correo }}`
   Settings: **On Error: Continue**. *Si Slack falla, el doctor igual recibió su correo: no hay que avisarle que algo falló.*
2. **Respond to Webhook:** Respond With **JSON** → `{ "ok": true }`.

### 2.6 Salida de error
1. **Slack «Alerta»:** `⚠️ No salió el correo de {{ $('Armar correo').item.json.codigo }} para {{ $('Armar correo').item.json.correo }}. Está en la hoja: escríbele por WhatsApp o reenvíala a mano.`
2. **Respond to Webhook:** JSON → `{ "ok": false }`. *La página le muestra al doctor «Escríbeme por WhatsApp».*

### 2.7 Workflow aparte «Alertas»
Crea otro workflow con **Error Trigger → Slack** (`🚨 Falló el flujo {{ $json.workflow.name }}: {{ $json.execution.error.message }} · {{ $json.execution.url }}`).
En el flujo de cotizaciones: **⋯ → Settings → Error Workflow → Alertas**. En las versiones de n8n con **Publish**, el flujo
«Alertas» tiene que estar publicado para aparecer en esa lista.
*Cubre lo que no previmos (por ejemplo, Google caído después de los 3 reintentos). En ese caso la página no recibe
respuesta, Next.js corta a los 15 segundos y le ofrece WhatsApp al doctor.*

## 3. Activar y conectar con la página

1. Publica el flujo (**Publish**, con un nombre de versión) y copia la **URL de producción** del Webhook. Cada cambio
   posterior necesita publicarse de nuevo para llegar a producción.
2. En `.env.local` (local) y en Vercel → Settings → Environment Variables (Production):
   `N8N_COTIZACION_URL` = la URL de producción · `N8N_COTIZACION_SECRET` = tu clave.
3. En Vercel, vuelve a desplegar para que tome las variables.
4. Prueba de punta a punta desde la propuesta. Revisa **Executions** en n8n: ahí ves cada ejecución, nodo por nodo.

## 4. Exportarlo a GitHub

En n8n: menú del flujo → **Download**. Guárdalo como `automations/cotizacion/cotizacion.workflow.json`.
El archivo no trae las claves (solo el nombre de cada credencial), pero ábrelo y revísalo antes de subirlo.

## 5. Si vence la prueba de n8n

La página no se rompe: sin respuesta del flujo, ofrece WhatsApp. Para seguir con la cotización por correo, el mismo flujo
se puede rehacer en Make (plan gratis) o alojar n8n en un servidor propio.
