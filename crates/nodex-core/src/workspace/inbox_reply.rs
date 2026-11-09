//! Person replies commit their decision and delivery evidence with capture.
use super::*;
use nodex_core_contracts::workspace::ProjectWorkspaceSessionExecutionRef;

#[allow(clippy::too_many_arguments)]
    connection: &Connection,
    body: &str,
    now: &str,
    }
            }
            }
            Some(response)
        }
    };
    let action = ProjectWorkspaceInboxDispatchAction::SendToChat {
        additions: vec![],
    };
    connection.execute(
    )?;
}
