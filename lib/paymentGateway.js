/**
 * Payment Gateway Abstraction Layer
 *
 * Supports multiple providers with a unified interface.
 * Currently implements Razorpay (live + test/sandbox) and a Demo mode for development.
 *
 * Environment variables:
 * - PAYMENT_GATEWAY: "razorpay" | "demo" (default: "demo")
 * - RAZORPAY_KEY_ID: Razorpay Key ID (from Dashboard)
 * - RAZORPAY_KEY_SECRET: Razorpay Key Secret (from Dashboard)
 * - PAYMENT_WEBHOOK_SECRET: Secret for verifying webhook signatures (optional but recommended)
 */

const crypto = require("crypto");

const GATEWAY = process.env.PAYMENT_GATEWAY || "demo";

/**
 * Creates a payment order on the gateway
 * @param {Object} params
 * @param {number} params.amount - Amount in paise (smallest currency unit)
 * @param {string} params.currency - Currency code (default: "INR")
 * @param {string} params.receipt - Internal receipt/reference identifier
 * @param {Object} params.notes - Additional metadata
 * @returns {Promise<Object>} Gateway order response
 */
async function createOrder({ amount, currency = "INR", receipt, notes = {} }) {
  const impl = getImplementation();
  return impl.createOrder({ amount, currency, receipt, notes });
}

/**
 * Verifies a payment signature/webhook
 * @param {Object} params
 * @param {string} params.orderId - Gateway order ID
 * @param {string} params.paymentId - Gateway payment ID
 * @param {string} params.signature - Gateway signature
 * @returns {Promise<boolean>} True if verification succeeds
 */
async function verifyPayment({ orderId, paymentId, signature }) {
  const impl = getImplementation();
  return impl.verifyPayment({ orderId, paymentId, signature });
}

/**
 * Verifies a webhook notification signature
 * @param {Object} params
 * @param {string} params.payload - Raw webhook payload (string)
 * @param {string} params.signature - Signature from webhook header
 * @returns {Promise<boolean>} True if verification succeeds
 */
async function verifyWebhook({ payload, signature }) {
  const impl = getImplementation();
  return impl.verifyWebhook({ payload, signature });
}

/**
 * Fetches payment details from gateway
 * @param {string} paymentId - Gateway payment ID
 * @returns {Promise<Object>} Payment details
 */
async function fetchPayment(paymentId) {
  const impl = getImplementation();
  return impl.fetchPayment(paymentId);
}

/**
 * Fetches order details from gateway
 * @param {string} orderId - Gateway order ID
 * @returns {Promise<Object>} Order details
 */
async function fetchOrder(orderId) {
  const impl = getImplementation();
  return impl.fetchOrder(orderId);
}

/**
 * Returns gateway-specific checkout options for frontend
 * @param {Object} params
 * @param {string} params.orderId - Gateway order ID
 * @param {number} params.amount - Amount in paise
 * @param {string} params.currency - Currency code
 * @param {string} params.name - Merchant name
 * @param {string} params.description - Order description
 * @param {Object} params.prefill - Customer prefill data {name, email, contact}
 * @param {Object} params.notes - Additional notes
 * @returns {Object} Checkout options for frontend integration
 */
function getCheckoutOptions({ orderId, amount, currency, name, description, prefill, notes }) {
  const impl = getImplementation();
  return impl.getCheckoutOptions({ orderId, amount, currency, name, description, prefill, notes });
}

/**
 * Gets the active gateway name
 * @returns {string}
 */
function getGatewayName() {
  return GATEWAY;
}

/**
 * Checks if gateway is in test/demo mode
 * @returns {boolean}
 */
function isTestMode() {
  return GATEWAY === "demo" || (GATEWAY === "razorpay" && process.env.RAZORPAY_KEY_ID?.startsWith("rzp_test"));
}

/**
 * Internal: gets the active implementation
 */
function getImplementation() {
  switch (GATEWAY) {
    case "razorpay":
      return razorpayImpl;
    case "demo":
    default:
      return demoImpl;
  }
}

/* =========================================================================
 * RAZORPAY IMPLEMENTATION
 * ========================================================================= */

