/**
 * Database access helpers shared by the route modules.
 * All access goes through db.js, which owns the schema and migrations.
 */
const db = require("../db");
const { sendAlertEmail } = require("./mailer");
const {
  formatReference,
  referencePattern,
  referenceYear,
  resolveTargetHours,
  addHours,
  clampPriority
} = require("./civic");

const { runAsync: run, allAsync: all, getAsync: get } = db;

// ---------------------------------------------------------------------------
// Audit trail (Phase 4 / Phase 5)
// ---------------------------------------------------------------------------
async function audit(actor, action, entityType, entityId, oldValues, newValues, req) {
  try {
    await run(
      `INSERT INTO audit_logs
        (user_id, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor && actor.id ? actor.id : null,
        (actor && actor.email) || null,
        action,
        entityType || null,
        entityId === undefined ? null : entityId,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        (req && (req.ip || (req.connection && req.connection.remoteAddress))) || null,
        (req && req.headers && req.headers["user-agent"]) || null
      ]
    );
  } catch (err) {
    console.error("Failed to write audit log:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
/**
 * Raises an alert for a user: an in-app notification plus, when Brevo is
 * configured, the same alert by email. The email is dispatched without
 * blocking the caller so an unreachable mail provider can never slow down or
 * fail an API request; the outcome is still recorded in the email log.
 */
async function notify(userId, complaintId, type, title, message) {
  if (!userId) return;
  const body = title ? `${title}: ${message}` : message;
  try {
    await run(
      `INSERT INTO notifications (user_id, complaint_id, type, message)
       VALUES (?, ?, ?, ?)`,
      [userId, complaintId || null, type, body]
    );
  } catch (err) {
    console.error("Failed to create notification:", err.message);
  }

  try {
    sendAlertEmail({ userId, complaintId, title, message, kind: type }).catch((err) => {
      console.error("Alert email failed:", err.message);
    });
  } catch (err) {
    console.error("Alert email failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Application settings
// ---------------------------------------------------------------------------
async function getSetting(key, fallback = null) {
  try {
    const row = await get("SELECT value FROM app_settings WHERE key = ?", [key]);
    return row && row.value !== null && row.value !== undefined ? row.value : fallback;
  } catch {
    return fallback;
  }
}

async function getSettingNumber(key, fallback) {
  const raw = await getSetting(key, null);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function setSetting(key, value) {
  await run(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    [key, value === null || value === undefined ? null : String(value)]
  );
}

// ---------------------------------------------------------------------------
// Reference data lookups
// ---------------------------------------------------------------------------
async function getCategory(idOrCode) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const numeric = Number(idOrCode);
  if (Number.isInteger(numeric) && String(numeric) === String(idOrCode)) {
    return get("SELECT * FROM service_categories WHERE id = ?", [numeric]);
  }
  return get("SELECT * FROM service_categories WHERE code = ?", [String(idOrCode)]);
}

async function getSubcategory(idOrCode) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const numeric = Number(idOrCode);
  if (Number.isInteger(numeric) && String(numeric) === String(idOrCode)) {
    return get("SELECT * FROM service_subcategories WHERE id = ?", [numeric]);
  }
  return get("SELECT * FROM service_subcategories WHERE code = ?", [String(idOrCode)]);
}

async function listDepartments(activeOnly = true) {
  const sql = activeOnly
    ? "SELECT * FROM departments WHERE is_active = 1 ORDER BY name"
    : "SELECT * FROM departments ORDER BY name";
  return all(sql);
}

async function listWards(activeOnly = true) {
  const sql = activeOnly
    ? "SELECT * FROM wards WHERE is_active = 1 ORDER BY code"
    : "SELECT * FROM wards ORDER BY code";
  return all(sql);
}

// ---------------------------------------------------------------------------
// Sequencing / reference numbers
// ---------------------------------------------------------------------------
async function nextReference(kind) {
  const year = referenceYear();
  const row = await get(
    "SELECT COUNT(*) AS c FROM complaints WHERE reference_no LIKE ?",
    [referencePattern(kind, year)]
  );
  let sequence = (row ? row.c : 0) + 1;
  const taken = new Set(
    (await all("SELECT reference_no FROM complaints WHERE reference_no LIKE ?", [
      referencePattern(kind, year)
    ])).map((r) => r.reference_no)
  );
  let reference = formatReference(kind, year, sequence);
  while (taken.has(reference)) {
    sequence += 1;
    reference = formatReference(kind, year, sequence);
  }
  return reference;
}

async function nextApplicationReference() {
  const year = new Date().getUTCFullYear();
  const pattern = `APP-${year}-%`;
  const row = await get(
    "SELECT COUNT(*) AS c FROM service_applications WHERE reference_no LIKE ?",
    [pattern]
  );
  let sequence = (row ? row.c : 0) + 1;
  const taken = new Set(
    (await all("SELECT reference_no FROM service_applications WHERE reference_no LIKE ?", [pattern]))
      .map((r) => r.reference_no)
  );
  let reference = formatReference("application", year, sequence);
  while (taken.has(reference)) {
    sequence += 1;
    reference = formatReference("application", year, sequence);
  }
  return reference;
}

// ---------------------------------------------------------------------------
// Routing + SLA resolution (Phase 6 / Phase 7)
// ---------------------------------------------------------------------------
/**
 * Decide the department for a complaint using stored mappings only.
 * Returns { department_id, method, review_required }.
 * An unknown mapping is never guessed: it goes to the General review queue.
 */
async function resolveDepartment({ subcategory, category }) {
  if (subcategory && subcategory.department_id) {
    return { department_id: subcategory.department_id, method: "routing_rule", review_required: false };
  }
  const general = await get("SELECT id FROM departments WHERE code = 'general' LIMIT 1");
  return {
    department_id: general ? general.id : null,
    method: "review_queue",
    review_required: true,
    reason: category
      ? "No department mapping configured for this subcategory."
      : "No category mapping configured."
  };
}

async function computeDueAt(createdAt, { categoryId, subcategory, priority }) {
  const policies = await all(
    "SELECT priority, category_id, target_hours FROM sla_policies WHERE is_active = 1"
  );
  const priorityPolicy = policies.find((p) => !p.category_id && p.priority === priority);
  const categoryPolicy = policies.find((p) => p.category_id === categoryId);
  const hours = resolveTargetHours({
    subcategorySlaHours: subcategory ? subcategory.sla_hours : null,
    categoryPolicyHours: categoryPolicy ? categoryPolicy.target_hours : null,
    priorityPolicyHours: priorityPolicy ? priorityPolicy.target_hours : null
  });
  return { dueAt: addHours(createdAt, hours), targetHours: hours };
}

async function recordStatusHistory({ complaintId, oldStatus, newStatus, actor, remarks }) {
  await run(
    `INSERT INTO complaint_status_history (complaint_id, old_status, new_status, changed_by, remarks)
     VALUES (?, ?, ?, ?, ?)`,
    [
      complaintId,
      oldStatus || null,
      newStatus,
      (actor && (actor.email || actor.name)) || null,
      remarks || null
    ]
  );
}

async function addNote({ complaintId, author, visibility, note }) {
  const result = await run(
    `INSERT INTO complaint_notes (complaint_id, author_id, author_name, visibility, note)
     VALUES (?, ?, ?, ?, ?)`,
    [
      complaintId,
      author && author.id ? author.id : null,
      (author && (author.name || author.email)) || null,
      visibility === "citizen" ? "citizen" : "internal",
      note
    ]
  );
  return result.lastID;
}

async function addAttachment({ complaintId, kind, file, uploadedBy }) {
  const result = await run(
    `INSERT INTO complaint_attachments
      (complaint_id, kind, file_path, original_name, mime_type, size_bytes, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      complaintId,
      kind || "evidence",
      file.publicPath,
      file.originalname || null,
      file.mimetype || null,
      file.size || null,
      uploadedBy || null
    ]
  );
  return result.lastID;
}

async function touchComplaint(complaintId) {
  await run(
    "UPDATE complaints SET last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [complaintId]
  );
}

// ---------------------------------------------------------------------------
// Bill payment helpers
// ---------------------------------------------------------------------------

/**
 * Get all bills for a user with optional filters
 */
async function getUserBills(userId, { serviceType, status, limit = 50, offset = 0 } = {}) {
  const where = ["user_id = ?"];
  const params = [userId];

  if (serviceType) {
    where.push("service_type = ?");
    params.push(serviceType);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }

  const clause = where.join(" AND ");

  const bills = await all(
    `SELECT * FROM bills WHERE ${clause} ORDER BY due_date ASC, created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const countRow = await get(
    `SELECT COUNT(*) AS total FROM bills WHERE ${clause}`,
    params
  );

  return { bills, total: countRow?.total || 0 };
}

/**
 * Get a single bill by ID (with ownership check)
 */
async function getBillById(billId, userId = null) {
  let sql = "SELECT * FROM bills WHERE id = ?";
  const params = [billId];

  if (userId) {
    sql += " AND user_id = ?";
    params.push(userId);
  }

  return get(sql, params);
}

/**
 * Create a payment order record
 */
async function createPaymentOrder({ userId, billId, gateway, gatewayOrderId, amount, currency = "INR", receipt, notes = {} }) {
  const result = await run(
    `INSERT INTO payment_orders (user_id, bill_id, gateway, gateway_order_id, amount, currency, receipt, notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created')`,
    [userId, billId, gateway, gatewayOrderId, amount, currency, receipt || null, JSON.stringify(notes)]
  );
  return get("SELECT * FROM payment_orders WHERE id = ?", [result.lastID]);
}

/**
 * Get payment order by gateway order ID
 */
async function getPaymentOrderByGatewayId(gateway, gatewayOrderId) {
  return get(
    "SELECT * FROM payment_orders WHERE gateway = ? AND gateway_order_id = ?",
    [gateway, gatewayOrderId]
  );
}

/**
 * Get payment order by internal ID
 */
async function getPaymentOrderById(orderId) {
  return get("SELECT * FROM payment_orders WHERE id = ?", [orderId]);
}

/**
 * Create a payment transaction record
 */
async function createPaymentTransaction({ userId, billId, paymentOrderId, gateway, gatewayPaymentId, gatewayOrderId, amount, currency = "INR", status = "pending", method = null, rawResponse = null }) {
  const result = await run(
    `INSERT INTO payment_transactions (user_id, bill_id, payment_order_id, gateway, gateway_payment_id, gateway_order_id, amount, currency, status, method, raw_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, billId, paymentOrderId, gateway, gatewayPaymentId || null, gatewayOrderId, amount, currency, status, method, rawResponse ? JSON.stringify(rawResponse) : null]
  );
  return get("SELECT * FROM payment_transactions WHERE id = ?", [result.lastID]);
}

/**
 * Get payment transaction by internal ID
 */
async function getPaymentTransactionById(transactionId) {
  return get("SELECT * FROM payment_transactions WHERE id = ?", [transactionId]);
}

/**
 * Get payment transaction by gateway payment ID
 */
async function getPaymentTransactionByGatewayId(gateway, gatewayPaymentId) {
  return get(
    "SELECT * FROM payment_transactions WHERE gateway = ? AND gateway_payment_id = ?",
    [gateway, gatewayPaymentId]
  );
}

/**
 * Update payment transaction
 */
async function updatePaymentTransaction(transactionId, updates) {
  const allowedFields = ["status", "gateway_payment_id", "gateway_signature", "method", "paid_at", "verified_at", "verified_by", "failure_reason", "raw_response"];
  const setClauses = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      setClauses.push(`${key} = ?`);
      params.push(value === null || value === undefined ? null : (typeof value === 'object' ? JSON.stringify(value) : value));
    }
  }

  if (setClauses.length === 0) return get("SELECT * FROM payment_transactions WHERE id = ?", [transactionId]);

  setClauses.push("updated_at = CURRENT_TIMESTAMP");
  params.push(transactionId);

  await run(
    `UPDATE payment_transactions SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );
  return get("SELECT * FROM payment_transactions WHERE id = ?", [transactionId]);
}

/**
 * Create a payment receipt
 */
async function createPaymentReceipt({ userId, billId, transactionId, receiptNumber, amountPaid, paymentDate, gatewayTransactionId, billCategory, billAccountNumber, billNumber, metadata = {} }) {
  const result = await run(
    `INSERT INTO payment_receipts (user_id, bill_id, transaction_id, receipt_number, amount_paid, payment_date, gateway_transaction_id, bill_category, bill_account_number, bill_number, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, billId, transactionId, receiptNumber, amountPaid, paymentDate, gatewayTransactionId || null, billCategory, billAccountNumber, billNumber || null, JSON.stringify(metadata)]
  );
  return get("SELECT * FROM payment_receipts WHERE id = ?", [result.lastID]);
}

/**
 * Get payment receipt by internal ID
 */
async function getPaymentReceiptById(receiptId) {
  return get("SELECT * FROM payment_receipts WHERE id = ?", [receiptId]);
}

/**
 * Get payment receipt by transaction ID
 */
async function getPaymentReceiptByTransactionId(transactionId) {
  return get("SELECT * FROM payment_receipts WHERE transaction_id = ?", [transactionId]);
}

/**
 * Get user's payment history (transactions with bill info)
 */
async function getUserPaymentHistory(userId, { limit = 50, offset = 0, status } = {}) {
  const where = ["pt.user_id = ?"];
  const params = [userId];

  if (status) {
    where.push("pt.status = ?");
    params.push(status);
  }

  const clause = where.join(" AND ");

  const transactions = await all(
    `SELECT pt.*, b.service_type, b.account_number, b.bill_number, b.provider_name
     FROM payment_transactions pt
     JOIN bills b ON b.id = pt.bill_id
     WHERE ${clause}
     ORDER BY pt.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const countRow = await get(
    `SELECT COUNT(*) AS total FROM payment_transactions pt JOIN bills b ON b.id = pt.bill_id WHERE ${clause}`,
    params
  );

  return { transactions, total: countRow?.total || 0 };
}

/**
 * Get user's receipts
 */
async function getUserReceipts(userId, { limit = 50, offset = 0 } = {}) {
  const receipts = await all(
    `SELECT pr.*, b.service_type, b.account_number, b.bill_number, b.provider_name
     FROM payment_receipts pr
     JOIN bills b ON b.id = pr.bill_id
     WHERE pr.user_id = ?
     ORDER BY pr.created_at DESC LIMIT ? OFFSET ?`,
    [userId, limit, offset]
  );

  const countRow = await get(
    `SELECT COUNT(*) AS total FROM payment_receipts pr JOIN bills b ON b.id = pr.bill_id WHERE pr.user_id = ?`,
    [userId]
  );

  return { receipts, total: countRow?.total || 0 };
}

/**
 * Update bill status after payment
 */
async function updateBillStatus(billId, { status, amountPaid = 0 }) {
  const bill = await get("SELECT amount_due, amount_paid FROM bills WHERE id = ?", [billId]);
  if (!bill) throw new Error("Bill not found");

  const newAmountPaid = Math.min(bill.amount_paid + amountPaid, bill.amount_due);
  let newStatus = status;

  if (!status) {
    if (newAmountPaid >= bill.amount_due) newStatus = "paid";
    else if (newAmountPaid > 0) newStatus = "partial";
    else newStatus = "pending";
  }

  await run(
    `UPDATE bills SET status = ?, amount_paid = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [newStatus, newAmountPaid, billId]
  );

  return get("SELECT * FROM bills WHERE id = ?", [billId]);
}

/**
 * Get bill summary for dashboard
 */
async function getBillSummary(userId) {
  const rows = await all(
    `SELECT service_type, status, COUNT(*) as count, SUM(amount_due) as total_due, SUM(amount_paid) as total_paid
     FROM bills
     WHERE user_id = ?
     GROUP BY service_type, status`,
    [userId]
  );

  return rows;
}

module.exports = {
  db,
  run,
  all,
  get,
  audit,
  notify,
  getSetting,
  getSettingNumber,
  setSetting,
  getCategory,
  getSubcategory,
  listDepartments,
  listWards,
  nextReference,
  nextApplicationReference,
  resolveDepartment,
  computeDueAt,
  recordStatusHistory,
  addNote,
  addAttachment,
  touchComplaint,
  // Bill payment helpers
  getUserBills,
  getBillById,
  createPaymentOrder,
  getPaymentOrderByGatewayId,
  getPaymentOrderById,
  createPaymentTransaction,
  getPaymentTransactionById,
  getPaymentTransactionByGatewayId,
  updatePaymentTransaction,
  createPaymentReceipt,
  getPaymentReceiptById,
  getPaymentReceiptByTransactionId,
  getUserPaymentHistory,
  getUserReceipts,
  updateBillStatus,
  getBillSummary
};
