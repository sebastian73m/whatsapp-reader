import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

type CredentialSnapshot = {
  registered?: unknown;
  me?: { id?: unknown } | null;
  account?: unknown;
};

type ReadResult =
  | { status: "missing" }
  | { status: "invalid"; error: Error }
  | { status: "valid"; raw: string; value: CredentialSnapshot };

export type CredentialRecovery = "current" | "restored" | "unlinked" | "missing";

export function isSessionLinked(creds: CredentialSnapshot): boolean {
  return creds.registered === true || (
    typeof creds.me?.id === "string"
    && creds.me.id.length > 0
    && creds.account !== undefined
    && creds.account !== null
  );
}

async function readSnapshot(filename: string): Promise<ReadResult> {
  try {
    const raw = await readFile(filename, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { status: "invalid", error: new Error(`${filename} no contiene un objeto JSON`) };
    }
    return { status: "valid", raw, value: parsed as CredentialSnapshot };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "invalid", error: error instanceof Error ? error : new Error("Credenciales inválidas") };
  }
}

async function atomicWrite(filename: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);

    // Persistir también la operación de rename frente a un corte abrupto.
    const directory = await open(path.dirname(filename), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function restoreCredentialBackup(authDir: string): Promise<CredentialRecovery> {
  const currentPath = path.join(authDir, "creds.json");
  const backupPath = path.join(authDir, "creds.backup.json");
  const current = await readSnapshot(currentPath);

  if (current.status === "valid") {
    return isSessionLinked(current.value) ? "current" : "unlinked";
  }

  const backup = await readSnapshot(backupPath);
  if (backup.status === "valid" && isSessionLinked(backup.value)) {
    await atomicWrite(currentPath, backup.raw);
    return "restored";
  }

  if (current.status === "invalid") {
    throw new Error(`creds.json está dañado y no existe un backup de sesión válido: ${current.error.message}`);
  }
  return "missing";
}

export async function backupCredentials(authDir: string): Promise<boolean> {
  const currentPath = path.join(authDir, "creds.json");
  const current = await readSnapshot(currentPath);
  if (current.status !== "valid" || !isSessionLinked(current.value)) return false;
  await atomicWrite(path.join(authDir, "creds.backup.json"), current.raw);
  return true;
}
