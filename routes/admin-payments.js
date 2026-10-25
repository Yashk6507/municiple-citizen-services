/**
 * Admin Payments Routes
 *
 * Provides admin-only endpoints for viewing and exporting payment transactions.
 */

const express = require("express");
const { asyncHandler, requireAdmin } = require("../middleware");
const {
  getUserPaymentHistory,
  getUserReceipts,
  all,
  get,
  run
} = require("../lib/store");

const router = express.Router();

/**
 * Helper to escape CSV values
 */
function escapeCsv(val) {
  if (val === null || val === undefined) return '';
  const str = String(val).replace(/"/g, '""');
  return `"${str}"`;
}

/**
 * GET /admin/payments — list payments with filtering
 */
router.get("/payments", asyncHandler(async (req, res) => {
    const {
      status,
      service_type,
      search,
      user_id,
      page = 1,
      limit = 25
    } = req.query;
    const offset = Math.max((Number(page) - 1) * limit, 0);

    // Build where clause
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
      where.push("(b.account_number LIKE ? OR b.bill_number LIKE ? OR u.name LIKE ? OR u.email LIKE ?)");
      params.push(term, term, term, term);
    }
    if (user_id) {
      where.push("pt.user_id = ?");
      params.push(Number(user_id));
    }

    const clause = where.join(" AND ");

    const rows = await all(
      `SELECT
        pt.id,
        pt.created_at,
        pt.gateway,
        pt.gateway_payment_id,
        pt.amount,
        pt.status,
        pt.method,
        pt.verified_by,
        b.service_type,
        b.account_number,
        b.bill_number,
        b.provider_name,
        u.name AS user_name,
        u.email AS user_email,
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

    // Count results
    const countRow = await get(
      `SELECT COUNT(*) AS total
       FROM payment_transactions pt
       JOIN bills b ON b.id = pt.bill_id
       JOIN users u ON u.id = pt.user_id ${clause ? `WHERE ${clause}` : ''}`,
      [...params]
    );

    res.json({
      transactions: rows,
      total: countRow?.total || 0,
      page: Number(page),
      limit: Number(limit),
      total_pages: Math.max(1, Math.ceil((countRow?.total || 0) / limit))
    });
  })
);

/**
 * GET /admin/payments/export-csv — export payments to CSV
 */
router.get(
  "/export-csv",
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Get all payments (no pagination for export)
    const rows = await all(
      `SELECT
        pt.id,
        pt.created_at,
        pt.gateway,
        pt.gateway_payment_id,
        pt.amount,
        pt.status,
        pt.method,
        pt.verified_by,
        b.service_type,
        b.account_number,
        b.bill_number,
        b.provider_name,
        u.name AS user_name,
        u.email AS user_email,
        pr.receipt_number
      FROM payment_transactions pt
      JOIN bills b ON b.id = pt.bill_id
      JOIN users u ON u.id = pt.user_id
      LEFT JOIN payment_receipts pr ON pr.transaction_id = pt.id
      ORDER BY pt.created_at DESC`
    );

    const csvLines = [
      'Transaction ID,Date,Gateway,Payment ID,Amount (₹),Status,Method,Verified By,Service Type,Account Number,Bill Number,Provider Name,User Name,User Email,Receipt Number'
    ];

    const escape = (val) => (val === null || val === undefined) ? '' : `"${String(val).replace(/"/g, '""')}"`;

    rows.forEach((r) => {
      const line = [
        escape(r.id),
        escape(r.created_at),
        escape(r.gateway),
        escape(r.gateway_payment_id),
        escape((r.amount / 100).toFixed(2)),
        escape(r.status),
        escape(r.method || ''),
        escape(r.verified_by || ''),
        escape(r.service_type),
        escape(r.account_number),
        escape(r.bill_number || ''),
        escape(r.provider_name || ''),
        escape(r.user_name),
        escape(r.user_email),
        escape(r.receipt_number || '')
      ].join(',');
      csvLines.push(line);
    });

    const csvContent = csvLines.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="municipal_payments_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csvContent);
  })
);

module.exports = router;