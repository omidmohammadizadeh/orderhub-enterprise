-- A KDS screen's channel filter excludes every order source missing from its
-- list. The kitchen-screens settings page offered six checkboxes while
-- OrderSource had thirteen values, so a screen with EVERY offered channel
-- ticked still excluded AI Voice, Talabat, Careem, DoorDash, Grubhub and
-- Direct. Voice orders were dispatched to no screen at all, and an amend
-- deleted the tickets of any that were already there.
--
-- A channel that was never rendered as a checkbox cannot have been switched
-- off by anyone, so its absence is not a decision worth respecting. Append
-- the six unselectable sources to every screen holding a non-empty channel
-- list. A screen with an empty list already means "all channels" and is left
-- alone, as is any screen that already names VOICE.
UPDATE kds_screens
SET settings = jsonb_set(
      settings,
      '{channels}',
      (settings -> 'channels') || (
        SELECT COALESCE(jsonb_agg(missing.c), '[]'::jsonb)
        FROM unnest(
          ARRAY['VOICE', 'TALABAT', 'CAREEM', 'DOORDASH', 'GRUBHUB', 'DIRECT']
        ) AS missing(c)
        WHERE NOT (settings -> 'channels') @> to_jsonb(missing.c)
      )
    )
WHERE jsonb_typeof(settings -> 'channels') = 'array'
  AND jsonb_array_length(settings -> 'channels') > 0
  AND NOT (settings -> 'channels') @> '["VOICE"]'::jsonb;
