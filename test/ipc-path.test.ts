import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSendSocketPath } from "../src/ipc-path.js";

describe("direcciones IPC por plataforma", () => {
  it("conserva las rutas de sockets Linux", () => {
    expect(resolveSendSocketPath(undefined, "/app/data", "linux")).toBe(path.resolve("/app/data/send.sock"));
    expect(resolveSendSocketPath("./custom.sock", "/app/data", "linux")).toBe(path.resolve("./custom.sock"));
  });

  it("genera pipes estables y separa instalaciones y usuarios en Windows", () => {
    const resolve = (data: string, home = "C:\\Users\\ana") => resolveSendSocketPath(undefined, data, "win32", home);
    const pipe = resolve("C:\\reader\\data");
    expect(pipe).toMatch(/^\\\\\.\\pipe\\whatsapp-reader-[a-f0-9]{32}$/);
    expect(resolve("c:\\READER\\data")).toBe(pipe);
    expect(resolve("C:\\reader2\\data")).not.toBe(pipe);
    expect(resolve("C:\\reader\\data", "C:\\Users\\otro")).not.toBe(pipe);
    expect(resolveSendSocketPath("C:\\reader\\data\\send.sock", "C:\\ignored", "win32", "C:\\Users\\ana")).toBe(pipe);
  });

  it("respeta pipes locales explícitas sin resolverlas como archivos", () => {
    const pipe = "\\\\.\\pipe\\reader-custom";
    expect(resolveSendSocketPath(pipe, "C:\\data", "win32")).toBe(pipe);
    expect(resolveSendSocketPath(resolveSendSocketPath(undefined, "C:\\data", "win32"), "C:\\other", "win32")).toBe(resolveSendSocketPath(undefined, "C:\\data", "win32"));
    expect(() => resolveSendSocketPath(pipe, "/app/data", "linux")).toThrow(/Windows/);
    expect(() => resolveSendSocketPath("\\\\remote\\pipe\\reader", "C:\\data", "win32")).toThrow(/local/);
    expect(() => resolveSendSocketPath("\\\\.\\pipe\\", "C:\\data", "win32")).toThrow(/nombre/);
  });
});
