use std::fs;

use nodex_core_contracts::library::{LibraryIntent, LibraryWriteParent};
use nodex_core_contracts::workspace::{
    ProjectSessionIntent, ProjectWorkspaceIntent, ProjectWorkspaceRead, ProjectWorkspaceReadValue,
    ProjectWorkspaceThreadPatch,
};
use nodex_core_contracts::{
    AdapterKind, BoundModuleContext, LIBRARY_CONTRACT_VERSION, LibraryId, ModuleApplyRequest,
    ModuleReadRequest, PROJECT_WORKSPACE_CONTRACT_VERSION, ProfileId, ProjectId, StoreEpoch,
};
use tempfile::{TempDir, tempdir};

use crate::infrastructure::sqlite::with_immediate_transaction;
use crate::infrastructure::store::SqliteStoreKernel;

use super::ProjectWorkspaceModule;
use crate::library::LibraryModule;

pub(super) const NOW: &str = "2026-07-19T06:00:00.000Z";

pub(super) struct TestWorkspace {
    pub _directory: TempDir,
    pub kernel: SqliteStoreKernel,
    pub module: ProjectWorkspaceModule,
}

pub(super) fn context() -> BoundModuleContext {
    BoundModuleContext {
        editor_history_owner: None,
        profile_id: ProfileId("profile-1".to_owned()),
        library_id: LibraryId("library-1".to_owned()),
        project_id: Some(ProjectId("project:default".to_owned())),
        connection_id: "connection:workspace-sidebar-search".to_owned(),
        adapter: AdapterKind::Test,
    }
}

pub(super) fn seeded_workspace() -> TestWorkspace {
    let directory = tempdir().expect("Profile");
    let home = directory.path().canonicalize().expect("absolute Profile");
    fs::create_dir(home.join("assets")).expect("assets root");
    let kernel = SqliteStoreKernel::open_test(&home).expect("fresh store");
    kernel
        .writer()
        .call(|connection| {
            with_immediate_transaction(connection, |transaction| {
                transaction.execute(
                    "INSERT INTO profiles(id, created_at, updated_at)
                     VALUES ('profile-1', ?1, ?1)",
                    [NOW],
                )?;
                transaction.execute(
                    "INSERT INTO libraries(id, profile_id, created_at, updated_at)
                     VALUES ('library-1', 'profile-1', ?1, ?1)",
                    [NOW],
                )?;
                transaction.execute(
                    "INSERT INTO block_store_metadata(id, store_epoch, created_at, updated_at)
                     VALUES (1, 'epoch-1', ?1, ?1)",
                    [NOW],
                )?;
                Ok(())
            })
        })
        .expect("seed Workspace identity");
    let module =
        ProjectWorkspaceModule::new("profile-1", "library-1", &kernel).expect("Workspace module");
    module.seed_rootless_default_project_for_test();
    TestWorkspace {
        _directory: directory,
        kernel,
        module,
    }
}

pub(super) fn request(
    operation_id: &str,
    intent: ProjectWorkspaceIntent,
) -> ModuleApplyRequest<ProjectWorkspaceIntent> {
    ModuleApplyRequest {
        contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
        operation_id: operation_id.to_owned(),
        store_epoch: StoreEpoch("epoch-1".to_owned()),
        intent,
    }
}

pub(super) fn apply(
    module: &ProjectWorkspaceModule,
    operation_id: &str,
    intent: ProjectWorkspaceIntent,
) {
    module
        .apply(&context(), request(operation_id, intent))
        .expect("Workspace mutation");
}

pub(super) fn read(
    module: &ProjectWorkspaceModule,
    read: ProjectWorkspaceRead,
) -> ProjectWorkspaceReadValue {
    module
        .read(
            &context(),
            ModuleReadRequest {
                contract_version: PROJECT_WORKSPACE_CONTRACT_VERSION,
                read,
            },
        )
        .expect("Workspace read")
        .value
}

pub(super) fn create_project(
    module: &ProjectWorkspaceModule,
    operation_id: &str,
    project_id: &str,
) {
    apply(
        module,
        operation_id,
        ProjectWorkspaceIntent::CreateProject {
            project_id: project_id.to_owned(),
            name: project_id.to_owned(),
            description: String::new(),
            appearance: None,
            source_roots: vec![format!("/workspace/{project_id}")],
            page_key_prefix: None,
        },
    );
}

