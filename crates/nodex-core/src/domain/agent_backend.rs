use nodex_core_contracts::agent::AgentBackendBinding;

pub(crate) fn valid_slug(value: &str) -> bool {
    let mut bytes = value.bytes();
    value.len() <= 64
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic())
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn validate_binding(binding: &AgentBackendBinding) -> Result<(), &'static str> {
    if !valid_slug(&binding.driver) || !valid_slug(&binding.instance_id) {
        return Err("Agent Runtime instance identity is invalid");
    }
    Ok(())
}

pub(crate) fn binding_from_storage(
    driver: String,
    instance_id: String,
) -> Result<AgentBackendBinding, &'static str> {
    let binding = AgentBackendBinding {
        driver,
        instance_id,
    };
    validate_binding(&binding)?;
    Ok(binding)
}
