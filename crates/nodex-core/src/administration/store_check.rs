use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::infrastructure::migration::{StoreOpenDisposition, store_open_disposition};
use crate::infrastructure::schema::CURRENT_STORE_REVISION;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode, open_reader};
use crate::infrastructure::store::STORE_FILE_NAME;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProfileStoreStatus {
    /// No Store yet; the first open installs the current revision.
    New,
    /// The current revision, opened as is.
    Current,
    /// A published predecessor that the first open upgrades.
    Upgradable,
    /// A Store this build cannot open, such as one written by another build's
    /// unpublished revision or by a newer Nodex.
    Incompatible,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileStoreCheck {
    pub status: ProfileStoreStatus,
    /// The Store's revision; absent while there is no Store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub store_revision: Option<i64>,
    /// The revision this build reads and writes.
    pub current_revision: i64,
    /// Why an incompatible Store cannot be opened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Answers, without opening Core or writing anything, whether this build can open
/// a Profile's Store. Only identity decides it, so a Store that passes may still
/// fail the deep validation that opening performs.
pub fn check_profile_store(profile_home: &Path) -> Result<ProfileStoreCheck, StoreError> {
    let database_path = profile_home.join(STORE_FILE_NAME);
    let present = database_path.try_exists().map_err(|error| {
        StoreError::new(
            StoreErrorCode::InvalidProfile,
            format!("Profile Store is unreadable: {error}"),
            false,
        )
    })?;
    let check = |status, store_revision, reason| ProfileStoreCheck {
        status,
        store_revision,
        current_revision: CURRENT_STORE_REVISION,
        reason,
    };
    if !present {
        return Ok(check(ProfileStoreStatus::New, None, None));
    }
    let connection = open_reader(&database_path)?;
    let revision: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(match store_open_disposition(&connection) {
        Ok(StoreOpenDisposition::Install) => check(ProfileStoreStatus::New, None, None),
        Ok(StoreOpenDisposition::Open) => check(ProfileStoreStatus::Current, Some(revision), None),
        Ok(StoreOpenDisposition::Upgrade { from_revision }) => {
            check(ProfileStoreStatus::Upgradable, Some(from_revision), None)
        }
        Err(error)
            if matches!(
                error.code,
                StoreErrorCode::UnsupportedSchema | StoreErrorCode::StoreCorrupt
            ) =>
        {
            check(
                ProfileStoreStatus::Incompatible,
                Some(revision),
                Some(error.message),
            )
        }
        Err(error) => return Err(error),
    })
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use crate::infrastructure::migration::prepare_profile_store;
    use crate::infrastructure::sqlite::open_writer;

    use super::*;

    #[test]
    fn reports_a_missing_store_as_new() {
        let home = tempdir().expect("Profile home");
        let check = check_profile_store(home.path()).expect("check");
        assert_eq!(check.status, ProfileStoreStatus::New);
        assert_eq!(check.store_revision, None);
        assert_eq!(check.current_revision, CURRENT_STORE_REVISION);
    }

    #[test]
    fn reports_a_prepared_store_as_current() {
        let home = tempdir().expect("Profile home");
        let mut connection = open_writer(&home.path().join(STORE_FILE_NAME)).expect("writer");
        prepare_profile_store(&mut connection, home.path()).expect("prepared Store");
        drop(connection);

        let check = check_profile_store(home.path()).expect("check");
        assert_eq!(check.status, ProfileStoreStatus::Current);
        assert_eq!(check.store_revision, Some(CURRENT_STORE_REVISION));
        assert_eq!(check.reason, None);
    }

    #[test]
    fn reports_a_store_with_another_builds_schema_as_incompatible() {
        let home = tempdir().expect("Profile home");
        let mut connection = open_writer(&home.path().join(STORE_FILE_NAME)).expect("writer");
        prepare_profile_store(&mut connection, home.path()).expect("prepared Store");
        // Another build of the same revision number shaped the schema differently.
        connection
            .execute_batch("CREATE TABLE another_builds_table (id INTEGER PRIMARY KEY)")
            .expect("divergent schema");
        drop(connection);

        let check = check_profile_store(home.path()).expect("check");
        assert_eq!(check.status, ProfileStoreStatus::Incompatible);
        assert_eq!(check.store_revision, Some(CURRENT_STORE_REVISION));
        assert!(
            check
                .reason
                .as_deref()
                .is_some_and(|reason| reason.contains("physical schema fingerprint")),
            "{check:?}"
        );
    }

    #[test]
    fn reports_a_newer_store_as_incompatible() {
        let home = tempdir().expect("Profile home");
        let mut connection = open_writer(&home.path().join(STORE_FILE_NAME)).expect("writer");
        prepare_profile_store(&mut connection, home.path()).expect("prepared Store");
        connection
            .pragma_update(None, "user_version", CURRENT_STORE_REVISION + 1)
            .expect("newer revision");
        drop(connection);

        let check = check_profile_store(home.path()).expect("check");
        assert_eq!(check.status, ProfileStoreStatus::Incompatible);
        assert_eq!(check.store_revision, Some(CURRENT_STORE_REVISION + 1));
    }
}
