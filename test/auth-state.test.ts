import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupCredentials, isSessionLinked, restoreCredentialBackup } from "../src/auth-state.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-reader-auth-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function linkedCredentials(): Record<string, unknown> {
  return { registered: false, me: { id: "user@s.whatsapp.net" }, account: { details: "fixture" } };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("isSessionLinked", () => {
  it("reconoce sesiones QR de Baileys 7 aunque registered siga en false", () => {
    expect(isSessionLinked(linkedCredentials())).toBe(true);
  });

  it("no confunde credenciales iniciales con una sesión vinculada", () => {
    expect(isSessionLinked({ registered: false })).toBe(false);
  });
});

describe("backup de credenciales", () => {
  it("crea un backup atómico solo después de una vinculación", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "creds.json"), JSON.stringify(linkedCredentials()));

    await expect(backupCredentials(directory)).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "creds.backup.json"), "utf8"))).toEqual(linkedCredentials());
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(directory, "creds.backup.json")).mode & 0o777).toBe(0o600);
    }
  });

  it("reemplaza un backup existente y no deja temporales", async () => {
    const directory = temporaryDirectory();
    const current = path.join(directory, "creds.json");
    fs.writeFileSync(current, JSON.stringify(linkedCredentials()));
    await backupCredentials(directory);
    const updated = { ...linkedCredentials(), nextPreKeyId: 42 };
    fs.writeFileSync(current, JSON.stringify(updated));
    await expect(backupCredentials(directory)).resolves.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "creds.backup.json"), "utf8"))).toEqual(updated);
    expect(fs.readdirSync(directory).sort()).toEqual(["creds.backup.json", "creds.json"]);
  });

  it("restaura creds.json desde el backup si una escritura quedó corrupta", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "creds.json"), "{incompleto");
    fs.writeFileSync(path.join(directory, "creds.backup.json"), JSON.stringify(linkedCredentials()));

    await expect(restoreCredentialBackup(directory)).resolves.toBe("restored");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "creds.json"), "utf8"))).toEqual(linkedCredentials());
  });

  it("no revive una sesión anterior cuando el estado actual es un logout válido", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "creds.json"), JSON.stringify({ registered: false }));
    fs.writeFileSync(path.join(directory, "creds.backup.json"), JSON.stringify(linkedCredentials()));

    await expect(restoreCredentialBackup(directory)).resolves.toBe("unlinked");
    expect(JSON.parse(fs.readFileSync(path.join(directory, "creds.json"), "utf8"))).toEqual({ registered: false });
  });

  it("falla de forma segura si creds.json está dañado y no hay backup", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "creds.json"), "{incompleto");

    await expect(restoreCredentialBackup(directory)).rejects.toThrow(/está dañado/);
  });
});
