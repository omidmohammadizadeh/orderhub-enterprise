-- KEETA is a new OrderSource. A KDS screen's channel filter excludes every
-- order source missing from its list, so without this every existing screen
-- with a non-empty channel list would silently hide Keeta orders — nobody
-- could have ticked a checkbox that did not exist yet.
--
-- Same approach as 20260909170000_kds_channels_never_offered: append KEETA to
-- every screen holding a non-empty channel list. A screen with an empty list
-- already means "all channels" and is left alone, as is any screen that
-- already names KEETA.
UPDATE kds_screens
SET settings = jsonb_set(
      settings,
      '{channels}',
      (settings -> 'channels') || (
        SELECT COALESCE(jsonb_agg(missing.c), '[]'::jsonb)
        FROM unnest(
          ARRAY['KEETA']
        ) AS missing(c)
        WHERE NOT (settings -> 'channels') @> to_jsonb(missing.c)
      )
    )
WHERE jsonb_typeof(settings -> 'channels') = 'array'
  AND jsonb_array_length(settings -> 'channels') > 0
  AND NOT (settings -> 'channels') @> '["KEETA"]'::jsonb;
