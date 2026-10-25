/**
 * Admin payment management routes
 */

const express = require("express");
const { asyncHandler, requireAdmin, optionalAuth } = require("../middleware");
const {
  getUserBills,
  getBillById,
  getPaymentOrdersByUser,
  getPaymentTransactionById,
  getPaymentReceiptById,
  getReceiptByTransactionId,
  getBillSummary,
  getUserPaymentHistory,
  getUserReceipts,
  all,
  get,
  run
} = require("../lib/store");

const router = express.Router();

/**
 * GET /admin/payments — list all payments with filters
 */
router.get(
  "/payments",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status, service_type, bill_number, user_id, page = 1, limit = 50 } = req.query;
    const offset = Math.max((Number(page) - 1) * limit, 0);

    // Build where clause
    const where = ["1=1"];
    const params = [];

    if (status) {
      where.push("orderby.status = ?");
      params.push(status);
    }
    if (service_type) {
      where.push("b.service_type = ?");
      params.push(service_type);
    }
    if (bill_number) {
      where.push("b.bill_number LIKE ?");
      params.push(`%${bill_number}%`);
    }
    if (user_id) {
      where.push("b.user_id = ?");
      params.push(Number(user_id));
    }

    const clause = where.join(" AND ");

    const rows = await all(
      `SELECT a.id AS order_id,
             a.user_id,
             a.bill_id,
             a.gateway,
             a.gateway_order_id,
             a.amount,
             a.currency,
             a.status AS order_status,
             a.receipt,
             a.created_at AS order_created,
             b.service_type,
             b.account_number,
             b.bill_number,
             b.status AS bill_status,
             b.amount_due,
             b.amount_paid,
             u.name AS user_name,
             u.email AS user_email
         FROM payment_orders a
         JOIN bills b ON a.bill_id = b.id
         JOIN users u ON a.user_id = u.id
         WHERE ${clause}
         ORDER BY a.created_at DESC
         LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    // Count results
    const countRow = await get(
      `SELECT COUNT(*) AS total FROM payment_orders a JOIN bills b ON a.bill_id = b.id ${clause ? `WHERE ${clause}` : ``}`,
      params
    );

    res.json({
      payments: rows,
      total: countRow?.total || 0,
      page: Number(page),
      total_pages: Math.max(1, Math.ceil((countRow?.total || 0) / limit))
    });
  })
);

/**
 * GET /admin/payments/:id — single payment detail
 */
router.get(
  "/payments/:id",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) {
      return res.status(400).json({ error: "Invalid payment ID" });
    }
    const order = await get("SELECT * FROM payment_orders WHERE id = ?", [orderId]);
    if (!order) {
      return res.status(404).json({ error: "Payment order not found" });
    }
    const bill = await getBillById(order.bill_id);
    const user = await get("SELECT name, email FROM users WHERE id = ?", [order.user_id]);
    const transactions = await all("SELECT * FROM payment_transactions WHERE payment_order_id = ? ORDER BY created_at DESC", [orderId]);
    const receipts = transactions
      .map((t) => getPaymentReceiptByTransactionId(t.id))
      .filter(Boolean);
    res.json({ order, bill, user, transactions, receipts });
  })
);

/**
 * Export payments as CSV for admin
 */
router.get(
  "/payments/export",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const rows = await all(
      `SELECT a.id AS order_id,
             a.user_id,
             a.bill_id,
             a.gateway,
             a.gateway_order_id,
             a.amount,
             a.currency,
             a.status AS order_status,
             a.receipt,
             a.created_at AS order_created,
             b.service_type,
             b.account_number,
             b.bill_number,
             b.status AS bill_status,
             b.amount_due,
             b.amount_paid,
             u.name AS user_name,
             u.email AS user_email
         FROM payment_orders a
         JOIN bills b ON a.bill_id = b.id
         JOIN users u ON a.user_id = u.id
         ORDER BY a.created_at DESC`]
    );

    const csv = [
      "order_id,user_id,bill_id,gateway,gateway_order_id,amount,currency,order_status,receipt,order_created,service_type,account_number,bill_number,bill_status,amount_due,amount_paid,user_name,user_email",
      ...rows.map(
        (r) =>
          [
            r.order_id,
            r.user_id,
            r.bill_id,
            r.gateway,
            r.gateway_order_id,
            r.amount,
            r.currency,
            r.order_status,
            r.receipt,
            r.order_created,
            r.service_type,
            r.account_number,
            r.bill_number,
            r.bill_status,
            r.amount_due,
            r.amount_paid,
            r.user_name,
            r.user_email
          ].join(",")
      )
    ].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="payments_${new Date().toISOString().replace(/[:.]/g, "_")}.csv"`
    );
    res.send(csv);
  })
);

module.exports = router;

