-- Normalize organization city names ("jammu" -> "Jammu", " new  delhi " -> "New Delhi")
-- so search filters and the city list show one spelling per city. New input is normalized by the API.
UPDATE "organizations"
SET "city" = initcap(regexp_replace(btrim("city"), '\s+', ' ', 'g'))
WHERE "city" IS DISTINCT FROM initcap(regexp_replace(btrim("city"), '\s+', ' ', 'g'));
