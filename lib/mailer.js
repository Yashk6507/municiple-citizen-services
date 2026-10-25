/**
 * Brevo email integration.
 *
 * Outbound: alert emails are sent through the Brevo transactional email API
 * (https://api.brevo.com/v3/smtp/email). No SDK is required — Node's global
 * fetch is used, so there is no new dependency.
 *
 * Inbound: a municipal inbox can forward mail to the Brevo inbound webhook,
 * which routes/email.js exposes at POST /api/email/inbound. Parsing helpers
 * live here so the route stays thin.
 *
 * Honesty rule: an email is only ever recorded as "sent" when Brevo accepted
 * it. Without credentials the attempt is stored as "skipped" together with the
 * reason, so administrators can see exactly why no mail is leaving the system.
 */
const db = require("../db");

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const OUTBOUND_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
function config() {
  return {
    apiKey: String(process.env.BREVO_API_KEY || "").trim(),
    senderEmail: String(process.env.BREVO_SENDER_EMAIL || "").trim(),
    senderName: String(process.env.BREVO_SENDER_NAME || "Municipal Citizen Services").trim(),
    inboundSecret: String(process.env.BREVO_INBOUND_SECRET || "").trim(),
    supportInbox: String(process.env.SUPPORT_INBOX || "").trim(),
    publicBaseUrl: String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "")
  };
}

function isConfigured() {
  const cfg = config();
  return Boolean(cfg.apiKey && cfg.senderEmail);
}

/** Everything an administrator needs to know about the email integration. */
function configurationStatus() {
  const cfg = config();
  return {
    configured: isConfigured(),
    api_key_present: Boolean(cfg.apiKey),
    sender_email: cfg.senderEmail || null,
    sender_name: cfg.senderName,
    inbound_webhook_path: "/api/email/inbound",
    inbound_webhook_protected: Boolean(cfg.inboundSecret),
    support_inbox: cfg.supportInbox || null,
    portal_url: cfg.publicBaseUrl || null,
    missing: [
      cfg.apiKey ? null : "BREVO_API_KEY",
      cfg.senderEmail ? null : "BREVO_SENDER_EMAIL"
    ].filter(Boolean)
  };
}

/**
 * Reads an application setting directly from the database.
 * The mailer deliberately does not require lib/store (that module requires this
 * one), so settings are read here without creating a circular dependency.
 */
