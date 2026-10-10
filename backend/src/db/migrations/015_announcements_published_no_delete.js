// A published announcement is the record of what was said and when (LLD §2.7). Merged 012 blocks
// UPDATE of a published row; this adds the same guard for DELETE (OQ-63). Drafts stay deletable.

export async function up(knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION announcements_published_no_delete() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.status = 'PUBLISHED' THEN
        RAISE EXCEPTION 'published announcements are immutable';
      END IF;
      RETURN OLD;
    END;
    $fn$;
    CREATE TRIGGER announcements_no_delete_published BEFORE DELETE ON announcements
      FOR EACH ROW EXECUTE FUNCTION announcements_published_no_delete();
  `);
}

export async function down(knex) {
  await knex.raw(`
    DROP TRIGGER announcements_no_delete_published ON announcements;
    DROP FUNCTION announcements_published_no_delete();
  `);
}
