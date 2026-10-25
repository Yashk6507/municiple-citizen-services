/**
 * Administrator configuration API (Phase 2 and Phase 5).
 *
 * Mounted at /api/admin. Every route requires the 'admin' role. Staff accounts,
 * the service taxonomy, departments, wards, SLA targets, offices, public
 * announcements and application settings are all managed here.
 *
 * "Deleting" reference data deactivates it (is_active = 0) so historical
 * complaints keep their category, ward and department information.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const { asyncHandler, requireAdmin } = require("../middleware");
const { all, get, run, audit, setSetting } = require("../lib/store");
const {
  PRIORITIES,
  parsePagination,
  sanitizeText,
  clampInt
} = require("../lib/civic");

const router = express.Router();

router.use(requireAdmin);

function validationErrors(req, res) {
  const errors = validationResult(req);
  if (errors.isEmpty()) return false;
  res.status(400).json({
    error: "Please correct the highlighted fields",
    errors: errors.array().map((e) => ({ field: e.path, message: e.msg }))
  });
  return true;
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// Service categories
// ---------------------------------------------------------------------------
router.get(
  "/categories",
  asyncHandler(async (req, res) => {
    const rows = await all(
      "SELECT * FROM service_categories ORDER BY sort_order, name"
    );
    res.json({ categories: rows });
  })
);

router.post(
  "/categories",
  [
    body("name").trim().isLength({ min: 3, max: 120 }).withMessage("Category name is required"),
    body("kind").optional().isIn(["complaint", "service", "mixed"]).withMessage("Invalid category kind")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const name = sanitizeText(req.body.name, 120);
    const code = slug(req.body.code || name);
    if (!code) return res.status(400).json({ error: "A category code could not be generated" });

    const existing = await get("SELECT id FROM service_categories WHERE code = ?", [code]);
    if (existing) return res.status(409).json({ error: "A category with this code already exists" });

    const result = await run(
      `INSERT INTO service_categories (code, name, kind, description, is_emergency, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        code,
        name,
        ["complaint", "service", "mixed"].includes(req.body.kind) ? req.body.kind : "complaint",
        sanitizeText(req.body.description, 500) || null,
        req.body.is_emergency ? 1 : 0,
        clampInt(req.body.sort_order, 0, 9999, 100)
      ]
    );
    await audit(req.user, "category_created", "service_category", result.lastID, null, { code, name }, req);
    res.status(201).json({ message: "Category created", id: result.lastID, code });
  })
);

router.patch(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_categories WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Category not found" });

    const updates = [];
    const params = [];
    if (req.body.name !== undefined) {
      updates.push("name = ?");
      params.push(sanitizeText(req.body.name, 120));
    }
    if (req.body.description !== undefined) {
      updates.push("description = ?");
      params.push(sanitizeText(req.body.description, 500) || null);
    }
    if (req.body.kind !== undefined && ["complaint", "service", "mixed"].includes(req.body.kind)) {
      updates.push("kind = ?");
      params.push(req.body.kind);
    }
    if (req.body.is_emergency !== undefined) {
      updates.push("is_emergency = ?");
      params.push(req.body.is_emergency ? 1 : 0);
    }
    if (req.body.sort_order !== undefined) {
      updates.push("sort_order = ?");
      params.push(clampInt(req.body.sort_order, 0, 9999, row.sort_order));
    }
    if (req.body.is_active !== undefined) {
      updates.push("is_active = ?");
      params.push(req.body.is_active ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });

    params.push(id);
    await run(`UPDATE service_categories SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "category_updated", "service_category", id, row, req.body, req);
    res.json({ message: "Category updated" });
  })
);

router.delete(
  "/categories/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_categories WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Category not found" });
    await run("UPDATE service_categories SET is_active = 0 WHERE id = ?", [id]);
    await audit(req.user, "category_deactivated", "service_category", id, { is_active: 1 }, { is_active: 0 }, req);
    res.json({ message: "Category deactivated. Existing complaints are unchanged." });
  })
);

// ---------------------------------------------------------------------------
// Service subcategories (this table also holds the routing rules)
// ---------------------------------------------------------------------------
router.get(
  "/subcategories",
  asyncHandler(async (req, res) => {
    const params = [];
    let clause = "";
    if (req.query.category_id) {
      clause = "WHERE s.category_id = ?";
      params.push(Number(req.query.category_id));
    }
    const rows = await all(
      `SELECT s.*, cat.name AS category_name, d.name AS department_name
       FROM service_subcategories s
       LEFT JOIN service_categories cat ON cat.id = s.category_id
       LEFT JOIN departments d ON d.id = s.department_id
       ${clause}
       ORDER BY s.sort_order, s.name`,
      params
    );
    res.json({ subcategories: rows });
  })
);

function serialiseChecklist(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => sanitizeText(v, 200)));
  return sanitizeText(value, 2000) || null;
}

router.post(
  "/subcategories",
  [
    body("category_id").isInt({ min: 1 }).withMessage("A parent category is required"),
    body("name").trim().isLength({ min: 3, max: 160 }).withMessage("Service name is required"),
    body("item_type").optional().isIn(["complaint", "application", "information"]).withMessage("Invalid service type"),
    body("default_priority").optional().isIn(PRIORITIES).withMessage("Invalid default priority"),
    body("official_url").optional({ values: "falsy" }).trim().isURL({ require_protocol: true }).withMessage("Official link must be a full URL")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const category = await get("SELECT id FROM service_categories WHERE id = ?", [Number(req.body.category_id)]);
    if (!category) return res.status(400).json({ error: "The selected category does not exist" });

    const name = sanitizeText(req.body.name, 160);
    const code = slug(req.body.code || name);
    const existing = await get("SELECT id FROM service_subcategories WHERE code = ?", [code]);
    if (existing) return res.status(409).json({ error: "A service with this code already exists" });

    const checklist = serialiseChecklist(req.body.checklist);
    const result = await run(
      `INSERT INTO service_subcategories
        (category_id, code, name, item_type, summary, checklist, processing_time, official_url,
         department_id, default_priority, sla_hours, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(req.body.category_id),
        code,
        name,
        ["complaint", "application", "information"].includes(req.body.item_type) ? req.body.item_type : "complaint",
        sanitizeText(req.body.summary, 500) || null,
        checklist === undefined ? null : checklist,
        sanitizeText(req.body.processing_time, 120) || null,
        sanitizeText(req.body.official_url, 300) || null,
        req.body.department_id ? Number(req.body.department_id) : null,
        PRIORITIES.includes(req.body.default_priority) ? req.body.default_priority : "medium",
        req.body.sla_hours !== undefined ? clampInt(req.body.sla_hours, 1, 8760, null) : null,
        clampInt(req.body.sort_order, 0, 9999, 100)
      ]
    );
    await audit(req.user, "subcategory_created", "service_subcategory", result.lastID, null, { code, name }, req);
    res.status(201).json({ message: "Service created", id: result.lastID, code });
  })
);

router.patch(
  "/subcategories/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_subcategories WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Service not found" });

    const updates = [];
    const params = [];
    const setValue = (column, value) => {
      updates.push(`${column} = ?`);
      params.push(value);
    };

    if (req.body.name !== undefined) setValue("name", sanitizeText(req.body.name, 160));
    if (req.body.item_type !== undefined && ["complaint", "application", "information"].includes(req.body.item_type)) {
      setValue("item_type", req.body.item_type);
    }
    if (req.body.summary !== undefined) setValue("summary", sanitizeText(req.body.summary, 500) || null);
    if (req.body.checklist !== undefined) setValue("checklist", serialiseChecklist(req.body.checklist));
    if (req.body.processing_time !== undefined) setValue("processing_time", sanitizeText(req.body.processing_time, 120) || null);
    if (req.body.official_url !== undefined) setValue("official_url", sanitizeText(req.body.official_url, 300) || null);
    if (req.body.department_id !== undefined) {
      setValue("department_id", req.body.department_id ? Number(req.body.department_id) : null);
    }
    if (req.body.default_priority !== undefined && PRIORITIES.includes(req.body.default_priority)) {
      setValue("default_priority", req.body.default_priority);
    }
    if (req.body.sla_hours !== undefined) {
      setValue("sla_hours", req.body.sla_hours === null ? null : clampInt(req.body.sla_hours, 1, 8760, null));
    }
    if (req.body.sort_order !== undefined) setValue("sort_order", clampInt(req.body.sort_order, 0, 9999, row.sort_order));
    if (req.body.is_active !== undefined) setValue("is_active", req.body.is_active ? 1 : 0);
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });

    params.push(id);
    await run(`UPDATE service_subcategories SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "subcategory_updated", "service_subcategory", id, row, req.body, req);
    res.json({ message: "Service updated" });
  })
);

router.delete(
  "/subcategories/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM service_subcategories WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Service not found" });
    await run("UPDATE service_subcategories SET is_active = 0 WHERE id = ?", [id]);
    await audit(req.user, "subcategory_deactivated", "service_subcategory", id, { is_active: 1 }, { is_active: 0 }, req);
    res.json({ message: "Service deactivated. Existing complaints are unchanged." });
  })
);

// ---------------------------------------------------------------------------
// Departments (routing targets)
// ---------------------------------------------------------------------------
router.get(
  "/departments",
  asyncHandler(async (req, res) => {
    const rows = await all("SELECT * FROM departments ORDER BY name");
    res.json({ departments: rows });
  })
);

router.post(
  "/departments",
  [body("name").trim().isLength({ min: 3, max: 120 }).withMessage("Department name is required")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const name = sanitizeText(req.body.name, 120);
    const code = slug(req.body.code || name);
    const existing = await get("SELECT id FROM departments WHERE code = ?", [code]);
    if (existing) return res.status(409).json({ error: "A department with this code already exists" });
    const result = await run(
      `INSERT INTO departments (code, name, description, contact_email, contact_phone)
       VALUES (?, ?, ?, ?, ?)`,
      [
        code,
        name,
        sanitizeText(req.body.description, 500) || null,
        sanitizeText(req.body.contact_email, 160) || null,
        sanitizeText(req.body.contact_phone, 20) || null
      ]
    );
    await audit(req.user, "department_created", "department", result.lastID, null, { code, name }, req);
    res.status(201).json({ message: "Department created", id: result.lastID, code });
  })
);

router.patch(
  "/departments/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM departments WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Department not found" });
    const updates = [];
    const params = [];
    if (req.body.name !== undefined) { updates.push("name = ?"); params.push(sanitizeText(req.body.name, 120)); }
    if (req.body.description !== undefined) { updates.push("description = ?"); params.push(sanitizeText(req.body.description, 500) || null); }
    if (req.body.contact_email !== undefined) { updates.push("contact_email = ?"); params.push(sanitizeText(req.body.contact_email, 160) || null); }
    if (req.body.contact_phone !== undefined) { updates.push("contact_phone = ?"); params.push(sanitizeText(req.body.contact_phone, 20) || null); }
    if (req.body.is_active !== undefined) { updates.push("is_active = ?"); params.push(req.body.is_active ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });
    params.push(id);
    await run(`UPDATE departments SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "department_updated", "department", id, row, req.body, req);
    res.json({ message: "Department updated" });
  })
);

// ---------------------------------------------------------------------------
// Wards (administrative boundaries — never inferred from an address)
// ---------------------------------------------------------------------------
router.get(
  "/wards",
  asyncHandler(async (req, res) => {
    const rows = await all("SELECT * FROM wards ORDER BY code");
    res.json({ wards: rows });
  })
);

router.post(
  "/wards",
  [
    body("code").trim().isLength({ min: 1, max: 20 }).withMessage("Ward code is required"),
    body("name").trim().isLength({ min: 2, max: 120 }).withMessage("Ward name is required")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const code = sanitizeText(req.body.code, 20);
    const existing = await get("SELECT id FROM wards WHERE code = ?", [code]);
    if (existing) return res.status(409).json({ error: "A ward with this code already exists" });
    const result = await run(
      `INSERT INTO wards (code, name, zone, description) VALUES (?, ?, ?, ?)`,
      [
        code,
        sanitizeText(req.body.name, 120),
        sanitizeText(req.body.zone, 60) || null,
        sanitizeText(req.body.description, 400) || null
      ]
    );
    await audit(req.user, "ward_created", "ward", result.lastID, null, { code }, req);
    res.status(201).json({ message: "Ward created", id: result.lastID, code });
  })
);

router.patch(
  "/wards/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM wards WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Ward not found" });
    const updates = [];
    const params = [];
    if (req.body.name !== undefined) { updates.push("name = ?"); params.push(sanitizeText(req.body.name, 120)); }
    if (req.body.zone !== undefined) { updates.push("zone = ?"); params.push(sanitizeText(req.body.zone, 60) || null); }
    if (req.body.description !== undefined) { updates.push("description = ?"); params.push(sanitizeText(req.body.description, 400) || null); }
    if (req.body.is_active !== undefined) { updates.push("is_active = ?"); params.push(req.body.is_active ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });
    params.push(id);
    await run(`UPDATE wards SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "ward_updated", "ward", id, row, req.body, req);
    res.json({ message: "Ward updated" });
  })
);

// ---------------------------------------------------------------------------
// SLA policies (internal targets, not legal mandates)
// ---------------------------------------------------------------------------
router.get(
  "/sla-policies",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT sp.*, cat.name AS category_name
       FROM sla_policies sp
       LEFT JOIN service_categories cat ON cat.id = sp.category_id
       ORDER BY sp.priority, sp.category_id`
    );
    res.json({
      policies: rows,
      note: "These are internally configured municipal resolution targets, not legally mandated service levels."
    });
  })
);

router.post(
  "/sla-policies",
  [
    body("priority").isIn(PRIORITIES).withMessage("Invalid priority"),
    body("target_hours").isInt({ min: 1, max: 8760 }).withMessage("Target hours must be between 1 and 8760")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
    const result = await run(
      `INSERT INTO sla_policies (priority, category_id, target_hours) VALUES (?, ?, ?)`,
      [req.body.priority, categoryId, Number(req.body.target_hours)]
    );
    await audit(req.user, "sla_policy_created", "sla_policy", result.lastID, null, req.body, req);
    res.status(201).json({ message: "SLA target created", id: result.lastID });
  })
);

router.patch(
  "/sla-policies/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM sla_policies WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "SLA target not found" });
    const updates = [];
    const params = [];
    if (req.body.target_hours !== undefined) {
      updates.push("target_hours = ?");
      params.push(clampInt(req.body.target_hours, 1, 8760, row.target_hours));
    }
    if (req.body.is_active !== undefined) {
      updates.push("is_active = ?");
      params.push(req.body.is_active ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });
    params.push(id);
    await run(`UPDATE sla_policies SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "sla_policy_updated", "sla_policy", id, row, req.body, req);
    res.json({ message: "SLA target updated" });
  })
);

// ---------------------------------------------------------------------------
// Staff accounts
// ---------------------------------------------------------------------------
router.get(
  "/staff-users",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT u.id, u.name, u.email, u.role, u.phone, u.designation, u.department_id,
              u.ward_id, u.is_active, u.last_login_at, u.created_at,
              d.name AS department_name, w.name AS ward_name
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
       LEFT JOIN wards w ON w.id = u.ward_id
       WHERE u.role IN ('staff','admin')
       ORDER BY u.role DESC, u.name`
    );
    res.json({ users: rows });
  })
);

router.post(
  "/staff-users",
  [
    body("name").trim().isLength({ min: 3, max: 120 }).withMessage("Full name is required"),
    body("email").isEmail().withMessage("A valid email address is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("role").isIn(["staff", "admin"]).withMessage("Role must be staff or admin")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const email = String(req.body.email).trim().toLowerCase();
    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const departmentId = req.body.department_id ? Number(req.body.department_id) : null;
    if (req.body.role === "staff" && !departmentId) {
      return res.status(400).json({ error: "A department must be selected for a staff account" });
    }
    if (departmentId) {
      const dept = await get("SELECT id FROM departments WHERE id = ?", [departmentId]);
      if (!dept) return res.status(400).json({ error: "The selected department does not exist" });
    }

    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, phone, designation, department_id, ward_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sanitizeText(req.body.name, 120),
        email,
        bcrypt.hashSync(String(req.body.password), 10),
        req.body.role,
        sanitizeText(req.body.phone, 20) || null,
        sanitizeText(req.body.designation, 120) || null,
        departmentId,
        req.body.ward_id ? Number(req.body.ward_id) : null
      ]
    );
    await audit(req.user, "staff_created", "user", result.lastID, null, { email, role: req.body.role }, req);
    res.status(201).json({ message: "Staff account created", id: result.lastID });
  })
);

router.patch(
  "/staff-users/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM users WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Account not found" });

    const updates = [];
    const params = [];
    if (req.body.name !== undefined) { updates.push("name = ?"); params.push(sanitizeText(req.body.name, 120)); }
    if (req.body.phone !== undefined) { updates.push("phone = ?"); params.push(sanitizeText(req.body.phone, 20) || null); }
    if (req.body.designation !== undefined) { updates.push("designation = ?"); params.push(sanitizeText(req.body.designation, 120) || null); }
    if (req.body.role !== undefined && ["staff", "admin", "user"].includes(req.body.role)) {
      updates.push("role = ?");
      params.push(req.body.role);
    }
    if (req.body.department_id !== undefined) {
      updates.push("department_id = ?");
      params.push(req.body.department_id ? Number(req.body.department_id) : null);
    }
    if (req.body.ward_id !== undefined) {
      updates.push("ward_id = ?");
      params.push(req.body.ward_id ? Number(req.body.ward_id) : null);
    }
    if (req.body.is_active !== undefined) {
      updates.push("is_active = ?");
      params.push(req.body.is_active ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });

    params.push(id);
    await run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "staff_updated", "user", id, { role: row.role, is_active: row.is_active }, req.body, req);
    res.json({ message: "Account updated" });
  })
);

router.post(
  "/staff-users/:id/reset-password",
  [body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const id = Number(req.params.id);
    const row = await get("SELECT id FROM users WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Account not found" });
    await run("UPDATE users SET password_hash = ? WHERE id = ?", [
      bcrypt.hashSync(String(req.body.password), 10),
      id
    ]);
    await audit(req.user, "staff_password_reset", "user", id, null, null, req);
    res.json({ message: "Password updated" });
  })
);

// ---------------------------------------------------------------------------
// Public announcements
// ---------------------------------------------------------------------------
router.get(
  "/announcements",
  asyncHandler(async (req, res) => {
    const rows = await all("SELECT * FROM announcements ORDER BY published_at DESC, id DESC");
    res.json({ announcements: rows });
  })
);

router.post(
  "/announcements",
  [body("title").trim().isLength({ min: 3, max: 200 }).withMessage("Title is required")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const result = await run(
      "INSERT INTO announcements (title, body, is_active) VALUES (?, ?, ?)",
      [sanitizeText(req.body.title, 200), sanitizeText(req.body.body, 5000) || null, req.body.is_active === false ? 0 : 1]
    );
    await audit(req.user, "announcement_created", "announcement", result.lastID, null, { title: req.body.title }, req);
    res.status(201).json({ message: "Announcement published", id: result.lastID });
  })
);

router.patch(
  "/announcements/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM announcements WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Announcement not found" });
    const updates = [];
    const params = [];
    if (req.body.title !== undefined) { updates.push("title = ?"); params.push(sanitizeText(req.body.title, 200)); }
    if (req.body.body !== undefined) { updates.push("body = ?"); params.push(sanitizeText(req.body.body, 5000) || null); }
    if (req.body.is_active !== undefined) { updates.push("is_active = ?"); params.push(req.body.is_active ? 1 : 0); }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });
    params.push(id);
    await run(`UPDATE announcements SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "announcement_updated", "announcement", id, row, req.body, req);
    res.json({ message: "Announcement updated" });
  })
);

// ---------------------------------------------------------------------------
// Municipal offices directory
// ---------------------------------------------------------------------------
router.get(
  "/offices",
  asyncHandler(async (req, res) => {
    const rows = await all("SELECT * FROM municipal_offices ORDER BY name");
    res.json({ offices: rows });
  })
);

router.post(
  "/offices",
  [body("name").trim().isLength({ min: 3, max: 160 }).withMessage("Office name is required")],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;
    const result = await run(
      `INSERT INTO municipal_offices (name, office_type, ward_id, address, phone, email, office_hours, map_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sanitizeText(req.body.name, 160),
        sanitizeText(req.body.office_type, 80) || null,
        req.body.ward_id ? Number(req.body.ward_id) : null,
        sanitizeText(req.body.address, 400) || null,
        sanitizeText(req.body.phone, 20) || null,
        sanitizeText(req.body.email, 160) || null,
        sanitizeText(req.body.office_hours, 160) || null,
        sanitizeText(req.body.map_url, 300) || null
      ]
    );
    await audit(req.user, "office_created", "municipal_office", result.lastID, null, { name: req.body.name }, req);
    res.status(201).json({ message: "Office created", id: result.lastID });
  })
);

router.patch(
  "/offices/:id",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const row = await get("SELECT * FROM municipal_offices WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Office not found" });
    const updates = [];
    const params = [];
    const fields = ["name", "office_type", "address", "phone", "email", "office_hours", "map_url"];
    for (const field of fields) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(sanitizeText(req.body[field], 400) || null);
      }
    }
    if (req.body.ward_id !== undefined) {
      updates.push("ward_id = ?");
      params.push(req.body.ward_id ? Number(req.body.ward_id) : null);
    }
    if (req.body.is_active !== undefined) {
      updates.push("is_active = ?");
      params.push(req.body.is_active ? 1 : 0);
    }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });
    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(id);
    await run(`UPDATE municipal_offices SET ${updates.join(", ")} WHERE id = ?`, params);
    await audit(req.user, "office_updated", "municipal_office", id, row, req.body, req);
    res.json({ message: "Office updated" });
  })
);

// ---------------------------------------------------------------------------
// Application settings
// ---------------------------------------------------------------------------
const EDITABLE_SETTINGS = {
  escalation_enabled: { type: "boolean", default: "1" },
  escalation_interval_minutes: { type: "number", min: 5, max: 1440, default: 60 },
  duplicate_radius_meters: { type: "number", min: 50, max: 5000, default: 300 },
  duplicate_similarity: { type: "number", min: 0.2, max: 0.95, default: 0.55 },
  public_min_group_count: { type: "number", min: 1, max: 50, default: 3 },
  email_alerts_enabled: { type: "boolean", default: "1" },
  support_inbox: { type: "text", maxLength: 160, default: "" }
};

router.get(
  "/settings",
  asyncHandler(async (req, res) => {
    const rows = await all("SELECT key, value, updated_at FROM app_settings ORDER BY key");
    res.json({
      settings: rows,
      editable_keys: Object.keys(EDITABLE_SETTINGS)
    });
  })
);

router.put(
  "/settings",
  asyncHandler(async (req, res) => {
    const payload = req.body && typeof req.body === "object" ? req.body : {};
    const applied = {};
    for (const [key, raw] of Object.entries(payload)) {
      const rule = EDITABLE_SETTINGS[key];
      if (!rule) continue; // ignore unknown / internal keys
      let value;
      if (rule.type === "boolean") {
        value = raw === true || raw === "1" || raw === 1 || raw === "true" ? "1" : "0";
      } else if (rule.type === "text") {
        value = sanitizeText(raw, rule.maxLength || 200) || "";
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        value = String(Math.min(rule.max, Math.max(rule.min, n)));
      }
      await setSetting(key, value);
      applied[key] = value;
    }
    if (!Object.keys(applied).length) {
      return res.status(400).json({ error: "No recognised settings were provided" });
    }
    await audit(req.user, "settings_updated", "app_settings", null, null, applied, req);
    res.json({ message: "Settings updated", applied });
  })
);

// ---------------------------------------------------------------------------
// Payment Management Endpoints
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/payments — list all payment transactions with filters
 */