async function setting(key, fallback) {
  try {
    const row = await db.getAsync("SELECT value FROM app_settings WHERE key = ?", [key]);
    return row && row.value !== null && row.value !== undefined ? row.value : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
async function logEmail(entry) {
  try {
    const result = await db.runAsync(
      `INSERT INTO email_log
        (direction, status, provider_message_id, from_email, from_name, to_email,
         subject, body, complaint_id, user_id, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.direction || "outbound",
        entry.status || "queued",
        entry.providerMessageId || null,
        entry.fromEmail || null,
        entry.fromName || null,
        entry.toEmail || null,
        entry.subject || null,
        entry.body || null,
        entry.complaintId || null,
        entry.userId || null,
        entry.error || null
      ]
    );
    return result.lastID;
  } catch (err) {
    console.error("Failed to write email log:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A plain, accessible municipal-styled email. Deliberately simple so it renders
 * consistently in every mail client.
 */
function alertHtml({ heading, intro, rows, note, actionUrl, actionLabel }) {
  const detailRows = (rows || [])
    .map(
      (row) => `<tr>
        <td style="padding:6px 12px 6px 0;color:#516079;font-size:13px;white-space:nowrap;">${escapeHtml(
          row[0]
        )}</td>
        <td style="padding:6px 0;color:#10203a;font-size:13px;font-weight:600;">${escapeHtml(row[1])}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f2f5fa;">
  <div style="max-width:620px;margin:0 auto;padding:24px 16px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#0b3d91;color:#ffffff;padding:16px 20px;border-radius:8px 8px 0 0;">
      <div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.85;">Municipal Citizen Services</div>
      <div style="font-size:19px;font-weight:700;margin-top:4px;">${escapeHtml(heading)}</div>
    </div>
    <div style="background:#ffffff;border:1px solid #dde3ee;border-top:none;border-radius:0 0 8px 8px;padding:20px;">
      <p style="margin:0 0 14px;color:#10203a;font-size:14px;line-height:1.55;">${escapeHtml(intro)}</p>
      ${detailRows ? `<table style="border-collapse:collapse;margin-bottom:16px;">${detailRows}</table>` : ""}
      ${
        actionUrl
          ? `<p style="margin:0 0 16px;"><a href="${escapeHtml(actionUrl)}"
               style="display:inline-block;background:#f4b41a;color:#10203a;font-weight:700;font-size:14px;
                      text-decoration:none;padding:10px 18px;border-radius:6px;">${escapeHtml(
                        actionLabel || "Open the portal"
                      )}</a></p>`
          : ""
      }
      <p style="margin:0;color:#516079;font-size:12px;line-height:1.6;">${escapeHtml(
        note || "This is an automated message from the municipal complaint management system."
      )}</p>
    </div>
    <div style="height:6px;margin-top:10px;border-radius:3px;background:linear-gradient(90deg,#ff9933 33%,#ffffff 33%,#ffffff 66%,#138808 66%);border:1px solid #e2e7f0;"></div>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------
/**
 * Sends one email through Brevo and records the attempt.
 * Never throws: callers receive { ok, status, error, logId }.
 */
async function sendEmail({
  to,
  toName,
  subject,
  html,
  text,
  complaintId = null,
  userId = null,
  tags = [],
  replyTo = null
}) {
  const cfg = config();
  const plain = text || String(subject || "");

  if (!to) {
    return { ok: false, status: "skipped", error: "No recipient address" };
  }
  if (!isConfigured()) {
    const error = `Brevo is not configured (missing: ${configurationStatus().missing.join(", ") || "credentials"})`;
    const logId = await logEmail({
      status: "skipped",
      toEmail: to,
      subject,
      body: plain,
      complaintId,
      userId,
      error
    });
    return { ok: false, status: "skipped", error, logId };
  }

  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
    response = await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "api-key": cfg.apiKey
      },
      signal: controller.signal,
      body: JSON.stringify({
        sender: { email: cfg.senderEmail, name: cfg.senderName },
        to: [{ email: to, name: toName || to }],
        subject: String(subject || "").slice(0, 240),
        htmlContent: html || `<p>${escapeHtml(plain)}</p>`,
        textContent: plain,
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        ...(tags.length ? { tags: tags.map((t) => String(t).slice(0, 40)) } : {})
      })
    });
    clearTimeout(timer);
  } catch (err) {
    const error =
      err && err.name === "AbortError"
        ? `Brevo did not answer within ${OUTBOUND_TIMEOUT_MS / 1000}s`
        : `Could not reach Brevo: ${err.message}`;
    const logId = await logEmail({
      status: "failed",
      toEmail: to,
      subject,
      body: plain,
      complaintId,
      userId,
      error
    });
    return { ok: false, status: "failed", error, logId };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = payload && (payload.message || payload.error) ? ` – ${payload.message || payload.error}` : "";
    } catch {
      /* Brevo sometimes answers without a JSON body */
    }
    const error = `Brevo rejected the message (HTTP ${response.status})${detail}`;
    const logId = await logEmail({
      status: "failed",
      toEmail: to,
      subject,
      body: plain,
      complaintId,
      userId,
      error
    });
    return { ok: false, status: "failed", error, logId };
  }

  let messageId = null;
  try {
    const payload = await response.json();
    messageId = payload && payload.messageId ? payload.messageId : null;
  } catch {
    /* a 2xx without a body still means Brevo accepted the message */
  }

  const logId = await logEmail({
    status: "sent",
    providerMessageId: messageId,
    fromEmail: cfg.senderEmail,
    fromName: cfg.senderName,
    toEmail: to,
    subject,
    body: plain,
    complaintId,
    userId
  });
  return { ok: true, status: "sent", providerMessageId: messageId, logId };
}

