-- How a stay's exit was detected: 'geofence' (background location, precise), 'app' (location
-- checked when the app is opened, upper bound), 'auto' (closed at the end of the night,
-- estimated). NULL while the stay is open.
ALTER TABLE "venue_stays" ADD COLUMN "exit_source" TEXT;