router.get(
  "/payments",
  asyncHandler(async (req, res) => {
    const { status, service_type, search, user_id, page = 1, limit = 25 } = req.query;
    const offset = Math.max((Number(page) - 1) * limit, 0);

    const where = ["1=1"];
    const params = [];

    if (status) {
      where.push("pt.status = ?");
      params.push(status);
    }
    if (service_type) {
      where.push("b.service_type = ?");
      params.push(service_type);
    }
    if (search) {
      const term = `%${String(search).trim()}%`;
      where.push("(b.account_number LIKE ? OR b.bill_number LIKE ? OR pt.gateway_payment_id LIKE ? OR u.name LIKE ? OR u.email LIKE ?)");
      params.push(term, term, term, term, term);
    }
    if (user_id) {
      where.push("pt.user_id = ?");
      params.push(Number(user_id));
    }

    const clause = where.join(" AND ");

    const rows = await all(
      `SELECT pt.*,
              b.service_type, b.account_number, b.bill_number, b.provider_name, b.amount_due AS bill_amount_due,
              u.name AS user_name, u.email AS user_email,
              pr.receipt_number
       FROM payment_transactions pt
       JOIN bills b ON b.id = pt.bill_id
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN payment_receipts pr ON pr.transaction_id = pt.id
       WHERE ${clause}
       ORDER BY pt.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countRow = await get(
      `SELECT COUNT(*) AS total FROM payment_transactions pt JOIN bills b ON b.id = pt.bill_id JOIN users u ON u.id = pt.user_id WHERE ${clause}`,
      params
    );

    // Summary statistics
    const stats = await get(
      `SELECT
        COUNT(*) as total_count,
        SUM(CASE WHEN pt.status = 'captured' THEN 1 ELSE 0 END) as successful_count,
        SUM(CASE WHEN pt.status = 'captured' THEN pt.amount ELSE 0 END) as total_collected,
        SUM(CASE WHEN pt.status = 'failed' THEN 1 ELSE 0 END) as failed_count,
        SUM(CASE WHEN pt.status = 'pending' THEN 1 ELSE 0 END) as pending_count
       FROM payment_transactions pt`
    );

    res.json({
      transactions: rows,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
      total_pages: Math.max(1, Math.ceil((countRow?.total || 0) / limit)),
      stats: {
        total_count: stats?.total_count || 0,
        successful_count: stats?.successful_count || 0,
        total_collected: stats?.total_collected || 0,
        failed_count: stats?.failed_count || 0,
        pending_count: stats?.pending_count || 0
      }
    });
  })
);

/**
 * GET /api/admin/payments/export — export payments to CSV
 */
router.get(
  "/payments/export",
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT pt.id, pt.created_at, pt.gateway, pt.gateway_payment_id, pt.gateway_order_id,
              pt.amount, pt.currency, pt.status, pt.method, pt.verified_by,
              b.service_type, b.account_number, b.bill_number, b.provider_name,
              u.name AS user_name, u.email AS user_email,
              pr.receipt_number
       FROM payment_transactions pt
       JOIN bills b ON b.id = pt.bill_id
       JOIN users u ON u.id = pt.user_id
       LEFT JOIN payment_receipts pr ON pr.transaction_id = pt.id
       ORDER BY pt.created_at DESC`
    );

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const header = [
      "Transaction ID", "Date", "Service Type", "Account Number", "Bill Number",
      "Amount (₹)", "Status", "Payment Method", "Gateway", "Payment ID",
      "User Name", "User Email", "Receipt Number", "Verification Method"
    ].join(",");

    const lines = rows.map((r) => [
      r.id,
      escapeCsv(r.created_at),
      escapeCsv(r.service_type),
      escapeCsv(r.account_number),
      escapeCsv(r.bill_number || ""),
      (r.amount / 100).toFixed(2),
      escapeCsv(r.status),
      escapeCsv(r.method || ""),
      escapeCsv(r.gateway),
      escapeCsv(r.gateway_payment_id || ""),
      escapeCsv(r.user_name),
      escapeCsv(r.user_email),
      escapeCsv(r.receipt_number || ""),
      escapeCsv(r.verified_by || "")
    ].join(","));

    const csvContent = [header, ...lines].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="municipal_payments_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvContent);
  })
);

