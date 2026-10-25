/**
 * Staff / administrator complaint management (Phase 4, 5, 6, 7, 10).
 * Mounted at /api/staff. Every route requires the 'staff' or 'admin' role.
 */
const express = require("express");
const { body, validationResult } = require("express-validator");

const { asyncHandler, requireStaff } = require("../middleware");
const {
  all,
  get,
  run,
  audit,
  notify,
  getSetting,
  getSettingNumber,
  setSetting,
  addNote,
  addAttachment,
  recordStatusHistory,
  touchComplaint,
  computeDueAt
} = require("../lib/store");
const {
  STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  canTransition,
  clampPriority,
  parsePagination,
  sanitizeText,
  slaState
} = require("../lib/civic");
const {
  uploadResolutionEvidence,
  validateMediaSizes,
  cleanupUploads
} = require("../upload");
const { escalateOverdue } = require("../lib/escalation");
const { sendDepartmentAlert } = require("../lib/mailer");

const router = express.Router();

router.use(requireStaff);

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: "Please correct the highlighted fields",
    errors: errors.array().map((e) => ({ field: e.path, message: e.msg }))
  });
  return true;
}

async function loadComplaint(id) {
  return get(
    `SELECT c.*,
            cat.name AS category_name, cat.code AS category_code,
            sub.name AS subcategory_name,
            d.name AS department_name,
            w.name AS ward_name, w.zone AS ward_zone,
            au.name AS assigned_user_name
     FROM complaints c
     LEFT JOIN service_categories cat ON cat.id = c.category_id
     LEFT JOIN service_subcategories sub ON sub.id = c.subcategory_id
     LEFT JOIN departments d ON d.id = c.department_id
     LEFT JOIN wards w ON w.id = c.ward_id
     LEFT JOIN users au ON au.id = c.assigned_user_id
     WHERE c.id = ?`,
    [id]
  );
}

// ---------------------------------------------------------------------------
// Reference data for staff forms
// ---------------------------------------------------------------------------
router.get(
  "/staff-users",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT u.id, u.name, u.email, u.role, u.designation, u.department_id, d.name AS department_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       WHERE u.role IN ('staff', 'admin') AND u.is_active = 1
       ORDER BY u.name`
    );
    res.json(rows);
  })
);

// Active departments, for the selection lists used by staff assignment forms.
router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    const rows = await all(
      "SELECT id, code, name FROM departments WHERE is_active = 1 ORDER BY name"
    );
    res.json({ departments: rows });
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/staff/complaints/:id/status — guarded status transitions
// ---------------------------------------------------------------------------
router.patch(
  "/complaints/:id/status",
  [
    body("status").isIn(STATUSES).withMessage("Unknown complaint status"),
    body("remarks").optional({ values: "falsy" }).trim().isLength({ max: 1000 }),
    body("resolution_notes").optional({ values: "falsy" }).trim().isLength({ max: 3000 }),
    body("rejection_reason").optional({ values: "falsy" }).trim().isLength({ max: 1000 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const complaint = await loadComplaint(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const nextStatus = req.body.status;
    if (!canTransition(complaint.status, nextStatus)) {
      return res.status(409).json({
        error: `A complaint cannot move from "${complaint.status}" to "${nextStatus}".`
      });
    }

    const updates = { status: nextStatus };
    const remarks = sanitizeText(req.body.remarks, 1000) || null;

    // A resolution must carry a written outcome: clicking a button is not enough.
    if (nextStatus === "Resolved") {
      const notes = sanitizeText(req.body.resolution_notes, 3000);
      if (!notes || notes.length < 15) {
        return res.status(400).json({
          error: "Resolution notes of at least 15 characters are required before a complaint can be resolved"
        });
      }
      updates.resolution_notes = notes;
      updates.resolved_at = new Date().toISOString();
    }
    if (nextStatus === "Rejected") {
      const reason = sanitizeText(req.body.rejection_reason, 1000);
      if (!reason || reason.length < 10) {
        return res.status(400).json({
          error: "A rejection reason of at least 10 characters is required"
        });
      }
      updates.rejection_reason = reason;
    }
    if (nextStatus === "Closed") {
      updates.closed_at = new Date().toISOString();
    }
    if (nextStatus === "Reopened") {
      updates.reopen_count = (complaint.reopen_count || 0) + 1;
      updates.resolved_at = null;
    }

    const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
    await run(
      `UPDATE complaints SET ${setClause}, last_activity_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...Object.values(updates), id]
    );

    await recordStatusHistory({
      complaintId: id,
      oldStatus: complaint.status,
      newStatus: nextStatus,
      actor: req.user,
      remarks
    });
    await audit(req.user, "complaint_status_changed", "complaint", id,
      { status: complaint.status },
      { status: nextStatus, remarks },
      req
    );

    if (complaint.user_id) {
      await notify(
        complaint.user_id,
        id,
        "status_changed",
        "Complaint status updated",
        `Complaint ${complaint.reference_no} is now "${nextStatus}".${
          nextStatus === "Resolved" ? " Please share your feedback in the citizen dashboard." : ""
        }`
      );
    }

    // The officer holding the complaint is alerted too, unless they made the change.
    if (complaint.assigned_user_id && Number(complaint.assigned_user_id) !== Number(req.user.id)) {
      await notify(
        complaint.assigned_user_id,
        id,
        "status_changed",
        "Complaint you handle changed status",
        `Complaint ${complaint.reference_no}, assigned to you, moved from "${complaint.status}" to "${nextStatus}".`
      );
    }

    const refreshed = await loadComplaint(id);
    res.json({ complaint: refreshed, message: `Status updated to ${nextStatus}` });
  })
);

