/**
 * Email alerts (Brevo integration).
 *
 * Outbound: every alert raised through lib/store.notify() is mirrored by email.
 * This router exposes the configuration status, the delivery log, a test send
 * and an administrator-triggered alert for a specific complaint.
 *
 * Inbound: POST /api/email/inbound is the Brevo inbound-parse webhook. A
 * municipal mailbox can forward citizen replies there; matching replies are
 * attached to the complaint as a citizen-visible message and the responsible
 * officer plus all administrators are alerted.
 */
const express = require("express");

const { asyncHandler, requireAdmin } = require("../middleware");
const { all, get, run, audit, notify, addNote, touchComplaint } = require("../lib/store");
const { sanitizeText, parsePagination } = require("../lib/civic");
const mailer = require("../lib/mailer");

const router = express.Router();

// ---------------------------------------------------------------------------
// Inbound webhook — Brevo inbound parse
// ---------------------------------------------------------------------------
/**
 * Verifies the shared secret configured in BREVO_INBOUND_SECRET.
 * When no secret is configured the webhook stays open so the integration can
 * be set up, but the public status endpoint reports it as unprotected.
 */
function inboundAuthorised(req) {
  const cfg = mailer.config();
  if (!cfg.inboundSecret) return true;
  const supplied =
    String(req.query.token || "") ||
    String(req.headers["x-webhook-token"] || "") ||
    String((req.body && req.body.token) || "");
  return supplied === cfg.inboundSecret;
}

async function notifyAdministrators(complaintId, title, message) {
  const admins = await all("SELECT id FROM users WHERE role = 'admin' AND is_active = 1");
  for (const admin of admins) {
    await notify(admin.id, complaintId, "email_received", title, message);
  }
}

router.post(
  "/inbound",
  express.json({ limit: "12mb" }),
  asyncHandler(async (req, res) => {
    if (!inboundAuthorised(req)) {
      return res.status(401).json({ error: "Invalid inbound webhook token" });
    }

    const messages = mailer.parseInboundPayload(req.body).slice(0, 20);
    if (!messages.length) {
      return res.status(400).json({ error: "No inbound messages were found in the payload" });
    }

    const handled = [];

    for (const message of messages) {
      // The message is recorded first so nothing is lost, even if matching fails.
      const logId = await mailer.logEmail({
        direction: "inbound",
        status: "received",
        providerMessageId: message.messageId,
        fromEmail: message.fromEmail,
        fromName: message.fromName,
        toEmail: message.toEmail,
        subject: message.subject,
        body: message.body
      });

      const reference = mailer.extractReference(`${message.subject} ${message.body}`);
      let complaint = null;

      if (reference) {
        complaint = await get(
          `SELECT c.id, c.reference_no, c.title, c.user_id, c.assigned_user_id,
                  c.contact_email, u.email AS owner_email
           FROM complaints c
           LEFT JOIN users u ON u.id = c.user_id
           WHERE UPPER(c.reference_no) = UPPER(?)`,
          [reference]
        );
      }

      // A reply is only attached to a complaint when the sender is provably the
      // citizen who filed it (owning account or the contact address on file).
      const sender = message.fromEmail;
      const trusted =
        complaint &&
        sender &&
        ((complaint.owner_email && complaint.owner_email.toLowerCase() === sender) ||
          (complaint.contact_email && complaint.contact_email.toLowerCase() === sender));

      if (trusted) {
        await addNote({
          complaintId: complaint.id,
          author: { name: `Citizen email (${sender})` },
          visibility: "citizen",
          note: sanitizeText(message.body, 3000) || "(empty message)"
        });
        await touchComplaint(complaint.id);

        if (logId) {
          await run("UPDATE email_log SET complaint_id = ? WHERE id = ?", [complaint.id, logId]);
        }

        if (complaint.user_id) {
          await notify(
            complaint.user_id,
            complaint.id,
            "email_received",
            "We received your email",
            `Your email about complaint ${complaint.reference_no} has been added to the record.`
          );
        }
        if (complaint.assigned_user_id) {
          await notify(
            complaint.assigned_user_id,
            complaint.id,
            "email_received",
            "Citizen replied by email",
            `${sender} replied by email about complaint ${complaint.reference_no}.`
          );
        }
        handled.push({ reference: complaint.reference_no, matched: true, logId });
        continue;
      }

      // Unmatched mail still reaches the administrators, who decide what to do
      // with it. Nothing is auto-created from an unverified email.
      await notifyAdministrators(
        complaint ? complaint.id : null,
        "Municipal inbox received an email",
        complaint
          ? `An email about ${complaint.reference_no} was received from ${sender || "an unknown sender"} but the sender could not be verified, so it was not attached to the complaint.`
          : `An email was received from ${sender || "an unknown sender"} with subject "${message.subject || "(no subject)"}". It could not be matched to a complaint reference.`
      );
      handled.push({ reference: reference || null, matched: false, logId });
    }

    res.json({
      received: handled.length,
      messages: handled,
      note: "Inbound email has been recorded. Only replies from a verified citizen are attached to a complaint; everything else is routed to the administrator inbox."
    });
  })
);

