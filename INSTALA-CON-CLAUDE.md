# 🤖 Instala Imperio CRM con Claude

Así trabajamos en Imperio: tú das la orden y la IA la ejecuta.

1. Abre **Claude Code** (la terminal o [claude.ai/code](https://claude.ai/code)) en una carpeta nueva.
2. Copia **todo** el bloque de abajo y pégaselo.
3. Responde lo que Claude te pregunte (el nombre de tu negocio, tu color, tu país y tu correo).

---

```text
Quiero instalar Imperio CRM: mi CRM propio, gratis, en mi cuenta de Cloudflare.
El código está en https://github.com/diegodoc11/imperio-crm

Hazlo tú por mí, explicándome cada paso en español sencillo (no soy programador):

1. Descarga el repo en esta carpeta y corre `npm install`.

2. Revisa si estoy conectado a Cloudflare con `npx wrangler whoami`.
   - Si no estoy conectado, dime que escriba `! npx wrangler login` para conectarme.
   - Si no tengo cuenta, guíame para crearla gratis en dash.cloudflare.com/sign-up.

3. Crea mi base de datos con `npx wrangler d1 create imperio-crm-db` y pega el
   database_id que devuelva en wrangler.jsonc.

4. Pregúntame el nombre de mi negocio, mi color de marca favorito y mi país.
   Con eso llena BUSINESS_NAME, BRAND_COLOR, TIMEZONE y PAIS_TELEFONO
   (el indicativo de mi país, sin el +) en wrangler.jsonc.

5. Despliega con `npx wrangler deploy`.

6. Dame el link de mi Torre de Control (mi-worker.workers.dev/torre) y dime que
   entre a crear mi clave de acceso. La clave la escribo yo en el navegador:
   no me la pidas ni la guardes.

7. Actívame los avisos a mi correo (sección "Activa los avisos a tu correo" del README):
   - Guíame para crear mi cuenta gratis en brevo.com y sacar mi clave de API.
   - Pídeme la clave y el correo donde quiero los avisos, y guárdalos como secretos:
       printf '%s' 'LA-CLAVE' | npx wrangler secret put BREVO_API_KEY
       printf '%s' 'MI-CORREO' | npx wrangler secret put AVISO_EMAIL
     No escribas la clave en ningún archivo.

8. Cuando yo te confirme que ya creé mi clave de la Torre, haz una prueba de humo:
   - Manda un lead de prueba a POST /lead con external_id "test_instalacion",
     un WhatsApp SIN indicativo (ej. 3001234567), una respuesta en "answers",
     status "agendo" y una "cita" para mañana en formato ISO.
   - Pídeme que confirme que: (a) me llegó el correo "Agendó" con el botón de
     WhatsApp y la hora en mi zona; (b) en la Torre veo el lead con su WhatsApp
     completo (+57...), la cita y sus respuestas.
   - Luego bórralo de la base con wrangler (primero sus eventos, después el lead):
       DELETE FROM events WHERE lead_id IN (SELECT id FROM leads WHERE external_id LIKE 'test_%');
       DELETE FROM leads WHERE external_id LIKE 'test_%';

9. Al final entrégame:
   - El link de mi Torre de Control para guardarlo en favoritos.
   - El archivo ejemplos/formulario.html adaptado con MI URL y MI país, listo para mi landing.
   - Si uso cal.com: ejemplos/agenda-calcom.html con MI URL, MI link de cal.com y MI país.
   - Una nota en tu memoria de que mi Imperio CRM vive en esta carpeta y cuál es mi URL.
```

---

### ¿Ya lo tenías instalado? Actualízalo a la última versión

Abre Claude Code en la carpeta de tu CRM y pégale esto:

```text
Actualiza mi Imperio CRM con la última versión de https://github.com/diegodoc11/imperio-crm

- Trae los cambios del repo sin perder MI configuración de wrangler.jsonc
  (database_id, BUSINESS_NAME, BRAND_COLOR, TIMEZONE). Agrega las variables
  nuevas que falten y pregúntame lo que necesites (por ejemplo, mi país).
- Despliega con `npx wrangler deploy` y confirma que /health responde con la versión nueva.
- Si la versión trae avisos al correo y yo no los tengo activos, guíame para activarlos.
- Mis leads no se tocan: viven en la base de datos, no en el código.
```

### ¿Algo se dañó después?

Pídeselo a Claude en la misma carpeta: *"mi Imperio CRM está fallando, revísalo y arréglalo"*.

— **Diego Osorio · Nómadas Millonarios · Imperio**
