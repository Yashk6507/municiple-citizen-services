/**
 * Public transparency endpoints (Phase 12).
 *
 * Every number is computed live from real complaint records. Only aggregated
 * figures are exposed: no names, phone numbers, emails, exact addresses or
 * private attachments ever leave this router.
 *
 * A configurable minimum group size (`transparency_min_group_size`, default 3)
 * suppresses small breakdown groups so individual citizens cannot be
 * identified from a public chart.
 */
const express = require("express");

const { asyncHandler } = require("../middleware");
const { all, get, getSettingNumber } = require("../lib/store");
const { OPEN_STATUSES } = require("../lib/civic");

const router = express.Router();

const PUBLIC_FILTER = "c.is_public = 1";

/**
 * Resolution rate formula (documented for administrators):
 *   resolution_rate = complaints with resolved_at set / (total - rejected)
 * Rejected complaints are excluded from the denominator because they were
 * never actionable work; "Closed" complaints that were resolved keep their
 * resolved_at marker and therefore still count as resolved.
 */
function resolutionRate(resolved, total, rejected) {
  const denominator = total - rejected;
  if (denominator <= 0) return total === 0 ? 0 : null;
  return Number((resolved / denominator).toFixed(4));
}

// ---------------------------------------------------------------------------
// GET /api/public/overview — headline figures for the landing page
// ---------------------------------------------------------------------------
router.get(
  "/overview",
  asyncHandler(async (req, res) => {
    const totalRow = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN c.resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN c.due_at IS NOT NULL AND c.due_at < CURRENT_TIMESTAMP
                        AND c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})
                       THEN 1 ELSE 0 END) AS overdue
       FROM complaints c WHERE ${PUBLIC_FILTER}`,
      [...OPEN_STATUSES]
    );
    const statusRows = await all(
      `SELECT c.status, COUNT(*) AS count FROM complaints c
       WHERE ${PUBLIC_FILTER} GROUP BY c.status`
    );
    const byStatus = {};
    for (const row of statusRows) byStatus[row.status] = row.count;

    const categoryRows = await all(
      `SELECT COALESCE(cat.name, c.category) AS name, COUNT(*) AS count
       FROM complaints c
       LEFT JOIN service_categories cat ON cat.id = c.category_id
       WHERE ${PUBLIC_FILTER}
       GROUP BY COALESCE(cat.name, c.category)
       ORDER BY count DESC LIMIT 6`
    );

    const monthRows = await all(
      `SELECT strftime('%Y-%m', c.created_at) AS month, COUNT(*) AS count
       FROM complaints c
       WHERE ${PUBLIC_FILTER} AND c.created_at >= datetime('now', '-6 months')
       GROUP BY month ORDER BY month ASC`
    );

    const total = totalRow ? totalRow.total : 0;
    res.json({
      total,
      resolved: totalRow && totalRow.resolved ? totalRow.resolved : 0,
      overdue: totalRow && totalRow.overdue ? totalRow.overdue : 0,
      open: OPEN_STATUSES.reduce((sum, s) => sum + (byStatus[s] || 0), 0),
      by_status: byStatus,
      by_category: categoryRows,
      by_month: monthRows,
      generated_at: new Date().toISOString()
    });
  })
);

// ---------------------------------------------------------------------------
// GET /api/public/transparency — full public transparency dashboard
// ---------------------------------------------------------------------------
router.get(
  "/transparency",
  asyncHandler(async (req, res) => {
    const minGroup = await getSettingNumber("public_min_group_count", 3);

    const totals = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN c.resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN c.status = 'Rejected' THEN 1 ELSE 0 END) AS rejected,
              SUM(CASE WHEN c.due_at IS NOT NULL AND c.due_at < CURRENT_TIMESTAMP
                        AND c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})
                       THEN 1 ELSE 0 END) AS overdue,
              AVG(CASE WHEN c.resolved_at IS NOT NULL
                       THEN (julianday(c.resolved_at) - julianday(c.created_at)) * 24 END) AS avg_hours,
              MAX(c.updated_at) AS last_activity
       FROM complaints c WHERE ${PUBLIC_FILTER}`,
      [...OPEN_STATUSES]
    );

    const byStatus = await all(
      `SELECT c.status, COUNT(*) AS count FROM complaints c
       WHERE ${PUBLIC_FILTER} GROUP BY c.status ORDER BY count DESC`
    );

    const byCategory = await all(
      `SELECT COALESCE(cat.name, c.category) AS name, COUNT(*) AS count
       FROM complaints c
       LEFT JOIN service_categories cat ON cat.id = c.category_id
       WHERE ${PUBLIC_FILTER}
       GROUP BY COALESCE(cat.name, c.category)
       ORDER BY count DESC`
    );

    // Ward breakdown is aggregated only and small groups are suppressed.
    const wardRows = await all(
      `SELECT COALESCE(w.name, 'Ward not recorded') AS name, COUNT(*) AS count
       FROM complaints c
       LEFT JOIN wards w ON w.id = c.ward_id
       WHERE ${PUBLIC_FILTER}
       GROUP BY COALESCE(w.name, 'Ward not recorded')
       ORDER BY count DESC`
    );
    const byWard = [];
    let suppressedWards = 0;
    for (const row of wardRows) {
      if (row.count < minGroup) {
        suppressedWards += 1;
        continue;
      }
      byWard.push(row);
    }

    const recentlyResolved = await all(
      `SELECT c.reference_no, COALESCE(cat.name, c.category) AS category_name,
              c.resolved_at, c.created_at
       FROM complaints c
       LEFT JOIN service_categories cat ON cat.id = c.category_id
       WHERE ${PUBLIC_FILTER} AND c.resolved_at IS NOT NULL
       ORDER BY c.resolved_at DESC LIMIT 10`
    );

    const total = totals ? totals.total : 0;
    const resolved = totals && totals.resolved ? totals.resolved : 0;
    const rejected = totals && totals.rejected ? totals.rejected : 0;

    res.json({
      totals: {
        total,
        resolved,
        rejected,
        open: OPEN_STATUSES.reduce(
          (sum, s) => sum + ((byStatus.find((r) => r.status === s) || {}).count || 0),
          0
        ),
        overdue: totals && totals.overdue ? totals.overdue : 0
      },
      resolution_rate: resolutionRate(resolved, total, rejected),
      resolution_rate_definition:
        "Resolved complaints (resolved_at set) divided by all complaints except those rejected.",
      average_resolution_hours:
        totals && totals.avg_hours ? Number(Number(totals.avg_hours).toFixed(1)) : null,
      by_status: byStatus,
      by_category: byCategory,
      by_ward: byWard,
      ward_min_group_size: minGroup,
      suppressed_ward_groups: suppressedWards,
      recently_resolved: recentlyResolved,
      last_complaint_activity: totals ? totals.last_activity : null,
      generated_at: new Date().toISOString()
    });
  })
);

module.exports = router;