// ---------------------------------------------------------------------------
// Everything below is administrator-only
// ---------------------------------------------------------------------------
router.use(requireAdmin);

router.get(
  "/status",
  asyncHandler(async (req, res) => {
    const alertsEnabled = await get("SELECT value FROM app_settings WHERE key = 'email_alerts_enabled'");
    const supportInbox = await get("SELECT value FROM app_settings WHERE key = 'support_inbox'");
    // The stored setting wins; when it was seeded before SUPPORT_INBOX existed
    // the environment value is the real one, so it is used as the fallback.
    res.json({
      config: mailer.configurationStatus(),
      alerts_enabled: !alertsEnabled || alertsEnabled.value === "1",
      support_inbox: (supportInbox && supportInbox.value) || mailer.config().supportInbox || null,
      inbound_usage:
        "Configure a Brevo inbound webhook pointing at this URL, appending ?token=<BREVO_INBOUND_SECRET>, to receive citizen replies."
    });
  })
);

router.get(
  "/log",
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const where = [];
    const params = [];

    if (req.query.direction === "inbound" || req.query.direction === "outbound") {
      where.push("e.direction = ?");
      params.push(req.query.direction);
    }
    if (req.query.status) {
      where.push("e.status = ?");
      params.push(String(req.query.status));
    }
    if (req.query.search) {
      const term = `%${String(req.query.search).trim()}%`;
      where.push("(e.to_email LIKE ? OR e.from_email LIKE ? OR e.subject LIKE ?)");
      params.push(term, term, term);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await all(
      `SELECT e.id, e.direction, e.status, e.from_email, e.from_name, e.to_email, e.subject,
              e.body, e.complaint_id, e.user_id, e.error, e.created_at,
              c.reference_no
       FROM email_log e
       LEFT JOIN complaints c ON c.id = e.complaint_id
       ${clause}
       ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = await get(`SELECT COUNT(*) AS total FROM email_log e ${clause}`, params);
    const total = countRow ? countRow.total : 0;

    res.json({
      items: rows.map((row) => ({
        id: row.id,
        direction: row.direction,
        status: row.status,
        from_email: row.from_email,
        from_name: row.from_name,
        to_email: row.to_email,
        subject: row.subject,
        preview: String(row.body || "").slice(0, 400),
        complaint_id: row.complaint_id,
        reference_no: row.reference_no,
        error: row.error,
        created_at: row.created_at
      })),
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

router.post(
  "/test",
  asyncHandler(async (req, res) => {
    const to = sanitizeText(req.body && req.body.to, 160) || req.user.email;
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
      return res.status(400).json({ error: "A valid recipient email address is required" });
    }

    const result = await mailer.sendEmail({
      to,
      toName: req.user.name,
      subject: "Municipal portal email test",
      html: mailer.alertHtml({
        heading: "Email alerts are working",
        intro: `This test message was requested by ${req.user.name || req.user.email} from the administration panel.`,
        rows: [
          ["Sent by", req.user.email],
          ["Sent at", new Date().toUTCString()]
        ],
        note: "If you received this message, Brevo transactional email is correctly configured."
      }),
      text: `Email alerts are working. This test was requested by ${req.user.email}.`,
      userId: req.user.id,
      tags: ["test"]
    });

    await audit(req.user, "email_test_sent", "email", null, null, { to, status: result.status }, req);

    if (!result.ok) {
      return res.status(result.status === "skipped" ? 400 : 502).json({
        error: result.error || "The test email could not be sent",
        status: result.status
      });
    }
    res.json({ message: `Test email accepted by Brevo for ${to}`, status: result.status });
  })
);

// ---------------------------------------------------------------------------
// POST /api/email/complaints/:id/notify — administrator-triggered alert email
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/notify",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid complaint id" });

    const complaint = await mailer.complaintContext(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const message = sanitizeText(req.body && req.body.message, 2000);
    if (!message || message.length < 5) {
      return res.status(400).json({ error: "Enter a message of at least 5 characters" });
    }

    const recipient = String((req.body && req.body.recipient) || "officer");
    let target = null;
    let role = null;

    if (recipient === "officer" || recipient === "citizen") {
      const row = await get(
        `SELECT c.assigned_user_id, c.user_id, c.contact_email, c.reference_no,
                au.email AS officer_email, au.name AS officer_name, au.id AS officer_id,
                cu.email AS citizen_email, cu.name AS citizen_name
         FROM complaints c
         LEFT JOIN users au ON au.id = c.assigned_user_id
         LEFT JOIN users cu ON cu.id = c.user_id
         WHERE c.id = ?`,
        [id]
      );
      if (!row) return res.status(404).json({ error: "Complaint not found" });

      if (recipient === "officer") {
        if (!row.officer_id || !row.officer_email) {
          return res.status(400).json({ error: "No officer with an email address is assigned to this complaint" });
        }
        target = { email: row.officer_email, name: row.officer_name, userId: row.officer_id };
        role = "officer";
      } else {
        const email = row.citizen_email || row.contact_email;
        if (!email) return res.status(400).json({ error: "The citizen has no email address on file" });
        target = { email, name: row.citizen_name, userId: row.user_id };
        role = "citizen";
      }
    } else {
      const email = sanitizeText((req.body && req.body.email) || "", 160);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: "A valid recipient email address is required" });
      }
      target = { email, name: null, userId: null };
      role = "custom";
    }

    const heading = sanitizeText((req.body && req.body.subject) || "", 200) || `Update on ${complaint.reference_no}`;
    const result = await mailer.sendEmail({
      to: target.email,
      toName: target.name,
      subject: `[${complaint.reference_no}] ${heading}`,
      html: mailer.alertHtml({
        heading,
        intro: message,
        rows: [
          ["Complaint", complaint.reference_no],
          ["Subject", complaint.title || "—"],
          ["Status", complaint.status || "—"],
          ["Department", complaint.department_name || "Not routed"]
        ],
        actionUrl: mailer.config().publicBaseUrl ? `${mailer.config().publicBaseUrl}/#/dashboard` : null,
        actionLabel: role === "citizen" ? "Track your complaint" : "Open the service desk",
        note: `This alert was sent from the administration panel by ${req.user.email}.`
      }),
      text: `${heading}\n\n${message}\n\nComplaint ${complaint.reference_no} — ${complaint.title} (${complaint.status})`,
      complaintId: id,
      userId: target.userId,
      tags: ["manual", role]
    });

    await audit(req.user, "complaint_email_sent", "complaint", id, null,
      { to: target.email, recipient: role, status: result.status }, req);

    if (!result.ok) {
      return res.status(result.status === "skipped" ? 400 : 502).json({
        error: result.error || "The alert could not be sent",
        status: result.status
      });
    }
    res.json({ message: `Alert accepted by Brevo for ${target.email}`, status: result.status });
  })
);

module.exports = router;
