/**
 * Tests — transactional emails in both languages
 *
 * This suite pins the transactional emails (the sign-in link, the two
 * project invitations, and the notice to an operator that a workspace's
 * stored scanner keys were erased) in English and Spanish, and the order
 * in which `chooseEmailLocale` picks an email's language. Resend is
 * mocked: each send is captured, and the assertions read the subject,
 * the HTML body and the `<html lang>` the helper handed to it. A send
 * Resend answers with an error fails the keys-erased notice, so its
 * caller can tell that no message went out; the other emails are left
 * as they were.
 *
 * Each email keeps the same structure in both languages: the same link
 * in the same place, and the same expiry. The values interpolated into
 * the HTML body (the inviter's name, the project name) are escaped;
 * the subject is plain text and carries them as they are.
 *
 * @version v0.9.0
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const sent: Array<{ from: string; to: string; subject: string; html: string }> =
  [];
/** When set, Resend answers every send with this error and no data, as it does for a rejected send. */
let rejectWith: { name: string; message: string; statusCode: number } | null = null;

vi.mock("resend", () => ({
  Resend: class {
    emails = {
      send: async (message: {
        from: string;
        to: string;
        subject: string;
        html: string;
      }) => {
        sent.push(message);
        if (rejectWith) return { data: null, error: rejectWith };
        return { data: { id: "test" }, error: null };
      },
    };
  },
}));

import {
  sendMagicLinkEmail,
  sendNewUserInviteEmail,
  sendExistingUserInviteEmail,
  sendScannerKeysErasedEmail,
} from "../../app/lib/email.server";
import { chooseEmailLocale } from "../../app/lib/email-locale.server";

const APP_CONFIG = { appName: "Fisqua", senderEmail: "noreply@example.test" };
const LINK = "https://ws.fisqua.test/auth/verify?token=abc";

describe("chooseEmailLocale", () => {
  it("prefers the recipient's saved locale over everything else", () => {
    expect(
      chooseEmailLocale({
        userLocale: "en",
        workspaceLocale: "es",
        requestLocale: "es",
      }),
    ).toBe("en");
  });

  it("falls back to the workspace default when the recipient has none", () => {
    expect(
      chooseEmailLocale({
        userLocale: null,
        workspaceLocale: "en",
        requestLocale: "es",
      }),
    ).toBe("en");
  });

  it("falls back to the request language when the workspace sets none", () => {
    expect(
      chooseEmailLocale({
        userLocale: null,
        workspaceLocale: null,
        requestLocale: "en",
      }),
    ).toBe("en");
  });

  it("falls back to Spanish when no source names a language", () => {
    expect(chooseEmailLocale({})).toBe("es");
    expect(
      chooseEmailLocale({
        userLocale: null,
        workspaceLocale: null,
        requestLocale: null,
      }),
    ).toBe("es");
  });

  it("skips an unsupported value", () => {
    expect(
      chooseEmailLocale({ userLocale: "fr", requestLocale: "en" }),
    ).toBe("en");
  });
});

