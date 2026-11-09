use std::env;
use std::path::PathBuf;
use std::process::{self, Command};

use nodex_core::infrastructure::sqlite::{StoreError, open_writer, validate_store};
use nodex_core::infrastructure::store::SqliteStoreKernel;
use nodex_platform::test_support::tempdir;

const CRASH_WRITER_DATABASE_ENV: &str = "NODEX_TEST_CRASH_WRITER_DATABASE";
const CRASH_WRITER_EXIT: i32 = 91;

#[test]
fn abrupt_writer_process() {
    let Some(database_path) = env::var_os(CRASH_WRITER_DATABASE_ENV) else {
        return;
    };
    let connection = open_writer(&PathBuf::from(database_path)).expect("crash writer opens Store");
    connection
        .execute(
            "UPDATE automation_clock_metadata \
             SET created_at_unix_ms = created_at_unix_ms + 1 WHERE id = 1",
            [],
        )
        .expect("crash writer commits into WAL");
    process::exit(CRASH_WRITER_EXIT);
}

#[test]
fn current_store_recovers_a_committed_wal_after_abrupt_writer_exit() {
    let directory = tempdir().expect("disposable Profile");
    let profile_home = directory.path().canonicalize().expect("absolute Profile");
    let database_path = profile_home.join("nodex.db");
    let kernel = SqliteStoreKernel::open(&profile_home).expect("fresh current Store");
    let before = kernel
        .readers()
        .read_default(|connection| {
            connection
                .query_row(
                    "SELECT created_at_unix_ms FROM automation_clock_metadata WHERE id = 1",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(StoreError::from)
        })
        .expect("metadata time");
    drop(kernel);

    let child = Command::new(env::current_exe().expect("current integration test executable"))
        .arg("--exact")
        .arg("abrupt_writer_process")
        .arg("--nocapture")
        .env(CRASH_WRITER_DATABASE_ENV, &database_path)
        .output()
        .expect("launch abrupt writer process");
    assert_eq!(child.status.code(), Some(CRASH_WRITER_EXIT));
    let wal_path = profile_home.join("nodex.db-wal");
    assert!(
        wal_path.metadata().is_ok_and(|metadata| metadata.len() > 0),
        "abrupt process must leave a committed WAL for recovery"
    );

    let recovered = SqliteStoreKernel::open(&profile_home).expect("Core recovers committed WAL");
    recovered
        .readers()
        .read_default(|connection| {
            validate_store(connection)?;
            let after: i64 = connection.query_row(
                "SELECT created_at_unix_ms FROM automation_clock_metadata WHERE id = 1",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(after, before + 1);
            Ok::<_, StoreError>(())
        })
        .expect("recovered Store is valid and includes the committed WAL frame");
}
