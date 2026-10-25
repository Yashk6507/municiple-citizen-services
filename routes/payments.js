/**
 * Payment API Router
 *
 * Handles citizen bill payments:
 * - Electricity, Water, Property Tax bills
 * - Payment order creation
 * - Payment verification & webhooks
 * - Receipt generation
 * - Transaction history
 */

const express = require("express");
const crypto = require("crypto");
const { body, validationResult } = require("express-validator");

const { asyncHandler, authMiddleware, optionalAuth } = require("../middleware");
const {
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
  getBillSummary,
  audit,
  notify,
  all,
  get,
  run
} = require("../lib/store");

const {
  createOrder,
  verifyPayment,
  verifyWebhook,
  getCheckoutOptions,
  getGatewayName,
  isTestMode,
  __demo
} = require("../lib/paymentGateway");

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

// ---------------------------------------------------------------------------
// GET /api/payments/bills — list citizen's bills
// ---------------------------------------------------------------------------
router.get(
  "/bills",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const serviceType = req.query.service_type || null;
    const status = req.query.status || null;
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max((Number(req.query.page) - 1 || 0) * limit, 0);

    const { bills, total } = await getUserBills(req.user.id, {
      serviceType,
      status,
      limit,
      offset
    });

    res.json({
      bills,
      total,
      page: Math.floor(offset / limit) + 1,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/payments/bills/summary — summary of user's bills
// ---------------------------------------------------------------------------
router.get(
  "/bills/summary",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const summary = await getBillSummary(req.user.id);
    res.json({ summary });
  })
);

// ---------------------------------------------------------------------------
// GET /api/payments/bills/:id — single bill detail
// ---------------------------------------------------------------------------
router.get(
  "/bills/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const billId = Number(req.params.id);
    if (!Number.isInteger(billId)) {
      return res.status(400).json({ error: "Invalid bill ID" });
    }

    const bill = await getBillById(billId, req.user.id);
    if (!bill) {
      return res.status(404).json({ error: "Bill not found" });
    }

    // Get payment history for this bill
    const transactions = await all(
      "SELECT * FROM payment_transactions WHERE bill_id = ? ORDER BY created_at DESC",
      [billId]
    );

    res.json({ bill, transactions });
  })
);