// ---------------------------------------------------------------------------
// POST /api/staff/complaints/:id/assign — department / officer assignment
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/assign",
  [
    body("department_id").optional({ values: "falsy" }).isInt({ min: 1 }),
    body("assigned_user_id").optional({ values: "falsy" }).isInt({ min: 1 }),
    body("note").optional({ values: "falsy" }).trim().isLength({ max: 500 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const complaint = await loadComplaint(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const departmentId = req.body.department_id ? Number(req.body.department_id) : complaint.department_id;
    const assignedUserId = req.body.assigned_user_id ? Number(req.body.assigned_user_id) : null;
    if (!departmentId && !assignedUserId) {
      return res.status(400).json({ error: "Select a department or an officer to assign this complaint to" });
    }

    // Officers may only be assigned within their own department when one is set.
    let officer = null;
    if (assignedUserId) {
      officer = await get(
        "SELECT id, name, email, role, department_id FROM users WHERE id = ? AND is_active = 1",
        [assignedUserId]
      );
      if (!officer || !["staff", "admin"].includes(officer.role)) {
        return res.status(400).json({ error: "The selected officer is not an active staff member" });
      }
      if (officer.department_id && departmentId && officer.department_id !== departmentId) {
        return res.status(400).json({
          error: "The selected officer belongs to a different department than the one selected"
        });
      }
    }

    const method = req.body.method === "automatic" ? "automatic" : "manual";

    await run(
      `UPDATE complaints
       SET department_id = ?, assigned_user_id = ?, assigned_at = CURRENT_TIMESTAMP,
           assigned_to = COALESCE(?, assigned_to), status = CASE
             WHEN status IN ('Submitted', 'Under Review') THEN 'Assigned'
             ELSE status END,
           last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [departmentId || null, assignedUserId, officer ? officer.name : null, id]
    );

    await run(
      `INSERT INTO complaint_assignments
        (complaint_id, department_id, assigned_user_id, method, note, assigned_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, departmentId || null, assignedUserId, method, sanitizeText(req.body.note, 500) || null,
        req.user.email || req.user.name]
    );

    if (complaint.status !== "Assigned" && ["Submitted", "Under Review"].includes(complaint.status)) {
      await recordStatusHistory({
        complaintId: id,
        oldStatus: complaint.status,
        newStatus: "Assigned",
        actor: req.user,
        remarks: "Assigned to a department for action."
      });
    }

    await audit(req.user, "complaint_assigned", "complaint", id,
      { department_id: complaint.department_id, assigned_user_id: complaint.assigned_user_id },
      { department_id: departmentId, assigned_user_id: assignedUserId, method },
      req
    );

    if (officer) {
      await notify(officer.id, id, "complaint_assigned", "Complaint assigned to you",
        `Complaint ${complaint.reference_no} has been assigned to you.`);
    }
    if (complaint.user_id) {
      await notify(complaint.user_id, id, "complaint_assigned", "Complaint assigned",
        `Complaint ${complaint.reference_no} has been assigned to the responsible department.`);
    }

    // The department's configured mailbox is alerted as well, so the assignment
    // is visible even when the individual officer is away.
    sendDepartmentAlert({
      departmentId,
      complaintId: id,
      heading: "Complaint assigned to your department",
      message: `Complaint ${complaint.reference_no} was assigned to ${
        officer ? officer.name : "your department"
      } by ${req.user.name || req.user.email}.`
    }).catch((err) => console.error("Department alert email failed:", err.message));

    const refreshed = await loadComplaint(id);
    res.json({ complaint: refreshed, message: "Complaint assigned" });
  })
);

// ---------------------------------------------------------------------------
// Notes: internal (staff only) and citizen-visible updates
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/notes",
  [
    body("note").trim().isLength({ min: 2, max: 2000 }).withMessage("Note text is required"),
    body("visibility").optional().isIn(["internal", "citizen"])
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const complaint = await loadComplaint(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const visibility = req.body.visibility === "citizen" ? "citizen" : "internal";
    await addNote({
      complaintId: id,
      author: req.user,
      visibility,
      note: sanitizeText(req.body.note, 2000)
    });
    await touchComplaint(id);
    await audit(req.user, "complaint_note_added", "complaint", id, null, { visibility }, req);

    if (visibility === "citizen" && complaint.user_id) {
      await notify(complaint.user_id, id, "complaint_update", "New update on your complaint",
        `An update was added to complaint ${complaint.reference_no}.`);
    }

    res.status(201).json({ message: visibility === "citizen" ? "Citizen-visible update added" : "Internal note added" });
  })
);

