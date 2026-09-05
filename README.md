# WhatsApp Reader

Ingestor local de WhatsApp y servidor MCP de consulta y envío. Sincroniza chats, contactos y mensajes mediante Baileys, los guarda en SQLite y permite enviar texto usando la misma sesión activa del ingestor.

## Estado

El proyecto incluye migraciones, normalización, ingesta, consultas FTS5, servidor MCP, pruebas automatizadas y un smoke test de protocolo. La vinculación con una cuenta real debe hacerse primero con una cuenta secundaria: Baileys no es una API oficial de WhatsApp y puede cambiar o sufrir restricciones.

## Requisitos

- Node.js 20 o superior.
- Una compilación de `better-sqlite3` compatible con el sistema.
- Un terminal interactivo durante la primera vinculación para escanear el QR.
- Disco local persistente para `auth/` y `data/`.

## Instalación reproducible

```bash
npm ci
cp .env.example .env
npm run check
```

`npm run check` ejecuta pruebas, comprobación estricta de tipos, compilación y un cliente MCP real contra una base temporal. No requiere una cuenta de WhatsApp ni usa datos personales.

## Configuración

Las variables admitidas están documentadas en `.env.example`:

- `WHATSAPP_READER_DATA_DIR`: directorio de datos.
- `WHATSAPP_READER_DB_PATH`: archivo SQLite.
- `WHATSAPP_READER_AUTH_DIR`: credenciales de la sesión vinculada.
- `WHATSAPP_READER_SEND_SOCKET`: socket Unix local usado para solicitar envíos al ingestor.
- `WHATSAPP_READER_SEND_TIMEOUT_MS`: tiempo máximo de espera de una solicitud de envío.
- `WHATSAPP_READER_TIME_ZONE`: zona IANA para fechas `YYYY-MM-DD`.
- `WHATSAPP_READER_DEFAULT_LIMIT`: límite predeterminado de consultas.
- `WHATSAPP_READER_LOG_LEVEL`: nivel de log.
- `WHATSAPP_READER_MAX_RECONNECT_ATTEMPTS`: reintentos antes de detenerse.
- `WHATSAPP_READER_RECONNECT_BASE_MS`: base del backoff de reconexión.

`.env`, `auth/`, `data/`, bases y logs están excluidos de Git. El proceso usa permisos restrictivos y redacta contenido sensible de sus logs, pero el disco debe mantenerse cifrado y con acceso limitado.

## Validación local sin WhatsApp

```bash
npm test
npm run typecheck
npm run build
npm run smoke:mcp
npm audit
```

Para ejecutar una prueba concreta:

```bash
npx vitest run test/db.test.ts
```

## Primera vinculación

Prepare la base e inicie el ingestor:

```bash
npm run migrate
npm run ingest
```

Escanee el QR desde **WhatsApp > Dispositivos vinculados**. El ingestor solicita el historial disponible y continúa guardando eventos nuevos. Deténgalo con `Ctrl+C`.

Validación recomendada con una cuenta secundaria:

1. Envíe texto a un chat directo y a un grupo.
2. Envíe una imagen con caption.
3. Reinicie el ingestor y confirme que no aparecen duplicados.
4. Interrumpa brevemente la red y compruebe la reconexión.
5. Revise que los logs no contengan mensajes, QR ni credenciales.
6. Desde el cliente MCP, confirme y envíe un texto de prueba a la cuenta secundaria; compruebe el `message_id` devuelto y la recepción en el teléfono.

## Servidor MCP

Compile antes de iniciarlo:

```bash
npm run build
npm run mcp
```

El transporte es `stdio`: el cliente MCP debe lanzar `node` con la ruta absoluta a `dist/mcp.js` y proporcionar las mismas variables de entorno, especialmente `WHATSAPP_READER_DB_PATH`. No se abre ningún puerto de red.

Herramientas disponibles:

- `search_messages`: búsqueda FTS5 con filtros opcionales de chat y fechas.
- `get_messages`: últimos mensajes de un chat, devueltos cronológicamente.
- `get_chats`: listado y filtro de chats.
- `search_contacts`: búsqueda por nombre, teléfono o JID.
- `send_message`: envía texto a un chat conocido. Requiere `confirmed: true`, no es idempotente y produce un efecto externo real.

