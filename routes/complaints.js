/**
 * Complaint lifecycle routes (Phase 3, 4, 10, 11).
 *
 * Covers submission with validation + duplicate detection, citizen tracking,
 * authorised evidence access, feedback and reopening requests.
 */
const express = require("express");
const path = require("path");
const { body, validationResult } = require("express-validator");

const {
  asyncHandler,
  authMiddleware,
  isStaff
} = require("../middleware");
const {
  all,
  get,
  run,
  audit,
  notify,
  getCategory,
  getSubcategory,
  nextReference,
  resolveDepartment,
  computeDueAt,
  recordStatusHistory,
  touchComplaint
} = require("../lib/store");
const {
  clampPriority,
  parsePagination,
  validLatitude,
  validLongitude,
  sanitizeText,
  REOPENABLE_STATUSES,
  OPEN_STATUSES
} = require("../lib/civic");
const {
  uploadComplaintEvidence,
  validateMediaSizes,
  cleanupUploads,
  resolveStoredPath
} = require("../upload");
const { findPossibleDuplicates } = require("../lib/duplicates");

const router = express.Router();

const SORTABLE = {
  created_at: "c.created_at",
  updated_at: "c.last_activity_at",
  due_at: "c.due_at",
  priority: `CASE c.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`
};

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: "Please correct the highlighted fields",
    errors: errors.array().map((e) => ({ field: e.path, message: e.msg }))
  });
  return true;
}

function canView(viewer, row) {
  if (!viewer) return false;
  if (isStaff(viewer)) return true;
  return Number(row.user_id) === Number(viewer.id);
}

function evidenceUrl(complaintId, attachmentId) {
  return `/api/complaints/${complaintId}/evidence/${attachmentId}`;
}

/** Normalises a joined complaint row for API responses. */
function shapeComplaint(row, viewer, extras = {}) {
  const staff = isStaff(viewer);
  const payload = {
    id: row.id,
    reference_no: row.reference_no,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    category_id: row.category_id,
    category_code: row.category_code || null,
    category_name: row.category_name || row.category,
    subcategory_id: row.subcategory_id,
    subcategory_code: row.subcategory_code || null,
    subcategory_name: row.subcategory_name || null,
    department_id: row.department_id,
    department_name: row.department_name || row.assigned_to || null,
    ward_id: row.ward_id,
    ward_name: row.ward_name || null,
    zone: row.ward_zone || null,
    location_text: row.location_text,
    latitude: row.latitude,
    longitude: row.longitude,
    is_public: row.is_public === 1 || row.is_public === true,
    reopen_count: row.reopen_count || 0,
    escalation_level: row.escalation_level || 0,
    due_at: row.due_at,
    resolved_at: row.resolved_at,
    closed_at: row.closed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_activity_at: row.last_activity_at || row.updated_at,
    resolution_notes: row.resolution_notes || null,
    rejection_reason: row.rejection_reason || null,
    assigned_user_id: row.assigned_user_id || null,
    assigned_user_name: row.assigned_user_name || null,
    is_overdue: row.due_at ? new Date(row.due_at).getTime() < Date.now() : false
  };

  // Citizen contact details are private: only the owning citizen and staff see them.
  if (staff || (viewer && Number(viewer.id) === Number(row.user_id))) {
    payload.contact_name = row.contact_name || null;
    payload.contact_phone = row.contact_phone || null;
    payload.contact_email = row.contact_email || null;
  }
  if (staff) {
    payload.citizen = row.citizen_name
      ? { name: row.citizen_name, email: row.citizen_email }
      : null;
    payload.admin_remarks = row.admin_remarks || null;
  }

  Object.assign(payload, extras);
  return payload;
}

const LIST_SELECT = `
  SELECT c.*,
         cat.code AS category_code, cat.name AS category_name,
         sub.code AS subcategory_code, sub.name AS subcategory_name,
         d.name AS department_name,
         w.name AS ward_name, w.zone AS ward_zone,
         au.name AS assigned_user_name,
         u.name AS citizen_name, u.email AS citizen_email
  FROM complaints c
  LEFT JOIN service_categories cat ON cat.id = c.category_id
  LEFT JOIN service_subcategories sub ON sub.id = c.subcategory_id
  LEFT JOIN departments d ON d.id = c.department_id
  LEFT JOIN wards w ON w.id = c.ward_id
  LEFT JOIN users au ON au.id = c.assigned_user_id
  LEFT JOIN users u ON u.id = c.user_id
`;

