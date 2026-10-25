/**
 * Authentication and citizen profile routes.
 */
const express = require("express");
const bcrypt = require("bcryptjs");
const { body, validationResult } = require("express-validator");

const { asyncHandler, authMiddleware, signToken } = require("../middleware");
const { get, run, audit } = require("../lib/store");
const { sanitizeText } = require("../lib/civic");

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

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone || null,
    address: row.address || null,
    ward_id: row.ward_id || null,
    department_id: row.department_id || null,
    designation: row.designation || null
  };
}

// POST /api/auth/register
router.post(
  "/register",
  [
    body("name").trim().notEmpty().withMessage("Full name is required"),
    body("email").isEmail().withMessage("A valid email address is required"),
    body("password").isLength({ min: 6 }).withMessage("Password must be at least 6 characters"),
    body("phone").optional({ values: "falsy" }).trim().isLength({ max: 20 }),
    body("ward_id").optional({ values: "falsy" }).isInt({ min: 1 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const email = String(req.body.email).trim().toLowerCase();
    const existing = await get("SELECT id FROM users WHERE email = ?", [email]);
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const hash = bcrypt.hashSync(String(req.body.password), 10);
    const result = await run(
      `INSERT INTO users (name, email, password_hash, role, phone, ward_id)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      [
        sanitizeText(req.body.name, 120),
        email,
        hash,
        sanitizeText(req.body.phone, 20) || null,
        req.body.ward_id ? Number(req.body.ward_id) : null
      ]
    );

    const user = await get(
      "SELECT id, name, email, role, phone, address, ward_id, department_id, designation FROM users WHERE id = ?",
      [result.lastID]
    );
    await audit(user, "user_registered", "user", user.id, null, { email: user.email }, req);
    res.status(201).json({ token: signToken(user), user: publicUser(user) });
  })
);

// POST /api/auth/login
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("A valid email address is required"),
    body("password").notEmpty().withMessage("Password is required")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const email = String(req.body.email).trim().toLowerCase();
    const row = await get("SELECT * FROM users WHERE email = ?", [email]);

    // Same response for unknown accounts and wrong passwords.
    if (!row || !bcrypt.compareSync(String(req.body.password), row.password_hash)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    if (row.is_active === 0) {
      return res.status(403).json({ error: "This account has been deactivated. Contact the municipal office." });
    }

    await run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);
    await audit(row, "user_login", "user", row.id, null, null, req);
    res.json({ token: signToken(row), user: publicUser(row) });
  })
);

// GET /api/auth/default-accounts
// Powers the sign-in page helper. It reports the credentials that ship with the
// portal, but only while those credentials are still the configured defaults —
// the moment an administrator changes a password, it stops being published.
// Nothing is returned at all in production.
router.get(
  "/default-accounts",
  asyncHandler(async (req, res) => {
    if (process.env.NODE_ENV === "production") {
      return res.json({ enabled: false, accounts: [] });
    }

    async function probe(candidate) {
      if (!candidate.email || !candidate.password) return null;
      const row = await get("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", [
        candidate.email
      ]);
      if (!row) return null;
      const stillDefault = bcrypt.compareSync(candidate.password, row.password_hash);
      return {
        role: row.role,
        label: candidate.label,
        name: row.name,
        email: row.email,
        landing: candidate.landing,
        password: stillDefault ? candidate.password : null,
        password_is_default: stillDefault
      };
    }

    const accounts = (
      await Promise.all([
        probe({
          email: String(process.env.ADMIN_EMAIL || "admin@municipal.local").trim().toLowerCase(),
          password: process.env.ADMIN_PASSWORD || "Admin@123",
          label: "Administrator",
          landing: "admin"
        }),
        probe({
          email: String(process.env.OFFICER_EMAIL || "officer@municipal.local").trim().toLowerCase(),
          password: process.env.OFFICER_PASSWORD || "Officer@123",
          label: "Service desk officer",
          landing: "staff"
        })
      ])
    ).filter(Boolean);

    res.json({ enabled: true, accounts });
  })
);

// GET /api/auth/me
router.get(
  "/me",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const row = await get(
      `SELECT id, name, email, role, phone, address, ward_id, department_id, designation, created_at
       FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (!row) return res.status(404).json({ error: "Account not found" });
    res.json({ user: { ...row, ...publicUser(row) } });
  })
);

// PATCH /api/auth/me — citizens may update their own contact details only.
router.patch(
  "/me",
  authMiddleware,
  [
    body("name").optional().trim().isLength({ min: 2, max: 120 }),
    body("phone").optional({ values: "falsy" }).trim().isLength({ max: 20 }),
    body("address").optional({ values: "falsy" }).trim().isLength({ max: 400 }),
    body("ward_id").optional({ values: "null" }).isInt({ min: 1 })
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const updates = [];
    const params = [];
    if (req.body.name !== undefined) {
      updates.push("name = ?");
      params.push(sanitizeText(req.body.name, 120));
    }
    if (req.body.phone !== undefined) {
      updates.push("phone = ?");
      params.push(sanitizeText(req.body.phone, 20) || null);
    }
    if (req.body.address !== undefined) {
      updates.push("address = ?");
      params.push(sanitizeText(req.body.address, 400) || null);
    }
    if (req.body.ward_id !== undefined) {
      updates.push("ward_id = ?");
      params.push(req.body.ward_id ? Number(req.body.ward_id) : null);
    }
    if (!updates.length) return res.status(400).json({ error: "No changes were provided" });

    params.push(req.user.id);
    await run(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

    const row = await get(
      "SELECT id, name, email, role, phone, address, ward_id, department_id, designation FROM users WHERE id = ?",
      [req.user.id]
    );
    await audit(req.user, "profile_updated", "user", req.user.id, null, req.body, req);
    res.json({ user: publicUser(row) });
  })
);

module.exports = router;