// ---------------------------------------------------------------------------
// Resolution evidence upload
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/attachments",
  uploadResolutionEvidence,
  validateMediaSizes,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const complaint = await loadComplaint(id);
    if (!complaint) {
      cleanupUploads(req);
      return res.status(404).json({ error: "Complaint not found" });
    }

    const files = req.files || {};
    const uploaded = [...(files.image || []), ...(files.video || [])];
    if (!uploaded.length) {
      return res.status(400).json({ error: "Select at least one image or video of the completed work" });
    }

    const created = [];
    for (const file of uploaded) {
      const attachmentId = await addAttachment({
        complaintId: id,
        kind: "resolution",
        file,
        uploadedBy: req.user.id
      });
      created.push({ id: attachmentId, name: file.originalname, mime_type: file.mimetype });
    }

    await addNote({
      complaintId: id,
      author: req.user,
      visibility: "citizen",
      note: "Resolution evidence uploaded by the department."
    });
    await touchComplaint(id);
    await audit(req.user, "resolution_evidence_uploaded", "complaint", id, null,
      { attachments: created.length }, req);
    if (complaint.user_id) {
      await notify(complaint.user_id, id, "complaint_update", "Resolution evidence added",
        `Photographic evidence was added to complaint ${complaint.reference_no}.`);
    }

    res.status(201).json({ attachments: created, message: "Resolution evidence uploaded" });
  })
);