/** Builds the WHERE clause shared by the citizen and staff list endpoints. */
function buildFilters(req, { forceOwnerId = null } = {}) {
  const where = [];
  const params = [];
  const q = req.query;

  if (forceOwnerId !== null) {
    where.push("c.user_id = ?");
    params.push(forceOwnerId);
  } else if (q.user_id) {
    where.push("c.user_id = ?");
    params.push(Number(q.user_id));
  }

  if (q.status) {
    const statuses = String(q.status).split(",").map((s) => s.trim()).filter(Boolean);
    if (statuses.length) {
      where.push(`c.status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
  }
  if (q.open === "1") {
    where.push(`c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
    params.push(...OPEN_STATUSES);
  }
  if (q.category_id) {
    where.push("c.category_id = ?");
    params.push(Number(q.category_id));
  }
  if (q.subcategory_id) {
    where.push("c.subcategory_id = ?");
    params.push(Number(q.subcategory_id));
  }
  if (q.category) {
    where.push("(cat.code = ? OR c.category = ?)");
    params.push(String(q.category), String(q.category));
  }
  if (q.subcategory) {
    where.push("sub.code = ?");
    params.push(String(q.subcategory));
  }
  if (q.ward_id) {
    where.push("c.ward_id = ?");
    params.push(Number(q.ward_id));
  }
  if (q.department_id) {
    where.push("c.department_id = ?");
    params.push(Number(q.department_id));
  }
  if (q.priority) {
    where.push("c.priority = ?");
    params.push(String(q.priority));
  }
  if (q.assigned_to) {
    where.push("c.assigned_user_id = ?");
    params.push(Number(q.assigned_to));
  }
  if (q.unassigned === "1") {
    where.push("c.assigned_user_id IS NULL");
  }
  if (q.from) {
    where.push("date(c.created_at) >= date(?)");
    params.push(String(q.from));
  }
  if (q.to) {
    where.push("date(c.created_at) <= date(?)");
    params.push(String(q.to));
  }
  if (q.overdue === "1") {
    where.push("c.due_at IS NOT NULL AND c.due_at < CURRENT_TIMESTAMP");
    where.push(`c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);
    params.push(...OPEN_STATUSES);
  }
  if (q.due_soon === "1") {
    where.push("c.due_at IS NOT NULL AND c.due_at >= CURRENT_TIMESTAMP");
    where.push("c.due_at <= datetime('now', '+12 hours')");
  }
  if (q.search) {
    const term = `%${String(q.search).trim()}%`;
    where.push(
      "(c.reference_no LIKE ? OR c.title LIKE ? OR c.description LIKE ? OR c.location_text LIKE ?)"
    );
    params.push(term, term, term, term);
  }

  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

// ---------------------------------------------------------------------------
// POST /api/complaints/duplicate-check
router.post(
  "/duplicate-check",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const subcategory = await getSubcategory(req.body.subcategory_id || req.body.subcategory);
    const category = subcategory
      ? { id: subcategory.category_id }
      : await getCategory(req.body.category_id || req.body.category);

    const matches = await findPossibleDuplicates({
      excludeId: req.body.exclude_id ? Number(req.body.exclude_id) : null,
      categoryId: category ? category.id : null,
      subcategoryId: subcategory ? subcategory.id : null,
      description: sanitizeText(req.body.description, 4000),
      latitude: validLatitude(req.body.latitude),
      longitude: validLongitude(req.body.longitude)
    });

    res.json({
      matches,
      can_continue: true,
      note:
        matches.length > 0
          ? "These are similar existing complaints. You can still submit yours — municipal staff will link duplicates."
          : null
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/complaints — submit a complaint (Phase 3)
// ---------------------------------------------------------------------------
router.post(
  "/",
  authMiddleware,
  uploadComplaintEvidence,
  validateMediaSizes,
  [
    body("title").trim().isLength({ min: 5, max: 160 }).withMessage("Title must be 5-160 characters"),
    body("description").trim().isLength({ min: 15, max: 5000 }).withMessage("Description must be at least 15 characters"),
    body("subcategory_id").exists().withMessage("A subcategory is required"),
    body("location_text").trim().isLength({ min: 3, max: 400 }).withMessage("A location or address is required"),
    body("priority").optional({ values: "falsy" }).isIn(["low", "medium", "high", "critical"]).withMessage("Invalid priority"),
    body("contact_phone").optional({ values: "falsy" }).trim().isLength({ max: 20 }),
    body("ward_id").optional({ values: "falsy" }).isInt({ min: 1 }),
    body("client_token").optional({ values: "falsy" }).trim().isLength({ max: 80 })
  ],
  asyncHandler(async (req, res) => {
    // Validate before consuming the uploaded files so nothing is orphaned.
    if (validationErrors(req, res)) {
      cleanupUploads(req);
      return;
    }

    const subcategory = await getSubcategory(req.body.subcategory_id);
    if (!subcategory || subcategory.is_active !== 1) {
      cleanupUploads(req);
      return res.status(400).json({ error: "The selected subcategory is not available" });
    }
    // Any active service type can be complained about. Complaints are most often
    // filed against 'complaint' entries, but a citizen must also be able to report
    // a problem with an application or information service — for example a birth
    // certificate application that has stalled. The type only affects which
    // default priority and routing the record inherits.

    const category = await getCategory(subcategory.category_id);
    const clientToken = sanitizeText(req.body.client_token, 80) || null;

    // Idempotency: ignore an accidental repeat submission of the same form.
    if (clientToken) {
      const prior = await get(
        "SELECT id, reference_no FROM complaints WHERE user_id = ? AND client_token = ?",
        [req.user.id, clientToken]
      );
      if (prior) {
        cleanupUploads(req);
        return res.status(200).json({
          duplicate_submission: true,
          complaint: { id: prior.id, reference_no: prior.reference_no },
          message: `This complaint was already submitted as ${prior.reference_no}.`
        });
      }
    }

    // Priority is never trusted from the client: validate, then fall back to
    // the configured default for the chosen subcategory.
    const priority = clampPriority(req.body.priority, subcategory.default_priority || "medium");
    const routing = await resolveDepartment({ subcategory, category });
    const createdAt = new Date().toISOString();
    const { dueAt, targetHours } = await computeDueAt(createdAt, {
      categoryId: category ? category.id : null,
      subcategory,
      priority
    });
    const referenceNo = await nextReference("complaint");

    const result = await run(
      `INSERT INTO complaints
        (reference_no, user_id, category, title, description, category_id, subcategory_id,
         department_id, ward_id, priority, status, latitude, longitude, location_text,
         contact_name, contact_phone, contact_email, due_at, is_public, client_token,
         assigned_to, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, CURRENT_TIMESTAMP)`,
      [
        referenceNo,
        req.user.id,
        category ? category.name : "Other",
        sanitizeText(req.body.title, 160),
        sanitizeText(req.body.description, 5000),
        category ? category.id : null,
        subcategory.id,
        routing.department_id,
        req.body.ward_id ? Number(req.body.ward_id) : null,
        priority,
        validLatitude(req.body.latitude),
        validLongitude(req.body.longitude),
        sanitizeText(req.body.location_text, 400),
        sanitizeText(req.body.contact_name, 120) || null,
        sanitizeText(req.body.contact_phone, 20) || null,
        sanitizeText(req.body.contact_email, 160) || null,
        dueAt.toISOString(),
        clientToken
      ]
    );
    const complaintId = result.lastID;

    // Store uploaded evidence and retire the legacy image_path column.
    const files = req.files || {};
    let legacyImagePath = null;
    for (const file of files.image || []) {
      await run(
        `INSERT INTO complaint_attachments
          (complaint_id, kind, file_path, original_name, mime_type, size_bytes, uploaded_by)
         VALUES (?, 'evidence', ?, ?, ?, ?, ?)`,
        [complaintId, file.publicPath, file.originalname || null, file.mimetype, file.size, req.user.id]
      );
      if (!legacyImagePath && file.mimetype.startsWith("image/")) legacyImagePath = file.publicPath;
    }
    for (const file of files.video || []) {
      await run(
        `INSERT INTO complaint_attachments
          (complaint_id, kind, file_path, original_name, mime_type, size_bytes, uploaded_by)
         VALUES (?, 'evidence', ?, ?, ?, ?, ?)`,
        [complaintId, file.publicPath, file.originalname || null, file.mimetype, file.size, req.user.id]
      );
    }
    if (legacyImagePath) {
      await run("UPDATE complaints SET image_path = ? WHERE id = ?", [legacyImagePath, complaintId]);
    }

    await recordStatusHistory({
      complaintId,
      oldStatus: null,
      newStatus: "Submitted",
      actor: req.user,
      remarks: "Complaint received through the citizen portal."
    });
    await audit(req.user, "complaint_created", "complaint", complaintId, null, {
      reference_no: referenceNo,
      priority,
      department_id: routing.department_id
    }, req);

    const response = {
      complaint: {
        id: complaintId,
        reference_no: referenceNo,
        status: "Submitted",
        priority,
        due_at: dueAt.toISOString(),
        target_hours: targetHours,
        department_id: routing.department_id,
        routed_to_review_queue: routing.review_required,
        subcategory_name: subcategory.name,
        category_name: category ? category.name : null
      },
      message: `Complaint registered successfully. Your reference number is ${referenceNo}.`
    };

    // Duplicate warning is returned after saving: the complaint is always kept.
    response.possible_duplicates = await findPossibleDuplicates({
      excludeId: complaintId,
      categoryId: category ? category.id : null,
      subcategoryId: subcategory.id,
      description: `${req.body.title} ${req.body.description}`,
      latitude: validLatitude(req.body.latitude),
      longitude: validLongitude(req.body.longitude)
    });

    await notify(
      req.user.id,
      complaintId,
      "complaint_submitted",
      "Complaint registered",
      `Your complaint ${referenceNo} has been received and is awaiting review.`
    );

    res.status(201).json(response);
  })
);

// ---------------------------------------------------------------------------
// GET /api/complaints — list (citizens see their own, staff see everything)
// ---------------------------------------------------------------------------
router.get(
  "/",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const staff = isStaff(req.user);
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: staff ? 25 : 50 });
    const { clause, params } = buildFilters(req, { forceOwnerId: staff ? null : req.user.id });

    const sortKey = SORTABLE[req.query.sort] || SORTABLE.created_at;
    const direction = String(req.query.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const rows = await all(
      `${LIST_SELECT} ${clause} ORDER BY ${sortKey} ${direction}, c.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = await get(
      `SELECT COUNT(*) AS total FROM complaints c ${clause}`,
      params
    );
    const total = countRow ? countRow.total : 0;

    res.json({
      items: rows.map((row) => shapeComplaint(row, req.user)),
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

// GET /api/complaints/summary — real counts for the citizen dashboard (Phase 8)
router.get(
  "/summary",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const ownerId = isStaff(req.user) && req.query.scope === "all" ? null : req.user.id;
    const scope = ownerId ? "AND user_id = ?" : "";
    const params = ownerId ? [ownerId] : [];

    const rows = await all(
      `SELECT status, COUNT(*) AS count FROM complaints WHERE 1=1 ${scope} GROUP BY status`,
      params
    );
    const byStatus = {};
    for (const status of ["Submitted", "Under Review", "Assigned", "In Progress", "Resolved", "Rejected", "Reopened", "Closed"]) {
      byStatus[status] = 0;
    }
    let total = 0;
    for (const row of rows) {
      byStatus[row.status] = row.count;
      total += row.count;
    }
    const recent = await all(
      `SELECT id, reference_no, title, status, priority, created_at, last_activity_at
       FROM complaints WHERE 1=1 ${scope} ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 5`,
      params
    );
    res.json({
      total,
      by_status: byStatus,
      open: OPEN_STATUSES.reduce((sum, s) => sum + (byStatus[s] || 0), 0),
      resolved: byStatus.Resolved || 0,
      reopened: byStatus.Reopened || 0,
      recently_updated: recent
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/complaints/:id — full detail with timeline
// ---------------------------------------------------------------------------
router.get(
  "/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid complaint id" });

    const row = await get(`${LIST_SELECT} WHERE c.id = ?`, [id]);
    if (!row) return res.status(404).json({ error: "Complaint not found" });
    if (!canView(req.user, row)) {
      return res.status(403).json({ error: "You do not have access to this complaint" });
    }

    const staff = isStaff(req.user);

    const history = await all(
      `SELECT old_status, new_status, changed_by, remarks, changed_at
       FROM complaint_status_history WHERE complaint_id = ? ORDER BY changed_at ASC, id ASC`,
      [id]
    );
    const notes = await all(
      `SELECT id, author_name, visibility, note, created_at
       FROM complaint_notes WHERE complaint_id = ? ${staff ? "" : "AND visibility = 'citizen'"}
       ORDER BY created_at ASC, id ASC`,
      [id]
    );
    const attachments = await all(
      `SELECT id, kind, original_name, mime_type, size_bytes, created_at
       FROM complaint_attachments WHERE complaint_id = ? ORDER BY created_at ASC, id ASC`,
      [id]
    );
    const assignments = await all(
      `SELECT ca.id, ca.method, ca.note, ca.assigned_by, ca.created_at,
              d.name AS department_name, u.name AS assigned_user_name
       FROM complaint_assignments ca
       LEFT JOIN departments d ON d.id = ca.department_id
       LEFT JOIN users u ON u.id = ca.assigned_user_id
       WHERE ca.complaint_id = ? ORDER BY ca.created_at ASC, ca.id ASC`,
      [id]
    );
    const feedback = await get(
      `SELECT rating, was_resolved, comments, created_at, updated_at
       FROM complaint_feedback WHERE complaint_id = ?`,
      [id]
    );
    const reopenRequests = await all(
      `SELECT id, reason, status, reviewed_by, reviewed_at, review_notes, created_at
       FROM complaint_reopen_requests WHERE complaint_id = ? ORDER BY created_at DESC`,
      [id]
    );
    const duplicates = await all(
      `SELECT cd.id, cd.similarity, cd.reason, cd.status, cd.created_at,
              c.reference_no AS duplicate_reference, c.status AS duplicate_status
       FROM complaint_duplicates cd
       JOIN complaints c ON c.id = cd.duplicate_of_id
       WHERE cd.complaint_id = ?`,
      [id]
    );
    const escalations = await all(
      `SELECT level, escalated_to, reason, created_at, acknowledged_at
       FROM complaint_escalations WHERE complaint_id = ? ORDER BY created_at DESC`,
      [id]
    );

    // Evidence is released through an authorised endpoint, never as a raw path.
    const evidence = attachments.map((a) => ({
      id: a.id,
      kind: a.kind,
      name: a.original_name,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      created_at: a.created_at,
      url: evidenceUrl(id, a.id)
    }));
    if (row.image_path) {
      evidence.unshift({
        id: "legacy",
        kind: "evidence",
        name: path.basename(String(row.image_path)),
        mime_type: null,
        size_bytes: null,
        created_at: row.created_at,
        url: evidenceUrl(id, "legacy")
      });
    }

    const pendingReopen = reopenRequests.find((r) => r.status === "pending") || null;

    res.json({
      complaint: shapeComplaint(row, req.user),
      timeline: history,
      notes,
      evidence,
      assignments,
      feedback: feedback || null,
      reopen_requests: reopenRequests,
      duplicates,
      escalations: staff ? escalations : [],
      permissions: {
        can_submit_feedback: !staff && row.status === "Resolved" && !feedback,
        can_request_reopen:
          !staff && REOPENABLE_STATUSES.includes(row.status) && !pendingReopen,
        can_manage: staff,
        can_add_internal_notes: staff
      }
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/complaints/:id/evidence/:attachmentId — authorised file access
// ---------------------------------------------------------------------------
router.get(
  "/:id/evidence/:attachmentId",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM complaints WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Complaint not found" });
    if (!canView(req.user, row)) {
      return res.status(403).json({ error: "You do not have access to this evidence" });
    }

    let storedPath = null;
    let mimeType = null;

    if (req.params.attachmentId === "legacy") {
      storedPath = row.image_path;
    } else {
      const attachment = await get(
        "SELECT * FROM complaint_attachments WHERE id = ? AND complaint_id = ?",
        [Number(req.params.attachmentId), id]
      );
      if (!attachment) return res.status(404).json({ error: "Attachment not found" });
      storedPath = attachment.file_path;
      mimeType = attachment.mime_type;
    }

    const absolute = resolveStoredPath(storedPath);
    if (!absolute) return res.status(404).json({ error: "The file is no longer available" });

    if (mimeType) res.type(mimeType);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(absolute);
  })
);

// ---------------------------------------------------------------------------
// POST /api/complaints/:id/feedback — citizen rating (Phase 10)
// ---------------------------------------------------------------------------
router.post(
  "/:id/feedback",
  authMiddleware,
  [
    body("rating").isInt({ min: 1, max: 5 }).withMessage("Rating must be between 1 and 5"),
    body("was_resolved").optional().isBoolean().withMessage("was_resolved must be true or false"),
    body("comments").optional({ values: "falsy" }).trim().isLength({ max: 1000 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const row = await get("SELECT * FROM complaints WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Complaint not found" });
    if (Number(row.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Only the citizen who filed this complaint can leave feedback" });
    }
    if (row.status !== "Resolved") {
      return res.status(409).json({ error: "Feedback can only be submitted once a complaint is resolved" });
    }

    const existing = await get("SELECT id FROM complaint_feedback WHERE complaint_id = ?", [id]);
    if (existing) {
      return res.status(409).json({ error: "Feedback has already been recorded for this complaint" });
    }

    const wasResolved = req.body.was_resolved === undefined ? true : req.body.was_resolved;
    await run(
      `INSERT INTO complaint_feedback (complaint_id, user_id, rating, was_resolved, comments)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        req.user.id,
        Number(req.body.rating),
        wasResolved ? 1 : 0,
        sanitizeText(req.body.comments, 1000) || null
      ]
    );
    await run(
      `UPDATE complaints SET citizen_satisfaction_rating = ?, citizen_feedback = ? WHERE id = ?`,
      [Number(req.body.rating), sanitizeText(req.body.comments, 1000) || null, id]
    );
    await audit(req.user, "feedback_submitted", "complaint", id, null, {
      rating: Number(req.body.rating),
      was_resolved: !!wasResolved
    }, req);
    await touchComplaint(id);

    res.status(201).json({
      message: wasResolved
        ? "Thank you for your feedback."
        : "Thank you. You can request a reopening if the issue was not resolved."
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/complaints/:id/reopen-request — citizen request (Phase 4 / 10)
// ---------------------------------------------------------------------------
router.post(
  "/:id/reopen-request",
  authMiddleware,
  [body("reason").trim().isLength({ min: 10, max: 1000 }).withMessage("Please describe why the complaint should be reopened")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const row = await get("SELECT * FROM complaints WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Complaint not found" });
    if (Number(row.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Only the citizen who filed this complaint can request a reopening" });
    }
    if (!REOPENABLE_STATUSES.includes(row.status)) {
      return res.status(409).json({
        error: `A complaint in "${row.status}" status cannot be reopened.`
      });
    }

    const pending = await get(
      "SELECT id FROM complaint_reopen_requests WHERE complaint_id = ? AND status = 'pending'",
      [id]
    );
    if (pending) {
      return res.status(409).json({ error: "A reopening request for this complaint is already awaiting review" });
    }

    const result = await run(
      `INSERT INTO complaint_reopen_requests (complaint_id, user_id, reason)
       VALUES (?, ?, ?)`,
      [id, req.user.id, sanitizeText(req.body.reason, 1000)]
    );
    await audit(req.user, "reopen_requested", "complaint", id, { status: row.status }, {
      reopen_request_id: result.lastID
    }, req);
    await touchComplaint(id);

    res.status(201).json({
      message: "Your reopening request has been sent to the department for review."
    });
  })
);

module.exports = router;
