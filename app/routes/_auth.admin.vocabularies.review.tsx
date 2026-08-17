/**
 * Vocabulary review queue — moved
 *
 * The draft-term review queue now lives as one tab of the Pending
 * decisions surface, at `/admin/decisions/vocabulary`, beside the
 * authority proposals and the possible-duplicates worklist. The
 * `vocabulary_terms` status machine moved with it unchanged. This
 * route stays registered — still inside the vocabularies hub layout,
 * so its `vocabulary_hub` capability gate still runs first — so that
 * bookmarks and links written before the move keep resolving.
 *
 * @version v0.7.0
 */

import { redirect } from "react-router";

export function loader() {
  return redirect("/admin/decisions/vocabulary");
}
