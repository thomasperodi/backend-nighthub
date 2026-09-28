-- Privacy setting "chi vede le mie serate": if false, friends don't see which nights the user
-- is on the list for (friends/tonight, events/:id/friends-going). Default keeps today's
-- behavior (visible to friends).
ALTER TABLE "users" ADD COLUMN "nights_visible_to_friends" BOOLEAN NOT NULL DEFAULT true;
