DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "lawyer_ratings" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "lawyer_interactions" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "rating_calculation_logs" LIMIT 1)
  THEN
    RAISE EXCEPTION 'Lawyer-rating retirement requires an explicit export/review because legacy rows exist';
  END IF;
END
$$;

DROP TABLE IF EXISTS "rating_calculation_logs";
DROP TABLE IF EXISTS "lawyer_interactions";
DROP TABLE IF EXISTS "lawyer_ratings";
