# WhatsApp Reader

Ingestor local de WhatsApp y servidor MCP de consulta y envío. Sincroniza chats, contactos y mensajes mediante Baileys, los guarda en SQLite y permite enviar texto usando la misma sesión activa del ingestor.

## Estado

El proyecto incluye migraciones, normalización, ingesta, consultas FTS5, servidor MCP, pruebas automatizadas y un smoke test de protocolo. La vinculación con una cuenta real debe hacerse primero con una cuenta secundaria: Baileys no es una API oficial de WhatsApp y puede cambiar o sufrir restricciones.

## Instalación local con Docker

Necesita Docker Engine con Compose, acceso a Internet para construir la imagen y conectar con WhatsApp, y un terminal para ver el QR. Ejecute los comandos desde la raíz del repositorio. No necesita instalar Node.js en el anfitrión, crear un `.env` ni copiar `.env.example`.

La configuración incluida crea un único contenedor persistente sin publicar puertos:

- `whatsapp-reader`: ejecuta el ingestor como proceso principal, conecta con WhatsApp y escribe en SQLite. Cuando un cliente necesita usar el MCP, lo inicia temporalmente dentro del mismo contenedor con `docker exec -i`.

Los dos procesos se comunican mediante el socket Unix `/app/data/send.sock`. Los datos y las credenciales se conservan en los volúmenes locales `whatsapp-reader-data` y `whatsapp-reader-auth`.

Construya la imagen, prepare la base e inicie el contenedor:

```bash
docker compose build
docker compose run --rm --no-deps app node dist/migrate.js
docker compose up -d --remove-orphans
docker compose logs -f app
```

Escanee el QR desde **WhatsApp > Dispositivos vinculados**. Puede salir de la vista de logs con `Ctrl+C` sin detener el contenedor. El ingestor solicita el historial disponible y continúa guardando eventos nuevos. En los próximos arranques reutiliza la sesión guardada.

Comandos de operación frecuentes:

```bash
docker compose ps
docker compose logs --tail=100 app
docker compose restart app
docker compose down
```

Si el log informa repetidamente el código `440`, otra instancia está usando la misma identidad de dispositivo. Después de tres intentos el ingestor deja de reconectar para evitar un conflicto permanente; las consultas MCP permanecen disponibles y los envíos devuelven `whatsapp_unavailable` hasta que detenga la otra instancia y ejecute `docker compose restart app`. El mismo estado se aplica si WhatsApp cerró la sesión o se agotan los reintentos. El reinicio explícito crea un nuevo proceso y reanuda los intentos; `unless-stopped` conserva el arranque automático tras reiniciar Docker.

`docker compose down` conserva los datos. No utilice `docker compose down --volumes` salvo que quiera eliminar definitivamente la sesión vinculada y la base local.

## Configuración del contenedor

Toda la configuración de la aplicación está incorporada en la imagen mediante el bloque `ENV` del [Dockerfile](Dockerfile). El archivo Compose incluido no pasa variables `WHATSAPP_READER_*` del anfitrión a la aplicación ni monta archivos de configuración. El ingestor y el MCP iniciado con `docker exec` usan los mismos valores:

| Variable | Valor por defecto en el contenedor |
| --- | --- |
| `WHATSAPP_READER_DATA_DIR` | `/app/data` |
| `WHATSAPP_READER_DB_PATH` | `/app/data/whatsapp.sqlite` |
| `WHATSAPP_READER_AUTH_DIR` | `/app/auth` |
| `WHATSAPP_READER_SEND_SOCKET` | `/app/data/send.sock` |
| `WHATSAPP_READER_SEND_TIMEOUT_MS` | `15000` |
| `WHATSAPP_READER_TIME_ZONE` | `America/Argentina/Buenos_Aires` |
| `WHATSAPP_READER_DEFAULT_LIMIT` | `20` |
| `WHATSAPP_READER_LOG_LEVEL` | `info` |
| `WHATSAPP_READER_MAX_RECONNECT_ATTEMPTS` | `8` |
| `WHATSAPP_READER_RECONNECT_BASE_MS` | `1000` |