Las fechas sin hora usan `WHATSAPP_READER_TIME_ZONE`. Las fechas-hora deben incluir `Z` u offset. Si un nombre de chat es ambiguo, la herramienta devuelve candidatos y exige usar el JID exacto.

## Operación y respaldo

El ingestor es el único proceso que escribe en SQLite y el único que mantiene una conexión con WhatsApp. El MCP abre SQLite en modo de solo lectura y solicita los envíos mediante un socket Unix con permisos `0600`; no se abre ningún puerto de red. En la instalación Docker local ambos procesos se ejecutan dentro del mismo contenedor, por lo que comparten su perímetro y sus volúmenes, aunque el código MCP no lee ni modifica las credenciales.

Antes de invocar `send_message`, el cliente debe mostrar y confirmar tanto el destinatario como el texto. La herramienta sólo acepta chats que ya existen en la base local; si un nombre es ambiguo, devuelve candidatos y exige el JID exacto. Una respuesta `accepted` indica que Baileys aceptó el mensaje y devuelve su identificador, no que el destinatario lo haya leído. Si ocurre un timeout, el estado queda incierto y no debe reintentarse automáticamente porque el envío no es idempotente.

SQLite usa WAL. Para un respaldo consistente, detenga brevemente el ingestor o use la API de backup de SQLite; no copie únicamente el archivo `.sqlite` mientras existan archivos `-wal` activos. Las credenciales de `auth/` deben respaldarse y cifrarse con el mismo cuidado que la base.

## Instalación local con Docker

La configuración incluida crea un único contenedor persistente sin publicar puertos:

- `whatsapp-reader`: ejecuta el ingestor como proceso principal, conecta con WhatsApp y escribe en SQLite. Cuando un cliente necesita usar el MCP, lo inicia temporalmente dentro del mismo contenedor con `docker exec -i`.

Los dos procesos se comunican mediante el socket Unix `/app/data/send.sock`. Los datos y las credenciales se conservan en los volúmenes locales `whatsapp-reader-data` y `whatsapp-reader-auth`.

Las credenciales se escriben en serie y se esperan durante el apagado del contenedor. Después de una vinculación válida también se mantiene `creds.backup.json` mediante escritura atómica en el mismo volumen. Al iniciar, el ingestor recupera ese backup únicamente si `creds.json` falta o está dañado; nunca revive automáticamente una sesión cerrada de forma válida.

Construya la imagen, prepare la base e inicie los contenedores:

```bash
docker compose build
docker compose run --rm --no-deps app node dist/migrate.js
docker compose up -d --remove-orphans
docker compose logs -f app
```

Escanee el QR que aparece en los logs. Puede salir de la vista con `Ctrl+C` sin detener el contenedor. Compruebe el MCP del contenedor con:

```bash
npm run smoke:container
```

Un cliente MCP local debe ejecutar este comando y sus argumentos, manteniendo la entrada estándar abierta:

```text
docker exec -i whatsapp-reader node dist/mcp.js
```

Comandos de operación frecuentes:

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose restart app
docker compose down
```

Si el log informa repetidamente el código `440`, otra instancia está usando la misma identidad de dispositivo. Después de tres intentos el ingestor deja de reconectar para evitar un conflicto permanente; las consultas MCP permanecen disponibles y los envíos devuelven `whatsapp_unavailable` hasta que detenga la otra instancia y ejecute `docker compose restart app`. El mismo estado se aplica si WhatsApp cerró la sesión o se agotan los reintentos. El reinicio explícito crea un nuevo proceso y reanuda los intentos; `unless-stopped` conserva el arranque automático tras reiniciar Docker.

`docker compose down` conserva los datos. No utilice `docker compose down --volumes` salvo que quiera eliminar definitivamente la sesión vinculada y la base local.

## Licencia

Este proyecto se distribuye bajo la [licencia MIT](LICENSE).
