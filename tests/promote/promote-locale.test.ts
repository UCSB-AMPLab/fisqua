/**
 * Tests — promote locale strings
 *
 * This suite pins the wording of the promote namespace that a test
 * elsewhere does not see: the refusal shown when the workspace has no
 * place to store manifests names the next step (contacting the Fisqua
 * team) in both languages; the promote button and the child-entry count
 * take the singular for one and the plural otherwise, rendered through
 * i18next as the page does; and the Spanish bundle addresses the reader
 * as tú and calls child entries «entradas hijas», without the usted
 * imperatives or the "exitosamente", "mapeados" and "subentradas"
 * wording it used to carry.
 *
 * @version v0.8.0
 */
import { describe, it, expect } from "vitest";
import i18next from "i18next";
import en from "../../app/locales/en/promote";
import es from "../../app/locales/es/promote";

function leaves(obj: Record<string, unknown>): string[] {
  return Object.values(obj).flatMap((v) =>
    typeof v === "object" && v !== null ? leaves(v as Record<string, unknown>) : [String(v)],
  );
}

describe("promote locale", () => {
  it("tells the superadmin to contact the Fisqua team when manifests have nowhere to go", () => {
    expect(en.error.tenant_destination_unset).toBe(
      "Entries can't be promoted: this workspace doesn't have a place to store manifests yet. Contact the Fisqua team to set it up.",
    );
    expect(es.error.tenant_destination_unset).toContain("este espacio de trabajo");
    expect(es.error.tenant_destination_unset).toContain("equipo de Fisqua");
  });

  it("addresses the reader informally in Spanish, in plain wording", () => {
    const text = leaves(es).join("\n");
    for (const form of [
      /\busted\b/i, /\bImporte\b/, /\bSeleccione\b/, /\bIntente\b/, /\bContacte\b/, /exitosamente/, /mapead/, /subentrada/i,
    ]) {
      expect(text).not.toMatch(form);
    }
  });

  it("takes the singular for one entry and the plural otherwise", async () => {
    const inst = i18next.createInstance();
    await (inst.init as (opts: unknown) => Promise<unknown>)({
      lng: "en",
      defaultNS: "promote",
      resources: { en: { promote: en }, es: { promote: es } },
      interpolation: { escapeValue: false },
    });
    const t = (lng: string, key: string, count: number) => inst.getFixedT(lng, "promote")(key, { count });
    expect(t("en", "action.promote", 1)).toBe("Promote 1 entry");
    expect(t("en", "action.promote", 3)).toBe("Promote 3 entries");
    expect(t("en", "table.children", 1)).toBe("1 sub-entry");
    expect(t("en", "table.children", 0)).toBe("0 sub-entries");
    expect(t("es", "action.promote", 1)).toBe("Promover 1 entrada");
    expect(t("es", "action.promote", 3)).toBe("Promover 3 entradas");
    expect(t("es", "table.children", 1)).toBe("1 entrada hija");
    expect(t("es", "table.children", 4)).toBe("4 entradas hijas");
  });
});
