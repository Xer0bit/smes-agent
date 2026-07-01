-- Fix seats_used counter on organizations table.
--
-- Root cause: org_members inserts never incremented seats_used, so the column
-- always showed 0 regardless of actual member count.
--
-- Solution: a trigger that keeps seats_used in sync automatically, regardless
-- of which code path (app, API, admin) modifies org_members.

CREATE OR REPLACE FUNCTION update_org_seats_used()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE organizations
    SET seats_used = seats_used + 1
    WHERE id = NEW.org_id;

  ELSIF TG_OP = 'DELETE' THEN
    UPDATE organizations
    SET seats_used = GREATEST(seats_used - 1, 0)
    WHERE id = OLD.org_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_org_members_seats_used ON org_members;

CREATE TRIGGER trg_org_members_seats_used
AFTER INSERT OR DELETE ON org_members
FOR EACH ROW EXECUTE FUNCTION update_org_seats_used();

-- Back-fill: recalculate seats_used for all orgs from current member counts
-- so any existing orgs with stale counters are corrected immediately.
UPDATE organizations o
SET seats_used = (
  SELECT COUNT(*)::int
  FROM org_members m
  WHERE m.org_id = o.id
);
