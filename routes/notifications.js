/**
 * Citizen / staff notifications.
 */
const express = require("express");

const { asyncHandler, authMiddleware } = require("../middleware");
const { all, get, run } = require("../lib/store");

const router = express.Router();

router.use(authMiddleware);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = await all(
      `SELECT id, complaint_id, type, message, is_read, created_at
       FROM notifications WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [req.user.id, limit]
    );
    const unread = await get(
      "SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND is_read = 0",
      [req.user.id]
    );
    res.json({ notifications: rows, unread: unread ? unread.c : 0 });
  })
);

router.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid notification id" });
    await run("UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", [id, req.user.id]);
    res.json({ id, is_read: true });
  })
);

router.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    await run("UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0", [req.user.id]);
    res.json({ message: "All notifications marked as read" });
  })
);

module.exports = router;