// ---------------------------------------------------------------------------
// Duplicate linking (Phase 11)
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/duplicates",
  [
    body("duplicate_of_id").isInt({ min: 1 }).withMessage("Select the original complaint"),
    body("reason").optional({ values: "falsy" }).trim().isLength({ max: 500 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const duplicateOfId = Number(req.body.duplicate_of_id);
    if (id === duplicateOfId) {
      return res.status(400).json({ error: "A complaint cannot be linked to itself" });
    }

    const [complaint, original] = await Promise.all([
      loadComplaint(id),
      loadComplaint(duplicateOfId)
    ]);
    if (!complaint || !original) return res.status(404).json({ error: "Complaint not found" });

    const existing = await get(
      "SELECT id FROM complaint_duplicates WHERE complaint_id = ? AND duplicate_of_id = ?",
      [id, duplicateOfId]
    );
    if (existing) return res.status(409).json({ error: "These complaints are already linked" });

    await run(
      `INSERT INTO complaint_duplicates (complaint_id, duplicate_of_id, similarity, reason, status, linked_by)
       VALUES (?, ?, NULL, ?, 'linked', ?)`,
      [id, duplicateOfId, sanitizeText(req.body.reason, 500) || null, req.user.email || req.user.name]
    );

    // The duplicate keeps its own reference number and history — nothing is deleted.
    await addNote({
      complaintId: id,
      author: req.user,
      visibility: "citizen",
      note: `This complaint has been linked to ${original.reference_no} as a duplicate of the same issue.`
    });
    await touchComplaint(id);
    await audit(req.user, "complaint_linked_duplicate", "complaint", id, null,
      { duplicate_of: original.reference_no }, req);

    res.status(201).json({ message: `Linked to ${original.reference_no}` });
  })
);

router.patch(
  "/complaints/:id/duplicates/:linkId",
  [body("status").isIn(["suggested", "linked", "dismissed"])],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const link = await get(
      "SELECT * FROM complaint_duplicates WHERE id = ? AND complaint_id = ?",
      [Number(req.params.linkId), Number(req.params.id)]
    );
    if (!link) return res.status(404).json({ error: "Duplicate link not found" });

    await run(
      "UPDATE complaint_duplicates SET status = ?, linked_by = ? WHERE id = ?",
      [req.body.status, req.user.email || req.user.name, link.id]
    );
    await audit(req.user, "duplicate_link_updated", "complaint", Number(req.params.id),
      { status: link.status }, { status: req.body.status }, req);
    res.json({ message: "Duplicate link updated" });
  })
);