Para cambiar estos valores por defecto, edite el bloque `ENV` del Dockerfile y reconstruya y recree el contenedor:

```bash
docker compose up -d --build
```

Este comando también aplica la configuración incorporada en la imagen a una instalación existente y conserva los volúmenes de datos y credenciales. `docker compose restart` por sí solo no incorpora cambios de la imagen. Si hay un cliente MCP conectado, vuelva a conectarlo después de recrear el contenedor.

Mantenga las rutas de datos y credenciales alineadas con los destinos de los volúmenes en [compose.yaml](compose.yaml). La configuración forma parte de la imagen; SQLite y la sesión vinculada se generan durante el uso y se guardan en esos volúmenes.

## Servidor MCP

El transporte es `stdio`. Configure su cliente MCP para ejecutar Docker con estos argumentos, manteniendo la entrada estándar abierta:

```text
docker exec -i whatsapp-reader node dist/mcp.js
```

- Ejecutable: `docker`.
- Argumentos: `exec`, `-i`, `whatsapp-reader`, `node`, `dist/mcp.js`.

El contenedor debe estar iniciado y el cliente debe tener acceso al mismo Docker Engine. No necesita pasar variables de entorno, rutas del anfitrión ni un archivo `.env`: el MCP hereda la configuración del contenedor. No agregue `-t`, porque el protocolo necesita `stdio` sin terminal interactivo. No se abre ningún puerto de red.

Herramientas disponibles:

- `search_messages`: búsqueda FTS5 con filtros opcionales de chat y fechas.
- `get_messages`: últimos mensajes de un chat, devueltos cronológicamente.
- `get_chats`: listado y filtro de chats.
- `search_contacts`: búsqueda por nombre, teléfono o JID.
- `send_message`: envía texto a un chat conocido. Requiere `confirmed: true`, no es idempotente y produce un efecto externo real.

Las fechas sin hora usan `WHATSAPP_READER_TIME_ZONE`. Las fechas-hora deben incluir `Z` u offset. Si un nombre de chat es ambiguo, la herramienta devuelve candidatos y exige usar el JID exacto.

## Operación y respaldo

El ingestor es el único proceso que escribe en SQLite y el único que mantiene una conexión con WhatsApp. El MCP abre SQLite en modo de solo lectura y solicita los envíos mediante IPC local: un socket Unix con permisos `0600` en Linux, o una named pipe en Windows. No se publica ningún puerto TCP. En la instalación Docker local ambos procesos se ejecutan dentro del mismo contenedor, por lo que comparten su perímetro y sus volúmenes, aunque el código MCP no lee ni modifica las credenciales.

Antes de invocar `send_message`, el cliente debe mostrar y confirmar tanto el destinatario como el texto. La herramienta sólo acepta chats que ya existen en la base local; si un nombre es ambiguo, devuelve candidatos y exige el JID exacto. Una respuesta `accepted` indica que Baileys aceptó el mensaje y devuelve su identificador, no que el destinatario lo haya leído. Si ocurre un timeout, el estado queda incierto y no debe reintentarse automáticamente porque el envío no es idempotente.

Las credenciales se escriben en serie y se esperan durante el apagado del contenedor. Después de una vinculación válida también se mantiene `creds.backup.json` mediante escritura atómica en el mismo volumen. Al iniciar, el ingestor recupera ese backup únicamente si `creds.json` falta o está dañado; nunca revive automáticamente una sesión cerrada de forma válida.

SQLite usa WAL. Para un respaldo consistente, detenga brevemente el ingestor o use la API de backup de SQLite; no copie únicamente el archivo `.sqlite` mientras existan archivos `-wal` activos. Las credenciales de `auth/` deben respaldarse y cifrarse con el mismo cuidado que la base.

## Desarrollo y ejecución sin Docker

