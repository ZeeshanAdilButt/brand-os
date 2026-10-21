/**
 * Schema v2: each draft remembers the post it was built from. `source_mdx_sha256` and
 * `source_notes_sha256` are the content row's hashes when the draft was created (NULL for drafts made
 * before v2, and for notes when the post has none). The gate refuses SOURCE_CHANGED when they differ
 * from the content row, so a draft can never be approved against a newer version of the post.
 */
export const DRAFT_SOURCE_SQL = `
ALTER TABLE drafts ADD COLUMN source_mdx_sha256 TEXT;
ALTER TABLE drafts ADD COLUMN source_notes_sha256 TEXT;
`;
