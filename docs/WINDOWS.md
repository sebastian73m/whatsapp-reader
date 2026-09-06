# Windows nativo: instalación y operación

Use Node.js 22 o 24 para Windows. No se necesita WSL ni Docker. Instale las dependencias en Windows con `npm.cmd ci`; no copie `node_modules` desde Linux. Si no hay un binario de `better-sqlite3` para su combinación de Node y arquitectura, instale Python y Visual Studio Build Tools con C++ y repita `npm.cmd ci`.

## Código y runtime separados

Ejemplo con código en `C:\Users\Ana\proyectos\whatsapp-reader` y estado persistente en `C:\Users\Ana\proyectos\whatsapp-reader-runtime`. Sustituya Ana por su usuario. El runtime contiene credenciales privadas y mensajes; no debe estar en Git ni en una carpeta compartida o sincronizada con la nube.

Desde PowerShell:

```powershell
$repo = Join-Path $HOME 'proyectos\whatsapp-reader'
$runtime = Join-Path $HOME 'proyectos\whatsapp-reader-runtime'
Set-Location $repo
npm.cmd ci
npm.cmd run check
New-Item -ItemType Directory -Force $runtime | Out-Null
```

Antes de crear datos, limite las ACL del runtime. Este ejemplo es para una carpeta nueva: otorga control al usuario actual, SYSTEM y administradores y retira la herencia. En una carpeta existente revise también las concesiones explícitas antiguas; `/grant:r` no elimina las de otras identidades.

```powershell
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls.exe $runtime /grant:r "*${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F'
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron asignar los permisos' }
icacls.exe $runtime /inheritance:r
if ($LASTEXITCODE -ne 0) { throw 'No se pudo retirar la herencia' }
icacls.exe $runtime
(Get-Acl -LiteralPath $runtime).Access | Format-Table IdentityReference, FileSystemRights, IsInherited
```

Compruebe que no haya acceso concedido a usuarios ajenos. Los archivos nuevos heredan estas ACL. La aplicación no modifica ACL y `chmod 0600` no equivale a limitar usuarios en Windows. Si el runtime ya contiene archivos, revise sus ACL individualmente antes de dar por protegidos los datos. Mantenga cifrado el disco y los respaldos.

Cree `$runtime\.env` con este contenido, ajustando las rutas. No sobrescriba una configuración existente:

```dotenv
WHATSAPP_READER_DATA_DIR=C:/Users/Ana/proyectos/whatsapp-reader-runtime/data
WHATSAPP_READER_DB_PATH=C:/Users/Ana/proyectos/whatsapp-reader-runtime/data/whatsapp.sqlite
WHATSAPP_READER_AUTH_DIR=C:/Users/Ana/proyectos/whatsapp-reader-runtime/auth
WHATSAPP_READER_SEND_SOCKET=C:/Users/Ana/proyectos/whatsapp-reader-runtime/data/send.sock
WHATSAPP_READER_TIME_ZONE=America/Argentina/Buenos_Aires
```

Para primera vinculación, después de comprobar las ACL:

```powershell
Set-Location $runtime
node.exe "$repo\dist\migrate.js"
node.exe "$repo\dist\ingest.js"
```

Escanee el QR en **WhatsApp > Dispositivos vinculados**. Mantenga esta consola abierta. `Ctrl+C` solicita un cierre que espera las escrituras de credenciales y cierra SQLite. No use `taskkill /F`, `Stop-Process` ni cierre la ventana para un apagado normal. No ejecute otra copia contra la misma sesión, incluso si cambia el nombre de la pipe.

## IPC y cliente MCP

En Linux se mantiene el socket Unix. En Windows servidor y cliente convierten una ruta como `data/send.sock` en una named pipe local estable, derivada de la ruta absoluta y del directorio personal. Una pipe ya normalizada se conserva. También puede configurar `\\.\pipe\whatsapp-reader-personal` explícitamente en ambos procesos. No se crea ni elimina un archivo de socket en Windows, ni se publica un puerto TCP.