El mismo código admite Linux y Windows nativo, sin WSL ni Docker. Use Node.js 22 o 24 y disco local persistente para `auth/` y `data/`. Instale las dependencias en cada sistema: `better-sqlite3` incluye un módulo nativo, por lo que no debe copiar `node_modules` desde otro sistema operativo. Los comandos de esta sección se ejecutan en el anfitrión.

La matriz de GitHub Actions ejecuta `npm run check` en Ubuntu y Windows con Node.js 22 y 24. Incluye pruebas, tipos, compilación y un cliente MCP real con consultas y envío simulado; no vincula una cuenta real.

### Instalación en Linux

```bash
npm ci
cp .env.example .env
npm run check
```

`npm run check` ejecuta pruebas, comprobación estricta de tipos, compilación y un cliente MCP real contra una base temporal. No requiere una cuenta de WhatsApp ni usa datos personales.

### Instalación en Windows nativo

Instale Node.js 22 o 24 para Windows y abra PowerShell. Sitúe el repositorio en una carpeta privada, por ejemplo `$HOME\proyectos\whatsapp-reader`:

```powershell
Set-Location "$HOME\proyectos\whatsapp-reader"
npm.cmd ci
Copy-Item .env.example .env
npm.cmd run check
npm.cmd run migrate
npm.cmd run ingest
```

Copie `.env.example` solo en la primera instalación para conservar su configuración. `npm.cmd` evita depender de la política de ejecución del script `npm.ps1`. Si `npm ci` necesita compilar `better-sqlite3` porque no encuentra un binario compatible, instale Python y Visual Studio Build Tools con la carga de trabajo de C++ y repita la instalación.

Escanee el QR desde **WhatsApp > Dispositivos vinculados** y deje el ingestor activo. Deténgalo con `Ctrl+C`; los siguientes arranques reutilizan las credenciales. No necesita cambiar la ruta `./data/send.sock` del ejemplo: en Windows se transforma en una named pipe, sin crear ese archivo. No se usan comandos Unix para crear, ajustar permisos o borrar la pipe.

Para conectar un cliente MCP, configure el ejecutable `node.exe`, el argumento con la ruta absoluta a `dist/mcp.js` y el directorio de trabajo del repositorio. Si el cliente no admite directorio de trabajo, este ejemplo de configuración JSON usa rutas absolutas (ajuste usuario y ubicación):

```json
{
  "mcpServers": {
    "whatsapp-reader": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\Ana\\proyectos\\whatsapp-reader\\dist\\mcp.js"],
      "env": {
        "WHATSAPP_READER_DATA_DIR": "C:/Users/Ana/proyectos/whatsapp-reader/data",
        "WHATSAPP_READER_DB_PATH": "C:/Users/Ana/proyectos/whatsapp-reader/data/whatsapp.sqlite",
        "WHATSAPP_READER_SEND_SOCKET": "C:/Users/Ana/proyectos/whatsapp-reader/data/send.sock",
        "WHATSAPP_READER_TIME_ZONE": "America/Argentina/Buenos_Aires"
      }
    }
  }
}
```

El esquema concreto depende de su cliente MCP. Las rutas anteriores deben coincidir con las del ingestor; si personaliza el canal IPC, cambie ambos procesos. El MCP no necesita acceso a `auth/`.

Para inicio automático puede usar el Programador de tareas con `node.exe`, el argumento absoluto a `dist/ingest.js` y **Iniciar en** apuntando al repositorio. Use el mismo usuario que el cliente MCP y configure **No iniciar una nueva instancia** si la tarea ya está activa. Para mantenimiento, prefiera el apagado mediante `Ctrl+C` en una ejecución interactiva; terminar forzosamente la tarea no garantiza que finalice el guardado de credenciales.

Docker continúa ejecutando la variante Linux sin cambios en sus comandos ni en sus volúmenes.

### Configuración local

El archivo [.env.example](.env.example) es exclusivo de esta modalidad. Las rutas relativas se resuelven desde el directorio de trabajo del proceso. Sin `.env` ni variables de entorno, el código usa `./data`, `./auth` y la zona horaria `UTC`; el ejemplo configura `America/Argentina/Buenos_Aires`. Las variables admitidas son:

