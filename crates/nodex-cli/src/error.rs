use serde::Serialize;
use thiserror::Error;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CliErrorCode {
    ProjectNotFound,
    ProjectAmbiguous,
    ScopeNotFound,
    ScopeAmbiguous,
    ScopeUnauthorized,
    ScopeBudgetExceeded,
    MaterializationStale,
    CoreUnavailable,
    ProtocolIncompatible,
    SnapshotExpired,
    RgArgumentUnsupported,
    PatchSyntax,
    PatchInvalid,
    PatchNotFound,
    PatchAmbiguous,
    PatchOverlap,
    EtagConflict,
    ProtectedOwnerDeletion,
    IdempotencyKeyReused,
    DraftUnsafePath,
    MetaYamlSyntax,
    MetaYamlInvalid,
    PageIdMismatch,
    DraftReadOnlyFieldChanged,
    DraftInvalidMarkdown,
    DraftAlreadyApplied,
    DraftConflict,
    SkillBundleUnavailable,
    SkillBundleInvalid,
    SkillTargetConflict,
    SkillTargetRaced,
    SkillAgentUnsupported,
    OpenFailed,
    InvalidInput,
    Internal,
}

impl CliErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProjectNotFound => "PROJECT_NOT_FOUND",
            Self::ProjectAmbiguous => "PROJECT_AMBIGUOUS",
            Self::ScopeNotFound => "SCOPE_NOT_FOUND",
            Self::ScopeAmbiguous => "SCOPE_AMBIGUOUS",
            Self::ScopeUnauthorized => "SCOPE_UNAUTHORIZED",
            Self::ScopeBudgetExceeded => "SCOPE_BUDGET_EXCEEDED",
            Self::MaterializationStale => "MATERIALIZATION_STALE",
            Self::CoreUnavailable => "CORE_UNAVAILABLE",
            Self::ProtocolIncompatible => "PROTOCOL_INCOMPATIBLE",
            Self::SnapshotExpired => "SNAPSHOT_EXPIRED",
            Self::RgArgumentUnsupported => "RG_ARGUMENT_UNSUPPORTED",
            Self::PatchSyntax => "PATCH_SYNTAX",
            Self::PatchInvalid => "PATCH_INVALID",
            Self::PatchNotFound => "PATCH_NOT_FOUND",
            Self::PatchAmbiguous => "PATCH_AMBIGUOUS",
            Self::PatchOverlap => "PATCH_OVERLAP",
            Self::EtagConflict => "ETAG_CONFLICT",
            Self::ProtectedOwnerDeletion => "PROTECTED_OWNER_DELETION",
            Self::IdempotencyKeyReused => "IDEMPOTENCY_KEY_REUSED",
            Self::DraftUnsafePath => "DRAFT_UNSAFE_PATH",
            Self::MetaYamlSyntax => "META_YAML_SYNTAX",
            Self::MetaYamlInvalid => "META_YAML_INVALID",
            Self::PageIdMismatch => "PAGE_ID_MISMATCH",
            Self::DraftReadOnlyFieldChanged => "DRAFT_READ_ONLY_FIELD_CHANGED",
            Self::DraftInvalidMarkdown => "DRAFT_INVALID_MARKDOWN",
            Self::DraftAlreadyApplied => "DRAFT_ALREADY_APPLIED",
            Self::DraftConflict => "DRAFT_CONFLICT",
            Self::SkillBundleUnavailable => "SKILL_BUNDLE_UNAVAILABLE",
            Self::SkillBundleInvalid => "SKILL_BUNDLE_INVALID",
            Self::SkillTargetConflict => "SKILL_TARGET_CONFLICT",
            Self::SkillTargetRaced => "SKILL_TARGET_RACED",
            Self::SkillAgentUnsupported => "SKILL_AGENT_UNSUPPORTED",
            Self::OpenFailed => "OPEN_FAILED",
            Self::InvalidInput => "INVALID_INPUT",
            Self::Internal => "CLI_INTERNAL",
        }
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
#[error("{message}")]
pub struct CliError {
    pub code: CliErrorCode,
    pub message: String,
    pub line: Option<usize>,
    pub column: Option<usize>,
    pub hunk: Option<usize>,
    pub path: Option<String>,
}

impl CliError {
    pub fn new(code: CliErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            line: None,
            column: None,
            hunk: None,
            path: None,
        }
    }

    pub fn at_line(mut self, line: usize) -> Self {
        self.line = Some(line);
        self
    }

    pub fn in_hunk(mut self, hunk: usize) -> Self {
        self.hunk = Some(hunk);
        self
    }

    pub fn at_column(mut self, column: usize) -> Self {
        self.column = Some(column);
        self
    }

    pub fn at_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ErrorEnvelope<'a> {
    pub version: u32,
    pub ok: bool,
    pub error: ErrorBody<'a>,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
pub struct ErrorBody<'a> {
    pub code: &'static str,
    pub message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hunk: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<&'a str>,
}

impl<'a> ErrorEnvelope<'a> {
    pub fn new(error: &'a CliError) -> Self {
        Self {
            version: 1,
            ok: false,
            error: ErrorBody {
                code: error.code.as_str(),
                message: &error.message,
                line: error.line,
                column: error.column,
                hunk: error.hunk,
                path: error.path.as_deref(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_errors_use_stable_codes_and_evidence() {
        let error = CliError::new(CliErrorCode::PatchSyntax, "expected hunk")
            .at_line(4)
            .in_hunk(2);
        let value = serde_json::to_value(ErrorEnvelope::new(&error)).expect("error JSON");

        assert_eq!(value["version"], 1);
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"]["code"], "PATCH_SYNTAX");
        assert_eq!(value["error"]["line"], 4);
        assert_eq!(value["error"]["hunk"], 2);
    }
}