/** The complaint context used to build alert subjects and links. */
async function complaintContext(complaintId) {
  if (!complaintId) return null;
  try {
    return await db.getAsync(
      `SELECT c.id, c.reference_no, c.title, c.status, c.priority, c.due_at,
              w.name AS ward_name, d.name AS department_name
       FROM complaints c
       LEFT JOIN wards w ON w.id = c.ward_id
       LEFT JOIN departments d ON d.id = c.department_id
       WHERE c.id = ?`,
      [complaintId]
    );
  } catch {
    return null;
  }
}

function portalUrl() {
  const base = config().publicBaseUrl;
  return base ? `${base}/#/dashboard` : null;
}

/**
 * Sends an alert email to the holder of a user account.
 *
 * Called from lib/store.notify() so every alert raised anywhere in the system
 * reaches the recipient's mailbox as well as their in-app notification list.
 * Returns { ok, status, error } and never throws.
 */
async function sendAlertEmail({ userId, complaintId = null, title, message, kind = "alert" }) {
  try {
    const enabled = (await setting("email_alerts_enabled", "1")) === "1";
    if (!enabled) return { ok: false, status: "skipped", error: "Email alerts are turned off in settings." };

    const user = await db.getAsync(
      "SELECT id, name, email, role FROM users WHERE id = ? AND is_active = 1",
      [userId]
    );
    if (!user || !user.email) {
      return { ok: false, status: "skipped", error: "The recipient has no email address" };
    }

    const complaint = await complaintContext(complaintId);
    const heading = title || "Municipal alert";
    const subject = complaint
      ? `[${complaint.reference_no}] ${heading}`
      : `[Municipal Citizen Services] ${heading}`;

    const rows = [];
    if (complaint) {
      rows.push(["Complaint", complaint.reference_no]);
      rows.push(["Subject", complaint.title || "—"]);
      rows.push(["Status", complaint.status || "—"]);
      rows.push(["Priority", complaint.priority || "—"]);
      if (complaint.department_name) rows.push(["Department", complaint.department_name]);
      if (complaint.ward_name) rows.push(["Ward", complaint.ward_name]);
      if (complaint.due_at) rows.push(["Internal target", new Date(complaint.due_at).toUTCString()]);
    }

    const isStaffRecipient = user.role === "staff" || user.role === "admin";
    const actionUrl = portalUrl();

    const html = alertHtml({
      heading,
      intro: `${message}`,
      rows,
      actionUrl,
      actionLabel: isStaffRecipient ? "Open the service desk" : "Track your complaint",
      note: isStaffRecipient
        ? "You are receiving this because you are a municipal officer responsible for this complaint. Sign in to the service desk to take action."
        : "You are receiving this because you filed this complaint. Sign in with the same email address to view updates and evidence."
    });

    const text = [
      heading,
      "",
      message,
      ...rows.map((row) => `${row[0]}: ${row[1]}`),
      "",
      actionUrl ? `Open: ${actionUrl}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    return await sendEmail({
      to: user.email,
      toName: user.name,
      subject,
      html,
      text,
      complaintId,
      userId: user.id,
      tags: [kind]
    });
  } catch (err) {
    console.error("Alert email failed:", err.message);
    return { ok: false, status: "failed", error: err.message };
  }
}

/**
 * Emails a department's configured contact address (e.g. on assignment).
 * Silently does nothing when the department has no address on file.
 */
async function sendDepartmentAlert({ departmentId, complaintId, heading, message, kind = "department" }) {
  try {
    if (!departmentId) return { ok: false, status: "skipped", error: "No department" };
    const department = await db.getAsync(
      "SELECT id, name, contact_email FROM departments WHERE id = ? AND is_active = 1",
      [departmentId]
    );
    if (!department || !department.contact_email) {
      return { ok: false, status: "skipped", error: "The department has no contact email configured" };
    }
    const complaint = await complaintContext(complaintId);
    const subject = complaint
      ? `[${complaint.reference_no}] ${heading}`
      : `[Municipal Citizen Services] ${heading}`;

    const rows = complaint
      ? [
          ["Complaint", complaint.reference_no],
          ["Subject", complaint.title || "—"],
          ["Status", complaint.status || "—"],
          ["Priority", complaint.priority || "—"],
          ["Ward", complaint.ward_name || "Not recorded"]
        ]
      : [];

    const html = alertHtml({
      heading,
      intro: message,
      rows,
      actionUrl: portalUrl(),
      actionLabel: "Open the service desk",
      note: `This alert was sent to ${department.name} because it is the department configured to handle this complaint.`
    });

    return await sendEmail({
      to: department.contact_email,
      toName: department.name,
      subject,
      html,
      text: [heading, "", message, ...rows.map((r) => `${r[0]}: ${r[1]}`)].join("\n"),
      complaintId,
      tags: [kind]
    });
  } catch (err) {
    console.error("Department alert email failed:", err.message);
    return { ok: false, status: "failed", error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook parsing (Brevo inbound parse)
// ---------------------------------------------------------------------------
function pickAddress(value) {
  if (!value) return null;
  if (typeof value === "string") return value.trim().toLowerCase() || null;
  if (Array.isArray(value)) return pickAddress(value[0]);
  if (typeof value === "object") {
    return pickAddress(value.Address || value.address || value.email || value.Email);
  }
  return null;
}

function pickName(value) {
  if (!value) return null;
  if (Array.isArray(value)) return pickName(value[0]);
  if (typeof value === "object") return value.Name || value.name || null;
  return null;
}

/** Collapses HTML to readable text without pulling in a parser dependency. */
function htmlToText(html) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Normalises a Brevo inbound payload into a list of simple messages.
 * Accepts both the documented { items: [...] } envelope and a bare object so
 * the webhook survives provider format changes and manual testing.
 */
function parseInboundPayload(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload && Array.isArray(payload.items)
      ? payload.items
      : payload && typeof payload === "object"
        ? [payload]
        : [];

  return items
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const body =
        item.RawTextBody ||
        item.rawTextBody ||
        item.ExtractedMarkdownMessage ||
        htmlToText(item.RawHtmlBody || item.rawHtmlBody) ||
        "";
      return {
        fromEmail: pickAddress(item.From || item.from) || pickAddress(item.Sender),
        fromName: pickName(item.From || item.from),
        toEmail: pickAddress(item.To || item.to),
        replyTo: pickAddress(item.ReplyTo || item.replyTo),
        subject: String(item.Subject || item.subject || "").slice(0, 240),
        body: String(body).slice(0, 8000),
        messageId: item.MessageId || item.messageId || null,
        sentAt: item.SentAtDate || item.sentAtDate || null,
        attachments: Array.isArray(item.Attachments || item.attachments)
          ? (item.Attachments || item.attachments).length
          : 0
      };
    })
    .filter(Boolean);
}

/** Extracts the first complaint/application reference number found in text. */
const REFERENCE_PATTERN = /\b(?:CMP|APP)-\d{4}-\d{4,8}\b/i;
function extractReference(text) {
  const match = String(text || "").match(REFERENCE_PATTERN);
  return match ? match[0].toUpperCase() : null;
}

module.exports = {
  config,
  isConfigured,
  configurationStatus,
  sendEmail,
  sendAlertEmail,
  sendDepartmentAlert,
  parseInboundPayload,
  extractReference,
  logEmail,
  escapeHtml,
  alertHtml,
  htmlToText,
  complaintContext
};
