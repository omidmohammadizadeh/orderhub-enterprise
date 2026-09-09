-- Voice test mode answers calls without charging the shop. It was a plain
-- boolean, so a location switched to it during setup answered free calls
-- forever and nobody ever noticed, because everything worked — the shop was
-- simply never billed.
--
-- It now carries an expiry, and a location flagged test mode WITHOUT one
-- counts as lapsed (the safe direction to be wrong in is billing). Give every
-- location currently in test mode a fortnight so nobody's testing stops the
-- moment this deploys; after that they are charged like anyone else, and
-- ticking the box again renews it.
UPDATE locations
SET settings = jsonb_set(
      settings,
      '{voiceTestModeUntil}',
      to_jsonb(
        to_char(
          (now() + interval '14 days') AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
      )
    )
WHERE settings ->> 'voiceTestMode' = 'true'
  AND settings -> 'voiceTestModeUntil' IS NULL;