pub(super) fn create_library_page(workspace: &TestWorkspace, page_id: &str, _project_id: &str) {
    let library = LibraryModule::new("profile-1", "library-1", &workspace.kernel);
    let mut library_context = context();
    library_context.project_id = None;
    library
        .apply(
            &library_context,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: format!("create-{page_id}"),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: LibraryIntent::CreatePage {
                    page_id: page_id.to_owned(),
                    document_id: format!("document:{page_id}"),
                    title: page_id.to_owned(),
                    parent: LibraryWriteParent::Library { before: None },
                },
            },
        )
        .expect("create Page");
}

/// A Library File of image bytes, as an imported paste or drop leaves it.
pub(super) fn create_library_image(workspace: &TestWorkspace, file_id: &str) {
    let bytes = format!("image bytes for {file_id}").into_bytes();
    let hash = crate::document::sha256(&bytes);
    let assets = workspace
        ._directory
        .path()
        .canonicalize()
        .expect("Profile")
        .join("assets");
    fs::write(assets.join(format!("{hash}.blob")), &bytes).expect("blob bytes");
    let (blob_hash, length) = (hash.clone(), bytes.len() as i64);
    workspace
        .kernel
        .writer()
        .call(move |connection| {
            connection.execute(
                "INSERT INTO managed_blobs(content_hash, physical_asset_name, byte_length, created_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![blob_hash, format!("{blob_hash}.blob"), length, NOW],
            )?;
            Ok(())
        })
        .expect("managed blob");
    let library = LibraryModule::new("profile-1", "library-1", &workspace.kernel);
    let mut library_context = context();
    library_context.project_id = None;
    let receipt = format!("receipt:{file_id}");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64;
    library
        .register_prepared_file_blob(
            &library_context,
            "epoch-1",
            &format!("create-{file_id}"),
            &receipt,
            &hash,
            &format!("{hash}.blob"),
            bytes.len() as u64,
            now + 60_000,
        )
        .expect("prepared blob");
    library
        .apply(
            &library_context,
            ModuleApplyRequest {
                contract_version: LIBRARY_CONTRACT_VERSION,
                operation_id: format!("create-{file_id}"),
                store_epoch: StoreEpoch("epoch-1".to_owned()),
                intent: LibraryIntent::ApplyFileChange {
                    change: nodex_core_contracts::library::LibraryFileChange::Create {
                        file_id: file_id.to_owned(),
                        default_name: "shot.png".to_owned(),
                        mime_type: "image/png".to_owned(),
                        prepared_blob_receipt_id: receipt,
                    },
                    turn_id: None,
                },
            },
        )
        .expect("create File");
}

pub(super) fn create_session_thread(
    module: &ProjectWorkspaceModule,
    prefix: &str,
    session_id: &str,
    thread_id: &str,
    project_id: Option<&str>,
    updated_at: i64,
) {
    apply(
        module,
        &format!("{prefix}-session"),
        ProjectWorkspaceIntent::CreateSession {
            session_id: session_id.to_owned(),
            project_id: project_id.map(str::to_owned),
            title: thread_id.to_owned(),
            initial_page_ids: Vec::new(),
        },
    );
    apply(
        module,
        &format!("{prefix}-thread"),
        ProjectWorkspaceIntent::UpsertThread {
            thread_id: thread_id.to_owned(),
            patch: Box::new(ProjectWorkspaceThreadPatch {
                project_id: Some(project_id.map(str::to_owned)),
                thread_name: Some(Some(thread_id.to_owned())),
                thread_preview: Some(format!("{thread_id} preview")),
                created_at: Some(updated_at),
                updated_at: Some(updated_at),
                linked_at: Some(NOW.to_owned()),
                ..ProjectWorkspaceThreadPatch::default()
            }),
        },
    );
    apply(
        module,
        &format!("{prefix}-link"),
        ProjectWorkspaceIntent::MutateSession {
            session_id: session_id.to_owned(),
            intent: ProjectSessionIntent::LinkThread {
                thread_id: thread_id.to_owned(),
                expected_project_id: project_id.map(str::to_owned),
                thread_patch: None,
                execution_location: None,
            },
        },
    );
}
