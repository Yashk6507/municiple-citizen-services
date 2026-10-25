/**
 * Pure, dependency-free helpers for the municipal complaint workflow.
 * Everything here is explainable, deterministic and unit-testable.
 * No external AI / mapping API is required.
 */

// ---------------------------------------------------------------------------
// Status model (Phase 4)
// ---------------------------------------------------------------------------
const STATUSES = [
  "Submitted",
  "Under Review",
  "Assigned",
  "In Progress",
  "Resolved",
  "Rejected",
  "Reopened",
  "Closed"
];

// A status change is only allowed along these edges. Anything else is rejected
// by the server, so a complaint cannot jump to "Resolved" arbitrarily.
const STATUS_TRANSITIONS = {
  Submitted: ["Under Review", "Assigned", "Rejected", "Closed"],
  "Under Review": ["Assigned", "In Progress", "Rejected", "Closed"],
  Assigned: ["In Progress", "Under Review", "Rejected", "Closed"],
  "In Progress": ["Resolved", "Assigned", "Rejected", "Closed"],
  Reopened: ["Under Review", "Assigned", "In Progress", "Rejected", "Closed"],
  Resolved: ["Reopened", "Closed"],
  Rejected: ["Closed", "Under Review"],
  Closed: ["Reopened"]
};

// Statuses that mean work is still outstanding.
const OPEN_STATUSES = ["Submitted", "Under Review", "Assigned", "In Progress", "Reopened"];

// Statuses a citizen is allowed to request reopening from.
const REOPENABLE_STATUSES = ["Resolved", "Closed", "Rejected"];

const PRIORITIES = ["low", "medium", "high", "critical"];

const APPLICATION_STATUSES = ["Submitted", "Under Review", "Referred", "Approved", "Rejected", "Closed"];

function canTransition(from, to) {
  if (from === to) return false;
  return (STATUS_TRANSITIONS[from] || []).includes(to);
}

// ---------------------------------------------------------------------------
// Reference numbers
// ---------------------------------------------------------------------------
const PREFIX_BY_KIND = { complaint: "CMP", application: "APP" };

function formatReference(kind, year, sequence) {
  const prefix = PREFIX_BY_KIND[kind] || "CMP";
  return `${prefix}-${year}-${String(sequence).padStart(6, "0")}`;
}

function referenceYear(date = new Date()) {
  return String(new Date(date).getUTCFullYear());
}

function referencePattern(kind, year) {
  return `${PREFIX_BY_KIND[kind] || "CMP"}-${year}-%`;
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validLatitude(value) {
  const n = toFiniteNumber(value);
  return n !== null && n >= -90 && n <= 90 ? n : null;
}

function validLongitude(value) {
  const n = toFiniteNumber(value);
  return n !== null && n >= -180 && n <= 180 ? n : null;
}

/** Great-circle distance in metres between two coordinates. */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Text similarity (rule based, no external service)
// ---------------------------------------------------------------------------
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "is", "are", "was", "were", "be", "been", "to", "of",
  "in", "on", "at", "for", "with", "it", "this", "that", "there", "here", "my", "our",
  "we", "i", "you", "has", "have", "had", "not", "no", "very", "also", "please", "pls",
  "kindly", "from", "by", "as", "near", "road", "street"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

/** Jaccard similarity of the meaningful word sets. Range 0..1. */
function textSimilarity(a, b) {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const t of setA) if (setB.has(t)) shared++;
  return shared / (setA.size + setB.size - shared);
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------
function addHours(date, hours) {
  return new Date(new Date(date).getTime() + Number(hours) * 3600 * 1000);
}

/**
 * Resolve the internal target resolution window (in hours) for a complaint.
 * Precedence: subcategory target -> category+priority policy -> priority policy -> default.
 * These are internally configured municipal targets, NOT legally mandated SLAs.
 */
function resolveTargetHours({ subcategorySlaHours, categoryPolicyHours, priorityPolicyHours, fallback = 72 }) {
  const candidates = [subcategorySlaHours, categoryPolicyHours, priorityPolicyHours, fallback];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function slaState(dueAt, now = new Date()) {
  if (!dueAt) return "no_target";
  const due = new Date(dueAt).getTime();
  if (Number.isNaN(due)) return "no_target";
  const remaining = due - new Date(now).getTime();
  if (remaining < 0) return "overdue";
  if (remaining <= 12 * 3600 * 1000) return "due_soon";
  return "on_track";
}

// ---------------------------------------------------------------------------
// Misc validation
// ---------------------------------------------------------------------------
function sanitizeText(value, maxLength = 5000) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function clampPriority(value, fallback = "medium") {
  const v = String(value || "").toLowerCase();
  return PRIORITIES.includes(v) ? v : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parsePagination(query, { defaultLimit = 25, maxLimit = 100 } = {}) {
  const limit = clampInt(query.limit, 1, maxLimit, defaultLimit);
  const page = clampInt(query.page, 1, 100000, 1);
  return { limit, page, offset: (page - 1) * limit };
}

function isValidDate(value) {
  if (!value) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime());
}

module.exports = {
  STATUSES,
  OPEN_STATUSES,
  REOPENABLE_STATUSES,
  PRIORITIES,
  APPLICATION_STATUSES,
  STATUS_TRANSITIONS,
  canTransition,
  formatReference,
  referenceYear,
  referencePattern,
  toFiniteNumber,
  validLatitude,
  validLongitude,
  distanceMeters,
  textSimilarity,
  tokenize,
  addHours,
  resolveTargetHours,
  slaState,
  sanitizeText,
  clampPriority,
  clampInt,
  parsePagination,
  isValidDate
};
