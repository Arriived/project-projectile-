const STATE_ID = "arc_launch_factory";

/// @notice Reads the last block this indexer successfully processed. Falls back to
///         FACTORY_DEPLOY_BLOCK (via the caller) if no checkpoint exists yet — e.g. on
///         a completely fresh database.
async function getLastProcessedBlock(supabase) {
  const { data, error } = await supabase
    .from("indexer_state")
    .select("last_processed_block")
    .eq("id", STATE_ID)
    .maybeSingle();

  if (error) throw error;
  return data ? Number(data.last_processed_block) : null;
}

/// @notice Upserts the checkpoint. Called after each batch of logs is successfully
///         written to the database — NOT before, so a crash mid-batch means the next
///         run re-processes that batch rather than silently skipping it. The upserts
///         into `tokens`/`trades` are themselves idempotent (see index.js), so
///         re-processing a batch is safe, just slightly redundant.
///
/// ⚠ MONOTONIC. The checkpoint may only ever move FORWARD.
///
/// This used to be a bare upsert, and that is a silent data-loss hazard the moment two
/// indexers run at once — which is easy to do by accident and was done by accident while
/// testing this very fix. Both processes catch up from wherever they each started, and
/// each one blindly writes its own cursor, so the SLOWER process overwrites the faster
/// one's progress and the checkpoint goes BACKWARDS. Observed: 59782875 written, then
/// 59776875 written over it.
///
/// Nothing is corrupted by that — every handler is idempotent, so the range is simply
/// re-read — but it means the indexer can appear to make no progress while working hard,
/// and the head-lag liveness check in index.js would eventually (correctly) kill it
/// without the cause ever being obvious.
///
/// Refusing to lower it makes concurrent instances merely wasteful instead of
/// pathological, and costs one read.
async function saveCheckpoint(supabase, blockNumber) {
  const current = await getLastProcessedBlock(supabase);
  if (current !== null && blockNumber <= current) {
    // Not an error: a concurrent or restarted instance re-reading old ground is expected
    // and harmless. It just must not be recorded as progress.
    return { advanced: false, from: current, to: current };
  }

  const { error } = await supabase
    .from("indexer_state")
    .upsert({ id: STATE_ID, last_processed_block: blockNumber, updated_at: new Date().toISOString() });
  if (error) throw error;
  return { advanced: true, from: current, to: blockNumber };
}

module.exports = { getLastProcessedBlock, saveCheckpoint };