// ---------------------------------------------------------------------------
// Reopening request review
// ---------------------------------------------------------------------------
router.post(
  "/complaints/:id/reopen-requests/:requestId/review",
  [
    body("decision").isIn(["approve", "reject"]),
    body("notes").optional({ values: "falsy" }).trim().isLength({ max: 1000 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const request = await get(
      "SELECT * FROM complaint_reopen_requests WHERE id = ? AND complaint_id = ?",
      [Number(req.params.requestId), id]
    );
    if (!request) return res.status(404).json({ error: "Reopening request not found" });
    if (request.status !== "pending") {
      return res.status(409).json({ error: "This reopening request has already been reviewed" });
    }

    const complaint = await loadComplaint(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const approve = req.body.decision === "approve";
    await run(
      `UPDATE complaint_reopen_requests
       SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, review_notes = ?
       WHERE id = ?`,
      [
        approve ? "approved" : "rejected",
        req.user.email || req.user.name,
        sanitizeText(req.body.notes, 1000) || null,
        request.id
      ]
    );

    if (approve) {
      const from = complaint.status;
      // The earlier resolution is preserved in complaint_status_history.
      await run(
        `UPDATE complaints SET status = 'Reopened', reopen_count = COALESCE(reopen_count, 0) + 1,
           resolved_at = NULL, closed_at = NULL, last_activity_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [id]
      );
      await recordStatusHistory({
        complaintId: id,
        oldStatus: from,
        newStatus: "Reopened",
        actor: req.user,
        remarks: sanitizeText(req.body.notes, 1000) || "Reopening request approved."
      });
    }

    await audit(req.user, approve ? "reopen_approved" : "reopen_rejected", "complaint", id,
      { status: complaint.status }, { decision: req.body.decision }, req);
    await notify(complaint.user_id, id, "reopen_reviewed",
      approve ? "Complaint reopened" : "Reopening request declined",
      approve
        ? `Complaint ${complaint.reference_no} has been reopened for further action.`
        : `Your reopening request for ${complaint.reference_no} was declined.`
    );

    res.json({ message: approve ? "Complaint reopened" : "Reopening request declined" });
  })
);

// ---------------------------------------------------------------------------
// Pending reopening queue
// ---------------------------------------------------------------------------
router.get(
  "/reopen-requests",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT rr.id, rr.complaint_id, rr.reason, rr.status, rr.created_at,
              c.reference_no, c.status AS complaint_status, c.title
       FROM complaint_reopen_requests rr
       JOIN complaints c ON c.id = rr.complaint_id
       WHERE rr.status = 'pending'
       ORDER BY rr.created_at ASC`
    );
    res.json(rows);
  })
);

// ---------------------------------------------------------------------------
// SLA / escalation management (Phase 7)
// ---------------------------------------------------------------------------
router.post(
  "/escalations/run",
  asyncHandler(async (req, res) => {
    const result = await escalateOverdue({ actor: req.user });
    res.json(result);
  })
);

router.get(
  "/escalations",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT e.id, e.complaint_id, e.level, e.escalated_to, e.reason, e.created_at,
              e.acknowledged_at, e.acknowledged_by,
              c.reference_no, c.status, c.priority, c.due_at
       FROM complaint_escalations e
       JOIN complaints c ON c.id = e.complaint_id
       ORDER BY e.created_at DESC LIMIT 200`
    );
    res.json(rows);
  })
);

router.post(
  "/escalations/:id/acknowledge",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT id FROM complaint_escalations WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Escalation not found" });
    await run(
      "UPDATE complaint_escalations SET acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ? WHERE id = ?",
      [req.user.email || req.user.name, id]
    );
    await audit(req.user, "escalation_acknowledged", "complaint_escalation", id, null, null, req);
    res.json({ message: "Escalation acknowledged" });
  })
);

// ---------------------------------------------------------------------------
// Overdue / due-soon worklists
// ---------------------------------------------------------------------------
router.get(
  "/worklists",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT c.id, c.reference_no, c.title, c.status, c.priority, c.due_at,
              c.assigned_user_id, c.escalation_level,
              d.name AS department_name, w.name AS ward_name,
              u.name AS assigned_user_name
       FROM complaints c
       LEFT JOIN departments d ON d.id = c.department_id
       LEFT JOIN wards w ON w.id = c.ward_id
       LEFT JOIN users u ON u.id = c.assigned_user_id
       WHERE c.due_at IS NOT NULL AND c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})
       ORDER BY c.due_at ASC`,
      [...OPEN_STATUSES]
    );
    const decorated = rows.map((row) => ({ ...row, sla_state: slaState(row.due_at) }));
    res.json({
      overdue: decorated.filter((r) => r.sla_state === "overdue"),
      due_soon: decorated.filter((r) => r.sla_state === "due_soon"),
      last_sweep: await getSetting("last_escalation_sweep", null)
    });
  })
);

