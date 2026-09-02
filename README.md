# WhatsApp Reader

Ingestor local de WhatsApp y servidor MCP de consulta de solo lectura. Sincroniza chats, contactos y mensajes mediante Baileys, los guarda en SQLite y permite consultarlos sin exponer una API de escritura.

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

Las fechas sin hora usan `WHATSAPP_READER_TIME_ZONE`. Las fechas-hora deben incluir `Z` u offset. Si un nombre de chat es ambiguo, la herramienta devuelve candidatos y exige usar el JID exacto.

## Operación y respaldo

El ingestor es el único proceso que escribe. El MCP abre SQLite en modo de solo lectura. Para producción, mantenga el ingestor como servicio bajo un usuario dedicado y conserve `auth/` y `data/` en almacenamiento persistente.

SQLite usa WAL. Para un respaldo consistente, detenga brevemente el ingestor o use la API de backup de SQLite; no copie únicamente el archivo `.sqlite` mientras existan archivos `-wal` activos. Las credenciales de `auth/` deben respaldarse y cifrarse con el mismo cuidado que la base.