const razorpayImpl = {
  name: "razorpay",

  async createOrder({ amount, currency = "INR", receipt, notes = {} }) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      throw new Error("Razorpay credentials not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.");
    }

    // Use native fetch (Node 18+) or fallback
    const fetch = globalThis.fetch || (await import("node-fetch")).default;

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        amount: Math.round(amount),
        currency,
        receipt: receipt?.slice(0, 40), // Razorpay limits receipt to 40 chars
        notes
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Razorpay order creation failed: ${error.error?.description || response.statusText}`);
    }

    return response.json();
  },

  async verifyPayment({ orderId, paymentId, signature }) {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      throw new Error("Razorpay key secret not configured");
    }

    const expectedSignature = crypto
      .createHmac("sha256", keySecret)
      .update(`${orderId}|${paymentId}`)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );
  },

  async verifyWebhook({ payload, signature }) {
    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.warn("Webhook secret not configured, skipping verification");
      return true; // Allow in development
    }

    const expectedSignature = crypto
      .createHmac("sha256", webhookSecret)
      .update(payload)
      .digest("hex");

    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature)
    );
  },

  async fetchPayment(paymentId) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const fetch = globalThis.fetch || (await import("node-fetch")).default;

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
      headers: { "Authorization": `Basic ${auth}` }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch payment: ${response.statusText}`);
    }
    return response.json();
  },

  async fetchOrder(orderId) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    const fetch = globalThis.fetch || (await import("node-fetch")).default;

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const response = await fetch(`https://api.razorpay.com/v1/orders/${orderId}`, {
      headers: { "Authorization": `Basic ${auth}` }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch order: ${response.statusText}`);
    }
    return response.json();
  },

  getCheckoutOptions({ orderId, amount, currency = "INR", name, description, prefill = {}, notes = {} }) {
    return {
      key: process.env.RAZORPAY_KEY_ID,
      amount,
      currency,
      name: name || "Municipal Corporation",
      description: description || "Bill Payment",
      order_id: orderId,
      prefill: {
        name: prefill.name || "",
        email: prefill.email || "",
        contact: prefill.contact || ""
      },
      notes,
      theme: {
        color: "#0b3d91"
      },
      modal: {
        ondismiss: () => {
          window.dispatchEvent(new CustomEvent("payment-modal-dismissed"));
        }
      }
    };
  }
};

/* =========================================================================
 * DEMO / SANDBOX IMPLEMENTATION (for development without real credentials)
 * ========================================================================= */

// In-memory store for demo orders/payments (resets on server restart)
const demoStore = new Map();
const demoPayments = new Map();
let demoOrderCounter = 0;
let demoPaymentCounter = 0;

const demoImpl = {
  name: "demo",

  async createOrder({ amount, currency = "INR", receipt, notes = {} }) {
    demoOrderCounter++;
    const orderId = `order_demo_${Date.now()}_${demoOrderCounter}`;
    const order = {
      id: orderId,
      entity: "order",
      amount: Math.round(amount),
      amount_paid: 0,
      amount_due: Math.round(amount),
      currency,
      receipt: receipt?.slice(0, 40) || `rcpt_${orderId}`,
      status: "created",
      attempts: 0,
      notes,
      created_at: Math.floor(Date.now() / 1000)
    };
    demoStore.set(orderId, order);
    console.log(`[DEMO] Created order ${orderId} for ${amount} ${currency}`);
    return order;
  },

  async verifyPayment({ orderId, paymentId, signature }) {
    // In demo mode, accept any signature that matches our pattern
    const payment = demoPayments.get(paymentId);
    if (!payment) return false;
    if (payment.order_id !== orderId) return false;
    // Accept demo signatures
    return signature?.startsWith("demo_sig_") || signature === "demo_valid_signature";
  },

  async verifyWebhook({ payload, signature }) {
    // Demo mode: always accept
    console.log("[DEMO] Webhook received:", JSON.parse(payload).event);
    return true;
  },

  async fetchPayment(paymentId) {
    const payment = demoPayments.get(paymentId);
    if (!payment) {
      throw new Error("Payment not found");
    }
    return payment;
  },

  async fetchOrder(orderId) {
    const order = demoStore.get(orderId);
    if (!order) {
      throw new Error("Order not found");
    }
    return order;
  },

  getCheckoutOptions({ orderId, amount, currency = "INR", name, description, prefill = {}, notes = {} }) {
    // Returns a special marker that the frontend will recognize as demo mode
    return {
      __demo: true,
      key: "demo_key",
      amount,
      currency,
      name: name || "Municipal Corporation (Demo)",
      description: description || "Bill Payment (Demo Mode)",
      order_id: orderId,
      prefill: {
        name: prefill.name || "",
        email: prefill.email || "",
        contact: prefill.contact || ""
      },
      notes,
      theme: {
        color: "#0b3d91"
      }
    };
  },

  // Demo helper: simulate a successful payment
  async simulatePayment(orderId, { paymentId, method = "upi", status = "captured" } = {}) {
    const order = demoStore.get(orderId);
    if (!order) throw new Error("Order not found");

    demoPaymentCounter++;
    const pid = paymentId || `pay_demo_${Date.now()}_${demoPaymentCounter}`;
    const payment = {
      id: pid,
      entity: "payment",
      amount: order.amount,
      currency: order.currency,
      status,
      order_id: orderId,
      method,
      captured: status === "captured",
      created_at: Math.floor(Date.now() / 1000)
    };
    demoPayments.set(pid, payment);
    order.status = "paid";
    order.amount_paid = order.amount;
    order.amount_due = 0;
    console.log(`[DEMO] Simulated payment ${pid} for order ${orderId} (${status})`);
    return payment;
  },

  // Demo helper: reset store (for testing)
  __reset() {
    demoStore.clear();
    demoPayments.clear();
    demoOrderCounter = 0;
    demoPaymentCounter = 0;
  }
};

module.exports = {
  createOrder,
  verifyPayment,
  verifyWebhook,
  fetchPayment,
  fetchOrder,
  getCheckoutOptions,
  getGatewayName,
  isTestMode,
  // Export demo helpers for testing
  __demo: demoImpl
};