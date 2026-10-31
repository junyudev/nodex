/// Native waiting state for activity queries using the `thread` table alias.
pub(super) const NATIVE_THREAD_WAITING_PREDICATE: &str = "thread.status_type = 'active' AND EXISTS (\
       SELECT 1 FROM json_each(thread.status_active_flags_json) flag \
       WHERE flag.value IN ('waitingOnApproval', 'waitingOnUserInput')\
     )";
