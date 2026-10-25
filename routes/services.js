/**
 * Citizen Services portal API (Phase 9).
 *
 * Exposes the central service taxonomy (categories + subcategories), formal
 * service applications with document upload, municipal office details and
 * public announcements.
 *
 * Services are typed so the UI never presents an information page as if it
 * were an application system:
 *   - item_type = 'complaint'     -> primarily handled by /api/complaints
 *   - item_type = 'application'   -> handled here (tracked with APP- references)
 *   - item_type = 'information'   -> static guidance, optionally with an
 *                                    authorised external official link.
 * Any active service can also be complained about through /api/complaints, so a
 * citizen can report a service that has stalled even when it is not itself a
 * complaint category.
 * No payment is processed and no certificate/approval is fabricated here.
 */
const express = require("express");
const { body, validationResult } = require("express-validator");

const {
  asyncHandler,
  authMiddleware,
  requireStaff,
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
  nextApplicationReference
} = require("../lib/store");
const { parsePagination, sanitizeText, APPLICATION_STATUSES } = require("../lib/civic");
const {
  uploadApplicationDocuments,
  validateMediaSizes,
  cleanupUploads,
  resolveStoredPath
} = require("../upload");

const router = express.Router();

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: "Please correct the highlighted fields",
    errors: errors.array().map((e) => ({ field: e.path, message: e.msg }))
  });
  return true;
}

function categoryTree(categories, subcategories) {
  const byCategory = new Map();
  for (const sub of subcategories) {
    if (!byCategory.has(sub.category_id)) byCategory.set(sub.category_id, []);
    byCategory.get(sub.category_id).push({
      id: sub.id,
      code: sub.code,
      name: sub.name,
      item_type: sub.item_type,
      summary: sub.summary,
      checklist: sub.checklist ? safeJsonArray(sub.checklist) : [],
      processing_time: sub.processing_time,
      official_url: sub.official_url || null,
      department_id: sub.department_id,
      department_name: sub.department_name || null,
      default_priority: sub.default_priority,
      sla_hours: sub.sla_hours
    });
  }
  return categories.map((cat) => ({
    id: cat.id,
    code: cat.code,
    name: cat.name,
    kind: cat.kind,
    description: cat.description,
    is_emergency: cat.is_emergency === 1,
    subcategories: byCategory.get(cat.id) || []
  }));
}

function safeJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return raw ? [String(raw)] : [];
  }
}

// ---------------------------------------------------------------------------
// GET /api/services/categories — full public service taxonomy
// ---------------------------------------------------------------------------
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const params = [];
    let clause = "WHERE cat.is_active = 1";
    if (req.query.kind) {
      clause += " AND cat.kind = ?";
      params.push(String(req.query.kind));
    }
    const categories = await all(
      `SELECT * FROM service_categories cat ${clause} ORDER BY cat.sort_order, cat.name`,
      params
    );
    const subcategories = await all(
      `SELECT s.*, d.name AS department_name
       FROM service_subcategories s
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE s.is_active = 1
       ORDER BY s.sort_order, s.name`
    );
    res.json({ categories: categoryTree(categories, subcategories) });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/categories/:code — one category with its services