describe("transactional emails", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("sends the sign-in link in English", async () => {
    await sendMagicLinkEmail("key", "a@example.test", LINK, APP_CONFIG, "en");
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toBe("a@example.test");
    expect(mail.from).toBe("Fisqua <noreply@example.test>");
    expect(mail.subject).toBe("Your Fisqua login link");
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain("Click the link below to log in to Fisqua:");
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/auth/verify?token=abc">Log in to Fisqua</a>',
    );
    expect(mail.html).toContain(
      "This link expires in 15 minutes. If you did not request this, you can safely ignore this email.",
    );
  });

  it("sends the sign-in link in Spanish", async () => {
    await sendMagicLinkEmail("key", "a@example.test", LINK, APP_CONFIG, "es");
    const [mail] = sent;
    expect(mail.subject).toBe("Tu enlace de acceso a Fisqua");
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.html).toContain(
      "Haz clic en el siguiente enlace para iniciar sesión en Fisqua:",
    );
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/auth/verify?token=abc">Iniciar sesión en Fisqua</a>',
    );
    expect(mail.html).toContain(
      "Este enlace vence en 15 minutos. Si no lo pediste, puedes ignorar este correo sin problema.",
    );
  });

  it("sends the new-user invitation in English", async () => {
    await sendNewUserInviteEmail(
      "key",
      "b@example.test",
      "Ana",
      "Notarial records",
      "https://ws.fisqua.test/invite/accept?token=t1",
      APP_CONFIG,
      "en",
    );
    const [mail] = sent;
    expect(mail.subject).toBe("Ana invited you to Notarial records on Fisqua");
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain(
      "Ana has invited you to join the project <strong>Notarial records</strong> on Fisqua.",
    );
    expect(mail.html).toContain(
      "Click the link below to accept the invitation and log in:",
    );
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/invite/accept?token=t1">Accept invitation</a>',
    );
    expect(mail.html).toContain("This link expires in 7 days.");
  });

  it("sends the new-user invitation in Spanish", async () => {
    await sendNewUserInviteEmail(
      "key",
      "b@example.test",
      "Ana",
      "Protocolos notariales",
      "https://ws.fisqua.test/invite/accept?token=t1",
      APP_CONFIG,
      "es",
    );
    const [mail] = sent;
    expect(mail.subject).toBe(
      "Ana te invitó al proyecto Protocolos notariales en Fisqua",
    );
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.html).toContain(
      "Ana te invitó a unirte al proyecto <strong>Protocolos notariales</strong> en Fisqua.",
    );
    expect(mail.html).toContain(
      "Haz clic en el siguiente enlace para aceptar la invitación e iniciar sesión:",
    );
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/invite/accept?token=t1">Aceptar invitación</a>',
    );
    expect(mail.html).toContain("Este enlace vence en 7 días.");
  });

  it("sends the existing-user notice in English", async () => {
    await sendExistingUserInviteEmail(
      "key",
      "c@example.test",
      "Ana",
      "Notarial records",
      "https://ws.fisqua.test/projects/p1",
      APP_CONFIG,
      "en",
    );
    const [mail] = sent;
    expect(mail.subject).toBe("You were added to Notarial records on Fisqua");
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain(
      "Ana has added you to the project <strong>Notarial records</strong> on Fisqua.",
    );
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/projects/p1">Go to project</a>',
    );
  });

  it("sends the existing-user notice in Spanish", async () => {
    await sendExistingUserInviteEmail(
      "key",
      "c@example.test",
      "Ana",
      "Protocolos notariales",
      "https://ws.fisqua.test/projects/p1",
      APP_CONFIG,
      "es",
    );
    const [mail] = sent;
    expect(mail.subject).toBe("Te agregaron al proyecto Protocolos notariales en Fisqua");
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.html).toContain(
      "Ana te agregó al proyecto <strong>Protocolos notariales</strong> en Fisqua.",
    );
    expect(mail.html).toContain(
      '<a href="https://ws.fisqua.test/projects/p1">Ir al proyecto</a>',
    );
  });

  const ERASED = {
    workspace: "Test Archive",
    slug: "test-archive",
    erased: true,
    keys: [{ write: "fisqua-test-archive-appliance-rig-1", read: "fisqua-test-archive-appliance-rig-1-read" }],
  };

  it("sends the keys-erased notice in English, with the workspace and both key names", async () => {
    await sendScannerKeysErasedEmail("key", "op@example.test", ERASED, APP_CONFIG, "en");
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toBe("op@example.test");
    expect(mail.subject).toBe("Revoke the scanner keys of Test Archive in Backblaze B2");
    expect(mail.html).toContain('<html lang="en">');
    expect(mail.html).toContain(
      "Fisqua has erased its copy of the scanner keys of the workspace Test Archive (test-archive).",
    );
    expect(mail.html).toContain(
      "Revoke every key listed below in Backblaze B2. Fisqua erased only its own copy, so the keys work until you revoke them there:",
    );
    expect(mail.html).toContain("Upload key: <code>fisqua-test-archive-appliance-rig-1</code>");
    expect(mail.html).toContain("Read key: <code>fisqua-test-archive-appliance-rig-1-read</code>");
    expect(mail.html).toContain("No unit can be paired with this workspace until new keys are stored for it.");
  });

  it("sends the keys-erased notice in Spanish", async () => {
    await sendScannerKeysErasedEmail("key", "op@example.test", ERASED, APP_CONFIG, "es");
    const [mail] = sent;
    expect(mail.subject).toBe("Revoca en Backblaze B2 las claves del escáner de Test Archive");
    expect(mail.html).toContain('<html lang="es">');
    expect(mail.html).toContain(
      "Fisqua borró la copia que guardaba de las claves del escáner del espacio de trabajo Test Archive (test-archive).",
    );
    expect(mail.html).toContain("Clave de carga: <code>fisqua-test-archive-appliance-rig-1</code>");
    expect(mail.html).toContain("Clave de lectura: <code>fisqua-test-archive-appliance-rig-1-read</code>");
  });

  it("says Fisqua held no stored copy, and lists every pair, when nothing was erased", async () => {
    const pairs = [
      ...ERASED.keys,
      { write: "fisqua-test-archive-appliance-rig-2", read: "fisqua-test-archive-appliance-rig-2-read" },
    ];
    await sendScannerKeysErasedEmail("key", "op@example.test", { ...ERASED, erased: false, keys: pairs }, APP_CONFIG, "en");
    const [mail] = sent;
    expect(mail.html).toContain(
      "A unit of the workspace Test Archive (test-archive) was reported lost, stolen or compromised. Fisqua held no stored copy of its scanner keys, so it erased nothing.",
    );
    expect(mail.html).toContain("Revoke every key listed below in Backblaze B2. The keys work until you revoke them there:");
    expect(mail.html).not.toContain("has erased its copy");
    for (const pair of pairs) {
      expect(mail.html).toContain(`Upload key: <code>${pair.write}</code>`);
      expect(mail.html).toContain(`Read key: <code>${pair.read}</code>`);
    }
    await sendScannerKeysErasedEmail("key", "op@example.test", { ...ERASED, erased: false }, APP_CONFIG, "es");
    expect(sent[1].html).toContain("no guardaba ninguna copia de las claves del escáner, así que no borró nada.");
  });

  it("fails the keys-erased notice when Resend answers with an error, and leaves the other emails as they were", async () => {
    rejectWith = { name: "rate_limit_exceeded", message: "Too many requests", statusCode: 429 };
    try {
      await expect(sendScannerKeysErasedEmail("key", "op@example.test", ERASED, APP_CONFIG, "en")).rejects.toThrow();
      await expect(sendMagicLinkEmail("key", "a@example.test", LINK, APP_CONFIG, "en")).resolves.toBeUndefined();
    } finally {
      rejectWith = null;
    }
  });

  it("escapes the workspace name in the keys-erased notice", async () => {
    await sendScannerKeysErasedEmail("key", "op@example.test", { ...ERASED, workspace: "A & B <i>" }, APP_CONFIG, "en");
    const [mail] = sent;
    expect(mail.subject).toBe("Revoke the scanner keys of A & B <i> in Backblaze B2");
    expect(mail.html).not.toContain("<i>");
    expect(mail.html).toContain("A &amp; B &lt;i&gt; (test-archive)");
  });

  it("escapes the inviter and project names in the body", async () => {
    await sendNewUserInviteEmail(
      "key",
      "d@example.test",
      "<b>Eve</b>",
      "A & B <script>",
      "https://ws.fisqua.test/invite/accept?token=t2",
      APP_CONFIG,
      "en",
    );
    const [mail] = sent;
    expect(mail.html).not.toContain("<b>Eve</b>");
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;b&gt;Eve&lt;/b&gt;");
    expect(mail.html).toContain("<strong>A &amp; B &lt;script&gt;</strong>");
  });
});

// @version v0.9.0
