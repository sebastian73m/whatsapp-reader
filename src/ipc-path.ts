import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const PIPE_PREFIX = "\\\\.\\pipe\\";

/** Las rutas existentes de .env siguen identificando el mismo canal en Windows. */
export function resolveSendSocketPath(
  value: string | undefined,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = os.homedir(),
): string {
  const configured = value || undefined;
  if (configured?.startsWith(PIPE_PREFIX)) {
    if (platform !== "win32") throw new Error("Las named pipes requieren Windows");
    if (!/^[a-zA-Z0-9_.-]{1,180}$/.test(configured.slice(PIPE_PREFIX.length))) {
      throw new Error("El nombre de la pipe debe contener solo letras, números, puntos, guiones o guiones bajos");
    }
    return configured;
  }
  if (platform !== "win32") return path.resolve(configured ?? path.join(dataDir, "send.sock"));
  if (configured && /^[\\/]{2}/.test(configured)) {
    throw new Error("El IPC debe usar una pipe local o una ruta de disco local");
  }
  const filename = path.win32.resolve(configured ?? path.win32.join(dataDir, "send.sock"));
  // Evita colisiones entre instalaciones y usuarios, sin publicar rutas personales.
  const identity = `${path.win32.normalize(userHome).toLowerCase()}\n${filename.toLowerCase()}`;
  const id = createHash("sha256").update(identity).digest("hex").slice(0, 32);
  return `${PIPE_PREFIX}whatsapp-reader-${id}`;
}