// ---------------------------------------------------------------------------
router.get(
  "/categories/:code",
  asyncHandler(async (req, res) => {
    const category = await getCategory(req.params.code);
    if (!category || category.is_active !== 1) {
      return res.status(404).json({ error: "Service category not found" });
    }
    const subcategories = await all(
      `SELECT s.*, d.name AS department_name
       FROM service_subcategories s
       LEFT JOIN departments d ON d.id = s.department_id
       WHERE s.category_id = ? AND s.is_active = 1
       ORDER BY s.sort_order, s.name`,
      [category.id]
    );
    res.json({ category: categoryTree([category], subcategories)[0] });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/wards — configured ward boundaries (read-only reference)
//
// Citizens choose a ward from this list; the system never infers a ward from a
// free-text address (Phase 6).
// ---------------------------------------------------------------------------
router.get(
  "/wards",
  asyncHandler(async (req, res) => {
    const rows = await all(
      "SELECT id, code, name, zone FROM wards WHERE is_active = 1 ORDER BY code"
    );
    res.json({ wards: rows });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/offices — municipal office directory
// ---------------------------------------------------------------------------
router.get(
  "/offices",
  asyncHandler(async (req, res) => {
    const params = [];
    let clause = "WHERE o.is_active = 1";
    if (req.query.ward_id) {
      clause += " AND o.ward_id = ?";
      params.push(Number(req.query.ward_id));
    }
    const rows = await all(
      `SELECT o.id, o.name, o.office_type, o.address, o.phone, o.email,
              o.office_hours, o.map_url, o.ward_id, w.name AS ward_name, w.zone
       FROM municipal_offices o
       LEFT JOIN wards w ON w.id = o.ward_id
       ${clause}
       ORDER BY o.name`,
      params
    );
    res.json({ offices: rows });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/announcements — public notices
// ---------------------------------------------------------------------------
router.get(
  "/announcements",
  asyncHandler(async (req, res) => {
    const limit = parsePagination(req.query, { defaultLimit: 20, maxLimit: 50 }).limit;
    const rows = await all(
      `SELECT id, title, body, published_at
       FROM announcements WHERE is_active = 1
       ORDER BY published_at DESC, id DESC LIMIT ?`,
      [limit]
    );
    res.json({ announcements: rows });
  })
);

// ---------------------------------------------------------------------------
// POST /api/services/applications — submit a formal service application
// ---------------------------------------------------------------------------
router.post(
  "/applications",
  authMiddleware,
  uploadApplicationDocuments,
  validateMediaSizes,
  [
    body("subcategory_id").exists().withMessage("Please choose the service you are applying for"),
    body("applicant_name").trim().isLength({ min: 3, max: 120 }).withMessage("Applicant name is required"),
    body("details").trim().isLength({ min: 15, max: 4000 }).withMessage("Please describe your request in at least 15 characters"),
    body("contact_email").optional({ values: "falsy" }).trim().isEmail().withMessage("Enter a valid email address"),
    body("contact_phone").optional({ values: "falsy" }).trim().isLength({ max: 20 }),
    body("address_text").optional({ values: "falsy" }).trim().isLength({ max: 400 }),
    body("latitude").optional({ values: "falsy" }).isFloat({ min: -90, max: 90 }).withMessage("Invalid latitude"),
    body("longitude")
      .optional({ values: "falsy" })
      .isFloat({ min: -180, max: 180 })
      .withMessage("Invalid longitude"),
    body("ward_id").optional({ values: "falsy" }).isInt({ min: 1 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) {
      cleanupUploads(req);
      return;
    }

    const subcategory = await getSubcategory(req.body.subcategory_id);
    if (!subcategory || subcategory.is_active !== 1) {
      cleanupUploads(req);
      return res.status(400).json({ error: "The selected service is not available" });
    }
    if (subcategory.item_type !== "application") {
      cleanupUploads(req);
      return res.status(400).json({
        error:
          subcategory.item_type === "complaint"
            ? "This service is filed as a complaint. Please use the Complaints section."
            : "This is an information service and cannot be applied for online. Please follow the guidance provided."
      });
    }

    const category = await getCategory(subcategory.category_id);
    const referenceNo = await nextApplicationReference();

    const result = await run(
      `INSERT INTO service_applications
        (reference_no, user_id, category_id, subcategory_id, ward_id, department_id,
         applicant_name, contact_email, contact_phone, address_text, latitude, longitude, details, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted')`,
      [
        referenceNo,
        req.user.id,
        category ? category.id : null,
        subcategory.id,
        req.body.ward_id ? Number(req.body.ward_id) : null,
        subcategory.department_id || null,
        sanitizeText(req.body.applicant_name, 120),
        sanitizeText(req.body.contact_email, 160) || null,
        sanitizeText(req.body.contact_phone, 20) || null,
        sanitizeText(req.body.address_text, 400) || null,
        req.body.latitude ? Number(req.body.latitude) : null,
        req.body.longitude ? Number(req.body.longitude) : null,
        sanitizeText(req.body.details, 4000)
      ]
    );
    const applicationId = result.lastID;

    const files = req.files || {};
    const uploaded = [...(files.documents || []), ...(files.image || [])];
    for (const file of uploaded) {
      await run(
        `INSERT INTO service_application_documents
          (application_id, file_path, original_name, mime_type, size_bytes)
         VALUES (?, ?, ?, ?, ?)`,
        [
          applicationId,
          file.publicPath,
          file.originalname || null,
          file.mimetype || null,
          file.size || null
        ]
      );
    }

    await run(
      `INSERT INTO service_application_history (application_id, old_status, new_status, changed_by)
       VALUES (?, NULL, 'Submitted', ?)`,
      [applicationId, req.user.email || req.user.name]
    );
    await audit(req.user, "application_created", "service_application", applicationId, null, {
      reference_no: referenceNo,
      subcategory_id: subcategory.id
    }, req);
    await notify(
      req.user.id,
      null,
      "application_submitted",
      "Application received",
      `Your application ${referenceNo} has been received and is awaiting review.`
    );

    res.status(201).json({
      application: {
        id: applicationId,
        reference_no: referenceNo,
        status: "Submitted",
        subcategory_name: subcategory.name,
        category_name: category ? category.name : null
      },
      message: `Application submitted successfully. Your reference number is ${referenceNo}.`
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/applications — citizen's own applications (staff: all)
// ---------------------------------------------------------------------------
router.get(
  "/applications",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const staff = isStaff(req.user);
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 25 });
    const where = [];
    const params = [];

    if (!staff) {
      where.push("a.user_id = ?");
      params.push(req.user.id);
    }
    if (req.query.status) {
      where.push("a.status = ?");
      params.push(String(req.query.status));
    }
    if (req.query.subcategory_id) {
      where.push("a.subcategory_id = ?");
      params.push(Number(req.query.subcategory_id));
    }
    if (req.query.search) {
      const term = `%${String(req.query.search).trim()}%`;
      where.push("(a.reference_no LIKE ? OR a.applicant_name LIKE ?)");
      params.push(term, term);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await all(
      `SELECT a.id, a.reference_no, a.status, a.applicant_name, a.created_at, a.updated_at,
              a.reviewer_note,
              cat.name AS category_name, sub.name AS subcategory_name,
              d.name AS department_name
       FROM service_applications a
       LEFT JOIN service_categories cat ON cat.id = a.category_id
       LEFT JOIN service_subcategories sub ON sub.id = a.subcategory_id
       LEFT JOIN departments d ON d.id = a.department_id
       ${clause}
       ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = await get(
      `SELECT COUNT(*) AS total FROM service_applications a ${clause}`,
      params
    );
    const total = countRow ? countRow.total : 0;

    res.json({
      items: rows,
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/applications/:id — full application detail
// ---------------------------------------------------------------------------
router.get(
  "/applications/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid application id" });

    const row = await get("SELECT * FROM service_applications WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Application not found" });
    if (!isStaff(req.user) && Number(row.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You do not have access to this application" });
    }

    const documents = await all(
      `SELECT id, original_name, mime_type, size_bytes, created_at
       FROM service_application_documents WHERE application_id = ? ORDER BY created_at ASC, id ASC`,
      [id]
    );
    const history = await all(
      `SELECT old_status, new_status, changed_by, changed_at
       FROM service_application_history WHERE application_id = ? ORDER BY changed_at ASC, id ASC`,
      [id]
    );
    const subcategory = row.subcategory_id ? await getSubcategory(row.subcategory_id) : null;
    const category = row.category_id ? await getCategory(row.category_id) : null;

    res.json({
      application: {
        id: row.id,
        reference_no: row.reference_no,
        status: row.status,
        applicant_name: row.applicant_name,
        contact_email: row.contact_email,
        contact_phone: row.contact_phone,
        address_text: row.address_text,
        latitude: row.latitude,
        longitude: row.longitude,
        details: row.details,
        category_name: category ? category.name : null,
        subcategory_name: subcategory ? subcategory.name : null,
        reviewer_note: row.reviewer_note,
        created_at: row.created_at,
        updated_at: row.updated_at
      },
      documents: documents.map((d) => ({
        id: d.id,
        name: d.original_name,
        mime_type: d.mime_type,
        size_bytes: d.size_bytes,
        created_at: d.created_at,
        url: `/api/services/applications/${id}/documents/${d.id}`
      })),
      history
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/services/applications/:id/documents/:documentId — authorised file
// ---------------------------------------------------------------------------
router.get(
  "/applications/:id/documents/:documentId",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_applications WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Application not found" });
    if (!isStaff(req.user) && Number(row.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "You do not have access to this document" });
    }

    const document = await get(
      "SELECT * FROM service_application_documents WHERE id = ? AND application_id = ?",
      [Number(req.params.documentId), id]
    );
    if (!document) return res.status(404).json({ error: "Document not found" });

    const absolute = resolveStoredPath(document.file_path);
    if (!absolute) return res.status(404).json({ error: "The file is no longer available" });

    if (document.mime_type) res.type(document.mime_type);
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.sendFile(absolute);
  })
);

// ---------------------------------------------------------------------------
// PATCH /api/services/applications/:id/status — staff review (Phase 5)
// ---------------------------------------------------------------------------
router.patch(
  "/applications/:id/status",
  requireStaff,
  [
    body("status").isIn(APPLICATION_STATUSES).withMessage("Invalid application status"),
    body("reviewer_note").optional({ values: "falsy" }).trim().isLength({ max: 2000 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_applications WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Application not found" });

    const newStatus = String(req.body.status);
    if (newStatus === row.status) {
      return res.status(409).json({ error: `The application is already in "${newStatus}" status` });
    }
    if (newStatus === "Rejected" && !sanitizeText(req.body.reviewer_note, 2000)) {
      return res.status(400).json({ error: "Please provide a reason when rejecting an application" });
    }

    const reviewerNote = sanitizeText(req.body.reviewer_note, 2000) || null;
    await run(
      "UPDATE service_applications SET status = ?, reviewer_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [newStatus, reviewerNote, id]
    );
    await run(
      `INSERT INTO service_application_history (application_id, old_status, new_status, changed_by)
       VALUES (?, ?, ?, ?)`,
      [id, row.status, newStatus, req.user.email || req.user.name]
    );
    await audit(req.user, "application_status_changed", "service_application", id,
      { status: row.status }, { status: newStatus }, req);
    await notify(
      row.user_id,
      null,
      "application_status",
      "Application updated",
      `Your application ${row.reference_no} is now "${newStatus}".`
    );

    res.json({ message: `Application marked as ${newStatus}`, status: newStatus });
  })
);

module.exports = router;