// ---------------------------------------------------------------------------
// POST /api/payments/orders — create payment order for a bill
// ---------------------------------------------------------------------------
router.post(
  "/orders",
  authMiddleware,
  [
    body("bill_id").isInt({ min: 1 }).withMessage("Valid bill ID required"),
    body("amount").optional().isInt({ min: 100 }).withMessage("Amount must be at least 100 paise (₹1)")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const billId = Number(req.body.bill_id);
    const bill = await getBillById(billId, req.user.id);

    if (!bill) {
      return res.status(404).json({ error: "Bill not found" });
    }

    if (bill.status === "paid") {
      return res.status(400).json({ error: "This bill has already been paid in full" });
    }

    if (bill.status === "cancelled") {
      return res.status(400).json({ error: "This bill has been cancelled" });
    }

    // Amount to pay: either specified partial amount or remaining due
    const remainingDue = bill.amount_due - bill.amount_paid;
    const payAmount = req.body.amount ? Math.min(Number(req.body.amount), remainingDue) : remainingDue;

    if (payAmount <= 0) {
      return res.status(400).json({ error: "No remaining due amount to pay" });
    }

    const gateway = getGatewayName();
    const receiptRef = `RCPT-${bill.service_type.slice(0, 3).toUpperCase()}-${billId}-${Date.now()}`;

    // Create order on gateway
    const gatewayOrder = await createOrder({
      amount: payAmount,
      currency: "INR",
      receipt: receiptRef,
      notes: {
        bill_id: billId,
        user_id: req.user.id,
        service_type: bill.service_type,
        account_number: bill.account_number
      }
    });

    // Save order in database
    const orderRecord = await createPaymentOrder({
      userId: req.user.id,
      billId,
      gateway,
      gatewayOrderId: gatewayOrder.id,
      amount: payAmount,
      currency: "INR",
      receipt: receiptRef,
      notes: {
        bill_number: bill.bill_number,
        service_type: bill.service_type
      }
    });

    // Generate checkout options for frontend
    const checkoutOptions = getCheckoutOptions({
      orderId: gatewayOrder.id,
      amount: payAmount,
      currency: "INR",
      name: "Municipal Corporation",
      description: `${bill.service_type.replace("_", " ").toUpperCase()} Bill (${bill.account_number})`,
      prefill: {
        name: req.user.name,
        email: req.user.email,
        contact: req.user.phone || ""
      },
      notes: {
        bill_id: billId,
        order_record_id: orderRecord.id
      }
    });

    await audit(req.user, "payment_order_created", "payment_order", orderRecord.id, null, {
      bill_id: billId,
      amount: payAmount,
      gateway_order_id: gatewayOrder.id
    }, req);

    res.status(201).json({
      order: orderRecord,
      checkout: checkoutOptions,
      gateway,
      is_test_mode: isTestMode()
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/payments/verify — verify payment signature & process completion
// ---------------------------------------------------------------------------
router.post(
  "/verify",
  authMiddleware,
  [
    body("order_id").notEmpty().withMessage("Order ID required"),
    body("payment_id").notEmpty().withMessage("Payment ID required"),
    body("signature").notEmpty().withMessage("Signature required")
  ],
  asyncHandler(async (req, res) => {
    if (validationErrors(req, res)) return;

    const { order_id: gatewayOrderId, payment_id: gatewayPaymentId, signature } = req.body;
    const gateway = getGatewayName();

    // Find the order record
    const orderRecord = await getPaymentOrderByGatewayId(gateway, gatewayOrderId);
    if (!orderRecord) {
      return res.status(404).json({ error: "Payment order not found" });
    }

    if (Number(orderRecord.user_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: "Unauthorized access to order" });
    }

    // Check if payment already processed (idempotency check)
    const existingTransaction = await getPaymentTransactionByGatewayId(gateway, gatewayPaymentId);
    if (existingTransaction && existingTransaction.status === "captured") {
      const receipt = await getPaymentReceiptByTransactionId(existingTransaction.id);
      return res.json({
        message: "Payment already verified",
        transaction: existingTransaction,
        receipt
      });
    }

    // Verify signature with gateway
    let isValid = false;
    if (gateway === "demo") {
      // In demo mode, if simulated payment exists and is captured, signature matches
      isValid = await verifyPayment({ orderId: gatewayOrderId, paymentId: gatewayPaymentId, signature });
    } else {
      isValid = await verifyPayment({ orderId: gatewayOrderId, paymentId: gatewayPaymentId, signature });
    }

    if (!isValid) {
      // Create failed transaction record
      await createPaymentTransaction({
        userId: req.user.id,
        billId: orderRecord.bill_id,
        paymentOrderId: orderRecord.id,
        gateway,
        gatewayPaymentId,
        gatewayOrderId,
        amount: orderRecord.amount,
        status: "failed",
        failureReason: "Invalid payment signature"
      });

      return res.status(400).json({ error: "Payment signature verification failed" });
    }

    // Get bill info
    const bill = await getBillById(orderRecord.bill_id);
    if (!bill) {
      return res.status(404).json({ error: "Associated bill not found" });
    }

    // Create transaction record
    const transaction = await createPaymentTransaction({
      userId: req.user.id,
      billId: orderRecord.bill_id,
      paymentOrderId: orderRecord.id,
      gateway,
      gatewayPaymentId,
      gatewayOrderId,
      amount: orderRecord.amount,
      status: "captured",
      method: req.body.method || "online",
      rawResponse: { signature, verified_at: new Date().toISOString() }
    });

    // Update transaction verification details
    await updatePaymentTransaction(transaction.id, {
      gateway_signature: signature,
      paid_at: new Date().toISOString(),
      verified_at: new Date().toISOString(),
      verified_by: "signature_check"
    });

    // Update order status
    await run("UPDATE payment_orders SET status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?", [orderRecord.id]);

    // Update bill status
    const updatedBill = await updateBillStatus(bill.id, { amountPaid: orderRecord.amount });

    // Generate receipt
    const receiptNumber = `RCPT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const receipt = await createPaymentReceipt({
      userId: req.user.id,
      billId: bill.id,
      transactionId: transaction.id,
      receiptNumber,
      amountPaid: orderRecord.amount,
      paymentDate: new Date().toISOString(),
      gatewayTransactionId: gatewayPaymentId,
      billCategory: bill.service_type,
      billAccountNumber: bill.account_number,
      billNumber: bill.bill_number
    });

    // Audit log
    await audit(req.user, "payment_verified", "payment_transaction", transaction.id, null, {
      bill_id: bill.id,
      amount: orderRecord.amount,
      receipt_number: receiptNumber
    }, req);

    // Send notification
    await notify(
      req.user.id,
      null,
      "payment_success",
      "Payment Received",
      `Your payment of ₹${(orderRecord.amount / 100).toFixed(2)} for ${bill.service_type.replace("_", " ")} bill (${bill.account_number}) was successful. Receipt #${receiptNumber}.`
    );

    res.json({
      message: "Payment verified successfully",
      transaction,
      bill: updatedBill,
      receipt
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/payments/webhook — Gateway webhook notification endpoint
// ---------------------------------------------------------------------------
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"] || req.headers["x-webhook-signature"];
    const payloadStr = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);

    // Verify webhook signature
    const isValid = await verifyWebhook({ payload: payloadStr, signature });
    if (!isValid) {
      console.warn("Invalid webhook signature received");
      return res.status(400).json({ error: "Invalid signature" });
    }

    let payload;
    try {
      payload = typeof req.body === "object" && !(req.body instanceof Buffer) ? req.body : JSON.parse(payloadStr);
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    const event = payload.event;
    console.log(`Payment webhook event received: ${event}`);

    if (event === "payment.captured" || event === "order.paid") {
      const paymentEntity = payload.payload?.payment?.entity || payload.payment;
      const orderEntity = payload.payload?.order?.entity || payload.order;

      const gatewayOrderId = paymentEntity?.order_id || orderEntity?.id;
      const gatewayPaymentId = paymentEntity?.id;
      const amount = paymentEntity?.amount || orderEntity?.amount;

      if (gatewayOrderId) {
        const orderRecord = await getPaymentOrderByGatewayId(getGatewayName(), gatewayOrderId);
        if (orderRecord) {
          // Check if already processed
          const existingTxn = await getPaymentTransactionByGatewayId(getGatewayName(), gatewayPaymentId);
          if (!existingTxn || existingTxn.status !== "captured") {
            const bill = await getBillById(orderRecord.bill_id);
            if (bill) {
              let txnId = existingTxn?.id;
              if (!txnId) {
                const txn = await createPaymentTransaction({
                  userId: orderRecord.user_id,
                  billId: bill.id,
                  paymentOrderId: orderRecord.id,
                  gateway: getGatewayName(),
                  gatewayPaymentId,
                  gatewayOrderId,
                  amount: amount || orderRecord.amount,
                  status: "captured",
                  method: paymentEntity?.method || "online",
                  rawResponse: payload
                });
                txnId = txn.id;
              }

              await updatePaymentTransaction(txnId, {
                status: "captured",
                paid_at: new Date().toISOString(),
                verified_at: new Date().toISOString(),
                verified_by: "webhook"
              });

              await updateBillStatus(bill.id, { amountPaid: amount || orderRecord.amount });

              // Receipt
              const existingReceipt = await getPaymentReceiptByTransactionId(txnId);
              if (!existingReceipt) {
                const receiptNumber = `RCPT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                await createPaymentReceipt({
                  userId: orderRecord.user_id,
                  billId: bill.id,
                  transactionId: txnId,
                  receiptNumber,
                  amountPaid: amount || orderRecord.amount,
                  paymentDate: new Date().toISOString(),
                  gatewayTransactionId: gatewayPaymentId,
                  billCategory: bill.service_type,
                  billAccountNumber: bill.account_number,
                  billNumber: bill.bill_number
                });
              }

              console.log(`Webhook successfully processed payment for order ${gatewayOrderId}`);
            }
          }
        }
      }
    }

    res.json({ status: "ok" });
  })
);

// ---------------------------------------------------------------------------
// GET /api/payments/history — user payment history
// ---------------------------------------------------------------------------
router.get(
  "/history",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max((Number(req.query.page) - 1 || 0) * limit, 0);
    const status = req.query.status || null;

    const { transactions, total } = await getUserPaymentHistory(req.user.id, {
      limit,
      offset,
      status
    });

    res.json({
      transactions,
      total,
      page: Math.floor(offset / limit) + 1,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/payments/receipts — list receipts
// ---------------------------------------------------------------------------
router.get(
  "/receipts",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const offset = Math.max((Number(req.query.page) - 1 || 0) * limit, 0);

    const { receipts, total } = await getUserReceipts(req.user.id, {
      limit,
      offset
    });

    res.json({
      receipts,
      total,
      page: Math.floor(offset / limit) + 1,
      total_pages: Math.max(1, Math.ceil(total / limit))
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/payments/receipts/:id — single receipt view/download
// ---------------------------------------------------------------------------
router.get(
  "/receipts/:id",
  authMiddleware,
  asyncHandler(async (req, res) => {
    const receiptId = Number(req.params.id);
    if (!Number.isInteger(receiptId)) {
      return res.status(400).json({ error: "Invalid receipt ID" });
    }

    const receipt = await getPaymentReceiptById(receiptId);
    if (!receipt) {
      return res.status(404).json({ error: "Receipt not found" });
    }

    if (Number(receipt.user_id) !== Number(req.user.id) && req.user.role !== "admin") {
      return res.status(403).json({ error: "Unauthorized access to receipt" });
    }

    // Get associated bill and transaction details
    const bill = await getBillById(receipt.bill_id);
    const transaction = await getPaymentTransactionById(receipt.transaction_id);
    const user = await get("SELECT name, email, phone FROM users WHERE id = ?", [receipt.user_id]);

    res.json({
      receipt,
      bill,
      transaction,
      user
    });
  })
);

// ---------------------------------------------------------------------------
// POST /api/payments/demo/simulate — DEMO ONLY endpoint to simulate payment
// ---------------------------------------------------------------------------
router.post(
  "/demo/simulate",
  authMiddleware,
  [
    body("order_id").notEmpty().withMessage("Order ID required"),
    body("status").optional().isIn(["captured", "failed"]).withMessage("Invalid status")
  ],
  asyncHandler(async (req, res) => {
    if (!isTestMode() && getGatewayName() !== "demo") {
      return res.status(403).json({ error: "Simulation only available in demo/test mode" });
    }

    if (validationErrors(req, res)) return;

    const gatewayOrderId = req.body.order_id;
    const status = req.body.status || "captured";
    const method = req.body.method || "upi";

    try {
      const payment = await __demo.simulatePayment(gatewayOrderId, { status, method });
      const signature = `demo_sig_${Date.now()}`;

      res.json({
        message: "Demo payment simulated",
        payment_id: payment.id,
        order_id: gatewayOrderId,
        signature,
        status: payment.status
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

module.exports = router;