La pipe usa los permisos predeterminados de Windows; no se habilita acceso global con `readableAll` o `writableAll`. El nombre no es una contraseña. Ejecute ambos procesos con el mismo usuario y sin elevación. El segundo servidor que intenta ocupar el mismo canal falla; esto no impide que una configuración distinta intente usar las mismas credenciales. Mantenga una sola instancia operativa. Consulte [IPC de Node.js](https://nodejs.org/api/net.html#ipc-support) y [seguridad de named pipes de Microsoft](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights).

El cliente MCP lanza un proceso por `stdio`. Ejemplo de configuración (ajuste las rutas y el esquema a su cliente):

```json
{
  "mcpServers": {
    "whatsapp-reader": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\Users\\Ana\\proyectos\\whatsapp-reader\\dist\\mcp.js"],
      "env": {
        "DOTENV_CONFIG_PATH": "C:/Users/Ana/proyectos/whatsapp-reader-runtime/.env"
      }
    }
  }
}
```

`DOTENV_CONFIG_PATH` carga el mismo archivo aunque el cliente arranque desde otra carpeta. Retire variables `WHATSAPP_READER_*` antiguas del entorno del cliente: las variables ya definidas prevalecen sobre `.env`. El MCP no necesita las credenciales de `auth/` para consultar o solicitar envíos. No coloque comandos de log, banners o un terminal interactivo delante del servidor MCP.

## Arranque al iniciar sesión

Use el Programador de tareas con una tarea bajo el mismo usuario, **Ejecutar solo cuando el usuario haya iniciado sesión**, sin privilegios elevados. Para conservar una consola desde la que cerrar limpiamente:

- Desencadenador: al iniciar sesión de ese usuario.
- Programa: `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`.
- Argumentos: `-NoProfile -NoExit -Command "& 'C:\Program Files\nodejs\node.exe' 'C:\Users\Ana\proyectos\whatsapp-reader\dist\ingest.js'"`.
- **Iniciar en**: `C:\Users\Ana\proyectos\whatsapp-reader-runtime`.
- Si ya está en ejecución: **No iniciar una nueva instancia**. Desactive el límite de duración si debe permanecer activo.

Compruebe previamente desde una tarea temporal con la misma identidad y directorio que `Test-Path` encuentra el runtime, su `.env` y `dist/ingest.js`. Use una ruta accesible desde esa sesión. En un despliegue observado, una tarea no veía un runtime creado bajo AppData desde otra sesión de herramientas; eso no implica que AppData sea incompatible en general.

Detenga primero la ejecución manual con `Ctrl+C`, espere a que termine Node y pruebe la tarea. Compruebe la reconexión sin QR y una consulta MCP. Para mantenimiento, pulse `Ctrl+C` en la consola de la tarea y espere al prompt de PowerShell antes de cerrarla. El botón **Finalizar** del Programador no garantiza cierre limpio. No configure reinicios de la tarea mientras realiza un respaldo o una restauración.

## Respaldo, restauración y actualización

SQLite usa WAL. Para un respaldo conjunto y sencillo:

1. Deshabilite temporalmente el arranque automático, cierre clientes MCP y detenga el ingestor con `Ctrl+C`. Espere la salida de Node.
2. Copie el runtime completo a un destino protegido: `.env`, `auth/`, `data/`, incluyendo cualquier archivo `whatsapp.sqlite-wal` y `whatsapp.sqlite-shm` presente. Con los procesos detenidos esos archivos no cambian. No copie solo `.sqlite` con el ingestor activo.
3. Verifique los archivos copiados y las ACL del destino. Vuelva a iniciar una única instancia y reactive la tarea.

La API de backup de SQLite permite una copia coherente de la base en funcionamiento, pero no incluye `auth/`; para un respaldo conjunto de sesión y base use la parada anterior. Consulte la [documentación de backup de SQLite](https://sqlite.org/backup.html).

Para restaurar, detenga todos los procesos y conserve el runtime actual como respaldo. Restaure la copia completa en una carpeta vacía y protegida: no mezcle una base restaurada con archivos WAL de otra ejecución. Ajuste las rutas de `.env` y del cliente si cambió la ubicación; revise las ACL después de copiar. Arranque solo una instancia y compruebe consultas y reconexión. Una sesión revocada por WhatsApp requiere vinculación nueva; no se fuerza su recuperación.

El respaldo interno `creds.backup.json` solo recupera `creds.json` ausente o corrupto; no sustituye la copia de todo `auth/`. En ambas plataformas se sincroniza el archivo temporal antes de reemplazar el destino. Solo Linux sincroniza también el directorio: Windows omite esa operación que produce EPERM y no ofrece la misma garantía de durabilidad del cambio de nombre ante un corte eléctrico.

Para actualizar código: detenga la tarea y el ingestor, respalde el runtime, ejecute `git pull --ff-only`, `npm.cmd ci` y `npm.cmd run check` desde el repositorio, y después `node.exe "$repo\dist\migrate.js"` desde el runtime. Reinicie una sola instancia y reconecte el cliente MCP. No copie ni publique bases, credenciales, QR o logs personales al repositorio.

## Alcance de la validación

`npm run check` comprueba pruebas, tipos, compilación y un cliente MCP real desde otro directorio con un ejecutable cuyo nombre contiene espacios y `#`. El envío es simulado. La matriz CI cubre Windows y Ubuntu con Node.js 22 y 24, incluyendo normalización, exclusión de un segundo servidor y reinicio del mismo canal. Las aserciones de permisos POSIX solo se ejecutan en POSIX; la revisión de ACL de la instalación es separada.

La evidencia aportada de un despliegue Windows con Node.js 22.23.2 sobre la base `57f62f5` y adaptaciones locales registró 28 pruebas, tipos, build, smoke MCP, cuatro consultas reales desde otro directorio y reconexión de la sesión sin QR después de reiniciar. No se envió texto real. Esa evidencia corresponde a aquella adaptación local; no sustituye los resultados CI del commit publicado ni una prueba de vinculación de este código en su equipo.