// ---------------------------------------------------------------------------
// Citizen feedback summary (Phase 10)
// ---------------------------------------------------------------------------
router.get(
  "/feedback/summary",
  asyncHandler(async (req, res) => {
    const overall = await get(
      `SELECT COUNT(*) AS responses,
              AVG(rating) AS average_rating,
              SUM(CASE WHEN was_resolved = 1 THEN 1 ELSE 0 END) AS confirmed_resolved
       FROM complaint_feedback`
    );
    const byCategory = await all(
      `SELECT cat.name AS category_name, COUNT(*) AS responses, AVG(f.rating) AS average_rating
       FROM complaint_feedback f
       JOIN complaints c ON c.id = f.complaint_id
       LEFT JOIN service_categories cat ON cat.id = c.category_id
       GROUP BY cat.name
       ORDER BY responses DESC`
    );
    const lowRated = await all(
      `SELECT f.rating, f.was_resolved, f.comments, f.created_at, c.reference_no, c.id AS complaint_id
       FROM complaint_feedback f
       JOIN complaints c ON c.id = f.complaint_id
       WHERE f.rating <= 2 OR f.was_resolved = 0
       ORDER BY f.created_at DESC LIMIT 20`
    );
    res.json({
      responses: overall ? overall.responses : 0,
      average_rating: overall && overall.average_rating ? Number(Number(overall.average_rating).toFixed(2)) : null,
      confirmed_resolved: overall ? overall.confirmed_resolved : 0,
      by_category: byCategory,
      needs_attention: lowRated
    });
  })
);

// ---------------------------------------------------------------------------
// Priority override (staff, validated server-side)
// ---------------------------------------------------------------------------
router.patch(
  "/complaints/:id/priority",
  [body("priority").isIn(PRIORITIES).withMessage("Invalid priority")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const complaint = await loadComplaint(id);
    if (!complaint) return res.status(404).json({ error: "Complaint not found" });

    const priority = clampPriority(req.body.priority);
    const { dueAt } = await computeDueAt(
      complaint.resolved_at ? complaint.created_at : new Date(complaint.created_at).toISOString(),
      { categoryId: complaint.category_id, subcategory: null, priority }
    );

    await run(
      `UPDATE complaints SET priority = ?, due_at = ?, updated_at = CURRENT_TIMESTAMP,
         last_activity_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [priority, complaint.resolved_at ? complaint.due_at : dueAt.toISOString(), id]
    );
    await audit(req.user, "complaint_priority_changed", "complaint", id,
      { priority: complaint.priority }, { priority }, req);

    res.json({ message: `Priority set to ${priority}` });
  })
);

// ---------------------------------------------------------------------------
// Authorised CSV export (admin only)
// ---------------------------------------------------------------------------
router.get(
  "/export/complaints.csv",
  asyncHandler(async (req, res) => {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Only administrators can export complaint reports" });
    }

    const { limit } = parsePagination({ limit: 5000 }, { defaultLimit: 5000, maxLimit: 5000 });
    const rows = await all(
      `SELECT c.reference_no, c.title, c.status, c.priority, c.created_at, c.due_at,
              c.resolved_at, cat.name AS category, sub.name AS subcategory,
              d.name AS department, w.name AS ward, c.location_text,
              c.escalation_level, c.reopen_count
       FROM complaints c
       LEFT JOIN service_categories cat ON cat.id = c.category_id
       LEFT JOIN service_subcategories sub ON sub.id = c.subcategory_id
       LEFT JOIN departments d ON d.id = c.department_id
       LEFT JOIN wards w ON w.id = c.ward_id
       ORDER BY c.created_at DESC LIMIT ?`,
      [limit]
    );

    const headers = [
      "reference_no", "title", "status", "priority", "created_at", "due_at", "resolved_at",
      "category", "subcategory", "department", "ward", "location_text", "escalation_level", "reopen_count"
    ];
    const escape = (value) => {
      if (value === null || value === undefined) return "";
      const text = String(value).replace(/"/g, '""');
      return /[",\n]/.test(text) ? `"${text}"` : text;
    };
    const csv = [
      headers.join(","),
      ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))
    ].join("\n");

    await audit(req.user, "complaints_exported", "complaint", null, null, { rows: rows.length }, req);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="complaints-${Date.now()}.csv"`);
    res.send(csv);
  })
);

module.exports = router;