/**
 * GET /api/admin/bills — list all bills for administrative management
 */
router.get(
  "/bills",
  asyncHandler(async (req, res) => {
    const { status, service_type, search, page = 1, limit = 25 } = req.query;
    const offset = Math.max((Number(page) - 1) * limit, 0);

    const where = ["1=1"];
    const params = [];

    if (status) {
      where.push("b.status = ?");
      params.push(status);
    }
    if (service_type) {
      where.push("b.service_type = ?");
      params.push(service_type);
    }
    if (search) {
      const term = `%${String(search).trim()}%`;
      where.push("(b.account_number LIKE ? OR b.bill_number LIKE ? OR u.name LIKE ? OR u.email LIKE ?)");
      params.push(term, term, term, term);
    }

    const clause = where.join(" AND ");

    const rows = await all(
      `SELECT b.*, u.name AS user_name, u.email AS user_email
       FROM bills b
       JOIN users u ON u.id = b.user_id
       WHERE ${clause}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const countRow = await get(
      `SELECT COUNT(*) AS total FROM bills b JOIN users u ON u.id = b.user_id WHERE ${clause}`,
      params
    );

    res.json({
      bills: rows,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
      total_pages: Math.max(1, Math.ceil((countRow?.total || 0) / limit))
    });
  })
);

// ---------------------------------------------------------------------------
// Audit trail (read-only)
// ---------------------------------------------------------------------------
router.get(
  "/audit-logs",
  asyncHandler(async (req, res) => {
    const { limit, page, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const where = [];
    const params = [];
    if (req.query.action) {
      where.push("action = ?");
      params.push(String(req.query.action));
    }
    if (req.query.entity_type) {
      where.push("entity_type = ?");
      params.push(String(req.query.entity_type));
    }
    if (req.query.entity_id) {
      where.push("entity_id = ?");
      params.push(Number(req.query.entity_id));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const rows = await all(
      `SELECT id, user_id, actor_email, action, entity_type, entity_id, created_at
       FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const countRow = await get(`SELECT COUNT(*) AS total FROM audit_logs ${clause}`, params);
    res.json({
      items: rows,
      page,
      limit,
      total: countRow ? countRow.total : 0,
      total_pages: Math.max(1, Math.ceil(((countRow ? countRow.total : 0) || 1) / limit))
    });
  })
);

module.exports = router;
