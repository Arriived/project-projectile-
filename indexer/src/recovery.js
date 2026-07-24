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
async function saveCheckpoint(supabase, blockNumber) {
  const { error } = await supabase
    .from("indexer_state")
    .upsert({ id: STATE_ID, last_processed_block: blockNumber, updated_at: new Date().toISOString() });
  if (error) throw error;
}

module.exports = { getLastProcessedBlock, saveCheckpoint };
