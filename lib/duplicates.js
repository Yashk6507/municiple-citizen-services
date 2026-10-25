/**
 * Conservative, rule-based duplicate detection (Phase 11).
 * Only explainable signals are used: same subcategory/category, proximity when
 * both complaints carry valid coordinates, and word-overlap similarity.
 * No external AI service is required.
 */
const { all } = require("./store");
const {
  OPEN_STATUSES,
  distanceMeters,
  textSimilarity,
  validLatitude,
  validLongitude
} = require("./civic");
const { getSettingNumber } = require("./store");

async function findPossibleDuplicates({
  excludeId = null,
  categoryId = null,
  subcategoryId = null,
  description = "",
  latitude = null,
  longitude = null,
  limit = 5
}) {
  const radius = await getSettingNumber("duplicate_radius_meters", 300);
  const similarityThreshold = await getSettingNumber("duplicate_similarity", 0.55);

  const where = [`c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})`];
  const params = [...OPEN_STATUSES];

  if (subcategoryId) {
    where.push("c.subcategory_id = ?");
    params.push(Number(subcategoryId));
  } else if (categoryId) {
    where.push("c.category_id = ?");
    params.push(Number(categoryId));
  } else {
    return [];
  }

  where.push("c.created_at >= datetime('now', '-60 days')");
  if (excludeId) {
    where.push("c.id <> ?");
    params.push(Number(excludeId));
  }

  const candidates = await all(
    `SELECT c.id, c.reference_no, c.title, c.description, c.status, c.latitude, c.longitude,
            c.location_text, c.created_at, sub.name AS subcategory_name
     FROM complaints c
     LEFT JOIN service_subcategories sub ON sub.id = c.subcategory_id
     WHERE ${where.join(" AND ")}
     ORDER BY c.created_at DESC
     LIMIT 80`,
    params
  );

  const lat = validLatitude(latitude);
  const lng = validLongitude(longitude);
  const results = [];

  for (const candidate of candidates) {
    const similarity = textSimilarity(
      description,
      `${candidate.title || ""} ${candidate.description || ""}`
    );

    let distance = null;
    if (lat !== null && lng !== null && candidate.latitude !== null && candidate.longitude !== null) {
      distance = Math.round(
        distanceMeters(lat, lng, Number(candidate.latitude), Number(candidate.longitude))
      );
    }

    const nearby = distance !== null && distance <= radius;
    const similar = similarity >= similarityThreshold;
    if (!nearby && !similar) continue;

    results.push({
      id: candidate.id,
      reference_no: candidate.reference_no,
      status: candidate.status,
      subcategory_name: candidate.subcategory_name,
      location_text: candidate.location_text,
      created_at: candidate.created_at,
      similarity: Number(similarity.toFixed(2)),
      distance_meters: distance,
      reasons: [
        nearby ? `Reported within ${distance} m of the same location` : null,
        similar ? `Description is ${Math.round(similarity * 100)}% similar` : null
      ].filter(Boolean)
    });
  }

  results.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
  return results.slice(0, limit);
}

module.exports = { findPossibleDuplicates };