- `WHATSAPP_READER_DATA_DIR`: directorio de datos.
- `WHATSAPP_READER_DB_PATH`: archivo SQLite.
- `WHATSAPP_READER_AUTH_DIR`: credenciales de la sesión vinculada.
- `WHATSAPP_READER_SEND_SOCKET`: dirección IPC para solicitar envíos. En Linux es una ruta de socket Unix. En Windows una ruta de archivo se convierte automáticamente en una named pipe estable, derivada de esa ruta absoluta y del directorio personal del usuario. También acepta una pipe local explícita como `\\.\pipe\whatsapp-reader-personal`. Si se omite o está vacía, se deriva de `DATA_DIR/send.sock`; las pipes explícitas son exclusivas de Windows.
- `WHATSAPP_READER_SEND_TIMEOUT_MS`: tiempo máximo de espera de una solicitud de envío.
- `WHATSAPP_READER_TIME_ZONE`: zona IANA para fechas `YYYY-MM-DD`.
- `WHATSAPP_READER_DEFAULT_LIMIT`: límite predeterminado de consultas.
- `WHATSAPP_READER_LOG_LEVEL`: nivel de log.
- `WHATSAPP_READER_MAX_RECONNECT_ATTEMPTS`: reintentos antes de detenerse.
- `WHATSAPP_READER_RECONNECT_BASE_MS`: base del backoff de reconexión.

`.env`, `auth/`, `data/`, bases y logs están excluidos de Git. En Linux el proceso usa permisos restrictivos. En Windows los archivos heredan las ACL de su carpeta: los modos Unix `0600`/`0700` no configuran esas ACL. Guarde el proyecto y los datos dentro de su perfil privado y revise **Propiedades > Seguridad** de `auth/` y `data/` para limitar el acceso a su usuario y las cuentas administrativas necesarias. La aplicación no modifica ACL existentes.

La pipe conserva los permisos predeterminados de Windows; el servidor no habilita `readableAll` ni `writableAll`. Ejecute ingestor y MCP bajo el mismo usuario y nivel de privilegios, sin elevarlos como administrador. El nombre derivado evita colisiones, pero no es un secreto ni un mecanismo de autenticación. Véase la [documentación IPC de Node.js](https://nodejs.org/api/net.html#ipc-support).

El respaldo escribe y sincroniza el archivo temporal antes de reemplazar el destino en ambos sistemas. En Linux también sincroniza el directorio; Windows omite esa operación POSIX, por lo que no ofrece la misma garantía de durabilidad del cambio de nombre frente a un corte eléctrico. El contenido sensible se redacta en los logs; mantenga el disco cifrado y con acceso limitado.

### Validación sin WhatsApp

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

### Primera vinculación local

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
5. Revise que los logs operativos no contengan contenido de mensajes ni credenciales. El QR se muestra explícitamente durante la vinculación y aparece en la salida del terminal.
6. Desde el cliente MCP, confirme y envíe un texto de prueba a la cuenta secundaria; compruebe el `message_id` devuelto y la recepción en el teléfono.

### MCP local

Compile antes de iniciarlo:

```bash
npm run build
npm run mcp
```

En esta modalidad, el cliente MCP debe lanzar `node` con la ruta absoluta a `dist/mcp.js`. Use el mismo directorio de trabajo y configuración que el ingestor o proporcione rutas absolutas mediante las variables `WHATSAPP_READER_*`, especialmente las de la base, el directorio de datos y el canal IPC.

### Prueba del MCP del contenedor desde el anfitrión

Esta prueba opcional requiere Node.js y las dependencias del proyecto instaladas en el anfitrión, además del contenedor en ejecución:

```bash
npm ci
npm run smoke:container
```

Comprueba la conexión MCP, el listado de herramientas y una consulta de chats; no envía mensajes. No es necesaria para iniciar ni usar la instalación Docker.

## Licencia

Este proyecto se distribuye bajo la [licencia MIT](LICENSE).
