use nodex_core_contracts::agent::AgentBackendBinding;

pub(crate) const MAX_AGENT_BACKEND_ID_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AgentBackendStorage<'a> {
    pub kind: &'static str,
    pub agent_definition_id: Option<&'a str>,
    pub instance_config_id: Option<&'a str>,
}

fn validate_id(value: &str) -> bool {
    !value.is_empty() && value.trim() == value && value.len() <= MAX_AGENT_BACKEND_ID_BYTES
}

pub(crate) fn binding_storage(
    binding: &AgentBackendBinding,
) -> Result<AgentBackendStorage<'_>, &'static str> {
    match binding {
        AgentBackendBinding::Codex => Ok(AgentBackendStorage {
            kind: "codex",
            agent_definition_id: None,
            instance_config_id: None,
        }),
        AgentBackendBinding::Acp {
            agent_definition_id,
            instance_config_id,
        } => {
            if !validate_id(agent_definition_id)
                || instance_config_id
                    .as_deref()
                    .is_some_and(|value| !validate_id(value))
            {
                return Err("ACP backend binding identity is invalid");
            }
            Ok(AgentBackendStorage {
                kind: "acp",
                agent_definition_id: Some(agent_definition_id),
                instance_config_id: instance_config_id.as_deref(),
            })
        }
    }
}

pub(crate) fn binding_from_storage(
    kind: &str,
    agent_definition_id: Option<String>,
    instance_config_id: Option<String>,
) -> Result<AgentBackendBinding, &'static str> {
    let binding = match kind {
        "codex" if agent_definition_id.is_none() && instance_config_id.is_none() => {
            AgentBackendBinding::Codex
        }
        "acp" => AgentBackendBinding::Acp {
            agent_definition_id: agent_definition_id
                .ok_or("ACP backend binding is missing its Agent definition")?,
            instance_config_id,
        },
        _ => return Err("Agent backend binding columns are inconsistent"),
    };
    binding_storage(&binding)?;
    Ok(binding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_explicit_backend_bindings() {
        let acp = AgentBackendBinding::Acp {
            agent_definition_id: "claude-agent-acp".to_owned(),
            instance_config_id: Some("work-profile".to_owned()),
        };
        let stored = binding_storage(&acp).expect("valid binding");
        assert_eq!(stored.kind, "acp");
        assert_eq!(stored.agent_definition_id, Some("claude-agent-acp"));
        assert_eq!(stored.instance_config_id, Some("work-profile"));
        assert_eq!(
            binding_from_storage(
                stored.kind,
                stored.agent_definition_id.map(str::to_owned),
                stored.instance_config_id.map(str::to_owned),
            )
            .expect("stored binding"),
            acp
        );
        assert_eq!(
            binding_from_storage("codex", None, None).expect("Codex binding"),
            AgentBackendBinding::Codex
        );
    }

    #[test]
    fn rejects_partial_or_ambiguous_bindings() {
        assert!(binding_from_storage("acp", None, None).is_err());
        assert!(binding_from_storage("codex", Some("extra".to_owned()), None).is_err());
        assert!(
            binding_storage(&AgentBackendBinding::Acp {
                agent_definition_id: "  ".to_owned(),
                instance_config_id: None,
            })
            .is_err()
        );
    }
}
