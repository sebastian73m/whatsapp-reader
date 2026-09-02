import { describe, expect, it } from "vitest";
import { parseRange } from "../src/dates.js";

describe("parseRange", () => {
  it("interpreta fechas sin hora en la zona configurada e incluye todo el día final", () => {
    expect(parseRange("2026-09-02", "2026-09-02", "America/Argentina/Buenos_Aires")).toEqual({
      fromMs: Date.parse("2026-09-02T03:00:00.000Z"),
      toExclusiveMs: Date.parse("2026-09-03T03:00:00.000Z"),
    });
  });

  it("respeta días de 23 horas durante un cambio de horario", () => {
    const range = parseRange("2026-03-08", "2026-03-08", "America/New_York");
    expect(range.toExclusiveMs! - range.fromMs!).toBe(23 * 60 * 60 * 1000);
  });

  it("acepta fecha-hora con offset y hace inclusivo el extremo final", () => {
    expect(parseRange("2026-09-02T10:00:00-03:00", "2026-09-02T11:00:00-03:00", "UTC")).toEqual({
      fromMs: Date.parse("2026-09-02T13:00:00.000Z"),
      toExclusiveMs: Date.parse("2026-09-02T14:00:00.000Z") + 1,
    });
  });

  it.each([
    ["2026-02-30", undefined, "Fecha calendario inválida"],
    ["2026-09-02T10:00:00", undefined, "Incluya Z o un offset"],
    ["2026-09-03", "2026-09-02", "from_date debe ser anterior"],
  ])("rechaza rangos inválidos", (fromDate, toDate, message) => {
    expect(() => parseRange(fromDate, toDate, "UTC")).toThrow(message);
  });
});
