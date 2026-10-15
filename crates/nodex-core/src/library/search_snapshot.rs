use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nodex_core_contracts::BoundModuleContext;
use nodex_core_contracts::library::{
    LibraryPageProjectionFileKind, LibrarySearchSnapshotFile, LibrarySearchSnapshotLease,
    LibrarySearchSnapshotManifest, LibrarySearchSnapshotOwner, LibrarySearchSnapshotOwnerKind,
    LibrarySearchSnapshotPage, LibrarySearchSnapshotRelease, LibrarySearchSnapshotScope,
    LibrarySearchSnapshotWarning,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::document::sha256;
use crate::infrastructure::sqlite::{StoreError, StoreErrorCode};

const SNAPSHOT_VERSION: u32 = 1;
const PROJECTION_VERSION: u32 = 2;
const LEASE_TTL_MS: i64 = 5 * 60 * 1_000;
const MAX_SCOPE_PAGES: usize = 10_000;
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
const PRIVATE_DIRECTORY_MODE: u32 = 0o700;
const READ_ONLY_DIRECTORY_MODE: u32 = 0o500;
const PRIVATE_FILE_MODE: u32 = 0o600;
const READ_ONLY_FILE_MODE: u32 = 0o400;

#[derive(Clone)]
struct PreparedFile {
    relative_path: String,
    kind: LibraryPageProjectionFileKind,
    sha256: String,
    bytes: Vec<u8>,
}

#[derive(Clone)]
pub(super) struct PreparedSearchSnapshot {
    manifest: LibrarySearchSnapshotManifest,
    files: Vec<PreparedFile>,
}

#[derive(Clone, Eq, PartialEq)]
pub(super) struct SearchSnapshotCacheKey {
    library_id: String,
    store_epoch: String,
    commit_head: i64,
    scope: LibrarySearchSnapshotScope,
    strict_materialization: bool,
}

struct CachedSearchSnapshot {
    key: SearchSnapshotCacheKey,
    prepared: PreparedSearchSnapshot,
}

#[derive(Deserialize, Serialize)]
struct LeaseMarker {
    lease_id: String,
    expires_at_unix_ms: i64,
    manifest: LibrarySearchSnapshotManifest,
}

pub(super) struct SearchSnapshotStore {
    root: PathBuf,
    cached: Option<CachedSearchSnapshot>,
    lease_keys: BTreeMap<String, SearchSnapshotCacheKey>,
    reusable_key: Option<SearchSnapshotCacheKey>,
}

impl SearchSnapshotStore {
    pub(super) fn new(profile_home: &Path) -> Self {
        Self {
            root: profile_home.join("search-snapshots"),
            cached: None,
            lease_keys: BTreeMap::new(),
            reusable_key: None,
        }
    }

    pub(super) fn acquire_cached(
        &mut self,
        key: &SearchSnapshotCacheKey,
    ) -> Result<Option<LibrarySearchSnapshotLease>, StoreError> {
        let Some(cached) = &self.cached else {
            return Ok(None);
        };
        if cached.key != *key {
            return Ok(None);
        }
        self.acquire(cached.prepared.clone(), key.clone()).map(Some)
    }

    pub(super) fn cleanup_startup(&mut self) -> Result<(), StoreError> {
        self.ensure_layout()?;
        self.discard_reusable()?;
        self.cleanup_cache_temporary_files()?;
        self.cleanup_expired(now_unix_ms()?)
    }

    pub(super) fn acquire(
        &mut self,
        prepared: PreparedSearchSnapshot,
        cache_key: SearchSnapshotCacheKey,
    ) -> Result<LibrarySearchSnapshotLease, StoreError> {
        let now = now_unix_ms()?;
        self.ensure_layout()?;
        self.cleanup_expired(now)?;
        let lease_id = random_hex(16)?;
        let expires_at_unix_ms = now
            .checked_add(LEASE_TTL_MS)
            .ok_or_else(|| internal("Search snapshot expiry overflowed"))?;
        let leases_root = self.root.join("leases");
        let staging = leases_root.join(format!(".{lease_id}.tmp"));
        let destination = leases_root.join(&lease_id);
        let reused_tree = self.reusable_key.as_ref() == Some(&cache_key)
            && fs::symlink_metadata(self.reusable_path()).is_ok();
        if reused_tree {
            fs::rename(self.reusable_path(), &staging)
                .map_err(io_error)
                .map_err(|error| {
                    snapshot_context(error, "could not adopt the reusable lease tree")
                })?;
            self.reusable_key = None;
        } else {
            self.discard_reusable()?;
            create_owned_directory(&staging).map_err(|error| {
                snapshot_context(error, "could not create the lease staging directory")
            })?;
        }

        let result = (|| {
            if !reused_tree {
                let pages_root = staging.join("pages");
                create_owned_directory(&pages_root).map_err(|error| {
                    snapshot_context(error, "could not create the leased pages directory")
                })?;
                let mut page_directories = Vec::new();
                for file in &prepared.files {
                    let cache = self.ensure_cache_file(file).map_err(|error| {
                        snapshot_context(error, "could not validate the projection cache")
                    })?;
                    let target = staging.join(&file.relative_path);
                    let parent = target
                        .parent()
                        .ok_or_else(|| internal("Search snapshot file has no parent"))?;
                    if !parent.is_dir() {
                        create_owned_directory(parent).map_err(|error| {
                            snapshot_context(error, "could not create a leased Page directory")
                        })?;
                        page_directories.push(parent.to_path_buf());
                    }
                    link_immutable_file(&cache, &target, &file.sha256).map_err(|error| {
                        snapshot_context(error, "could not assemble an immutable projection file")
                    })?;
                }

                for directory in page_directories {
                    fs::set_permissions(
                        &directory,
                        fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE),
                    )
                    .map_err(io_error)
                    .map_err(|error| {
                        snapshot_context(error, "could not seal a leased Page directory")
                    })?;
                }
                fs::set_permissions(
                    &pages_root,
                    fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE),
                )
                .map_err(io_error)
                .map_err(|error| snapshot_context(error, "could not seal the leased pages root"))?;
            }

            let marker = LeaseMarker {
                lease_id: lease_id.clone(),
                expires_at_unix_ms,
                manifest: prepared.manifest.clone(),
            };
            let marker_bytes = serde_json::to_vec(&marker)
                .map_err(|_| internal("Search snapshot manifest could not be encoded"))?;
            write_immutable_file(&staging.join("manifest.json"), &marker_bytes)
                .map_err(|error| snapshot_context(error, "could not publish the lease manifest"))?;
            fs::rename(&staging, &destination)
                .map_err(io_error)
                .map_err(|error| snapshot_context(error, "could not publish the lease root"))?;
            fs::set_permissions(
                &destination,
                fs::Permissions::from_mode(READ_ONLY_DIRECTORY_MODE),
            )
            .map_err(io_error)
            .map_err(|error| snapshot_context(error, "could not seal the lease root"))?;
            Ok(())
        })();

        if let Err(error) = result {
            let _ = remove_owned_tree(&staging);
            let _ = remove_owned_tree(&destination);
            return Err(error);
        }

        let lease = LibrarySearchSnapshotLease {
            lease_id,
            expires_at_unix_ms,
            physical_root: destination.to_string_lossy().into_owned(),
            manifest: prepared.manifest.clone(),
        };
        self.cached = Some(CachedSearchSnapshot {
            key: cache_key.clone(),
            prepared,
        });
        self.lease_keys.insert(lease.lease_id.clone(), cache_key);
        Ok(lease)
    }

    pub(super) fn release(
        &mut self,
        lease_id: &str,
    ) -> Result<LibrarySearchSnapshotRelease, StoreError> {
        validate_lease_id(lease_id)?;
        self.ensure_layout()?;
        let target = self.root.join("leases").join(lease_id);
        let existed_before_cleanup = fs::symlink_metadata(&target).is_ok();
        self.cleanup_expired(now_unix_ms()?)?;
        let released = match fs::symlink_metadata(&target) {
            Ok(_) => {
                let lease_key = self.lease_keys.remove(lease_id);
                if self.can_reuse(&target, lease_key.as_ref())? {
                    self.publish_reusable(&target, lease_key.expect("reusable lease key"))?;
                } else {
                    remove_owned_tree(&target)?;
                }
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.lease_keys.remove(lease_id);
                existed_before_cleanup
            }
            Err(error) => return Err(io_error(error)),
        };
        Ok(LibrarySearchSnapshotRelease {
            lease_id: lease_id.to_owned(),
            released,
        })
    }

    pub(super) fn invalidate_all(&mut self) -> Result<(), StoreError> {
        self.ensure_layout()?;
        self.cached = None;
        self.lease_keys.clear();
        self.discard_reusable()?;
        let leases_root = self.root.join("leases");
        for entry in fs::read_dir(&leases_root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            remove_owned_tree(&entry.path())?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn invalidate_prepared(&mut self) {
        self.cached = None;
    }

    fn ensure_layout(&self) -> Result<(), StoreError> {
        ensure_owned_directory(&self.root)?;
        ensure_owned_directory(&self.root.join("cache"))?;
        ensure_owned_directory(&self.root.join("cache/v1"))?;
        ensure_owned_directory(&self.root.join("cache/v1/meta"))?;
        ensure_owned_directory(&self.root.join("cache/v1/body"))?;
        ensure_owned_directory(&self.root.join("leases"))?;
        Ok(())
    }

    fn cleanup_expired(&mut self, now: i64) -> Result<(), StoreError> {
        let leases_root = self.root.join("leases");
        require_owned_directory(&leases_root)?;
        for entry in fs::read_dir(&leases_root).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return Err(invalid_profile(
                    "Search snapshot lease has a non-UTF-8 identity",
                ));
            };
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
            validate_owned_metadata(&metadata, &path)?;
            if !metadata.is_dir() {
                return Err(invalid_profile(
                    "Search snapshot lease root contains a non-directory entry",
                ));
            }
            if name.starts_with('.') {
                remove_owned_tree(&path)?;
                continue;
            }
            validate_lease_id(name)?;
            if metadata.permissions().mode() & 0o777 != READ_ONLY_DIRECTORY_MODE {
                remove_owned_tree(&path)?;
                self.lease_keys.remove(name);
                continue;
            }
            let marker = read_lease_marker(&path.join("manifest.json"))?;
            if marker.lease_id != name || marker.expires_at_unix_ms <= now {
                remove_owned_tree(&path)?;
                self.lease_keys.remove(name);
            }
        }
        Ok(())
    }

    fn reusable_path(&self) -> PathBuf {
        self.root.join(".reusable")
    }

    fn discard_reusable(&mut self) -> Result<(), StoreError> {
        self.reusable_key = None;
        remove_owned_tree(&self.reusable_path())
    }

    fn can_reuse(
        &mut self,
        lease_root: &Path,
        lease_key: Option<&SearchSnapshotCacheKey>,
    ) -> Result<bool, StoreError> {
        let (Some(lease_key), Some(cached)) = (lease_key, &self.cached) else {
            return Ok(false);
        };
        if cached.key != *lease_key {
            return Ok(false);
        }
        if self.reusable_key.as_ref() == Some(lease_key) {
            return Ok(false);
        }
        if self.reusable_key.is_some() {
            self.discard_reusable()?;
        }
        let cached = self
            .cached
            .as_ref()
            .expect("matching search snapshot cache");
        for file in &cached.prepared.files {
            if !validate_immutable_file(&lease_root.join(&file.relative_path), &file.sha256)? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn publish_reusable(
        &mut self,
        lease_root: &Path,
        key: SearchSnapshotCacheKey,
    ) -> Result<(), StoreError> {
        let reusable = self.reusable_path();
        if fs::symlink_metadata(&reusable).is_ok() {
            remove_owned_tree(&reusable)?;
        }
        fs::set_permissions(
            lease_root,
            fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE),
        )
        .map_err(io_error)?;
        remove_owned_file(&lease_root.join("manifest.json"))?;
        fs::rename(lease_root, &reusable).map_err(io_error)?;
        self.reusable_key = Some(key);
        Ok(())
    }

    fn cleanup_cache_temporary_files(&self) -> Result<(), StoreError> {
        for kind in ["meta", "body"] {
            let directory = self.root.join("cache/v1").join(kind);
            require_owned_directory(&directory)?;
            for entry in fs::read_dir(&directory).map_err(io_error)? {
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    return Err(invalid_profile(
                        "Search snapshot cache has a non-UTF-8 entry",
                    ));
                };
                if !name.starts_with('.') {
                    continue;
                }
                remove_owned_file(&entry.path())?;
            }
        }
        Ok(())
    }

    fn ensure_cache_file(&self, file: &PreparedFile) -> Result<PathBuf, StoreError> {
        let kind = match file.kind {
            LibraryPageProjectionFileKind::MetaYaml => "meta",
            LibraryPageProjectionFileKind::BodyNestedMarkdown => "body",
        };
        let parent = self.root.join("cache/v1").join(kind);
        require_owned_directory(&parent)?;
        let path = parent.join(&file.sha256);
        match validate_immutable_file(&path, &file.sha256) {
            Ok(true) => return Ok(path),
            Ok(false) => {}
            Err(error) => return Err(error),
        }

        if fs::symlink_metadata(&path).is_ok() {
            remove_owned_file(&path)?;
        }
        let temporary = parent.join(format!(".{}.{}.tmp", file.sha256, random_hex(8)?));
        let result = (|| {
            write_immutable_file(&temporary, &file.bytes)?;
            fs::rename(&temporary, &path).map_err(io_error)?;
            validate_immutable_file(&path, &file.sha256)?
                .then_some(())
                .ok_or_else(|| {
                    invalid_profile("Search snapshot cache did not retain its canonical bytes")
                })
        })();
        if result.is_err() {
            let _ = remove_owned_file(&temporary);
        }
        result?;
        Ok(path)
    }
}

pub(super) fn cache_key(
    context: &BoundModuleContext,
    store_epoch: &str,
    commit_head: i64,
    scope: LibrarySearchSnapshotScope,
    strict_materialization: bool,
) -> Result<SearchSnapshotCacheKey, StoreError> {
    Ok(SearchSnapshotCacheKey {
        library_id: context.library_id.0.clone(),
        store_epoch: store_epoch.to_owned(),
        commit_head,
        scope,
        strict_materialization,
    })
}

pub(super) fn prepare(
    connection: &Connection,
    library_id: &str,
    store_epoch: &str,
    commit_head: i64,
    context: &BoundModuleContext,
    scope: LibrarySearchSnapshotScope,
    strict_materialization: bool,
) -> Result<PreparedSearchSnapshot, StoreError> {
    let project_id = context
        .project_id
        .as_ref()
        .map(|project| project.0.as_str());
    require_scope(connection, library_id, &scope)?;
    let page_ids = page_ids_in_scope(connection, library_id, &scope)?;
    if page_ids.len() > MAX_SCOPE_PAGES {
        return Err(resource_exhausted(
            "Search snapshot Page count exceeds its bound",
        ));
    }

    let mut pages = Vec::new();
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let mut total_bytes = 0usize;
    for page_id in page_ids {
        super::require_page_read_access(connection, library_id, &page_id)?;
        let body = match super::page_projection::page_projection_file(
            connection,
            library_id,
            store_epoch,
            super::page_projection::PageProjectionFileRequest {
                commit_head,
                requesting_project_id: project_id,
                page_id: &page_id,
                kind: LibraryPageProjectionFileKind::BodyNestedMarkdown,
                prepare: None,
            },
        ) {
            Ok(body) => body,
            Err(error)
                if matches!(
                    error.code,
                    StoreErrorCode::Conflict | StoreErrorCode::RevisionConflict
                ) && !strict_materialization =>
            {
                warnings.push(LibrarySearchSnapshotWarning::MaterializationStale { page_id });
                continue;
            }
            Err(error)
                if matches!(
                    error.code,
                    StoreErrorCode::Conflict | StoreErrorCode::RevisionConflict
                ) =>
            {
                return Err(StoreError::new(
                    StoreErrorCode::MaterializationStale,
                    format!(
                        "Page {page_id} materialization is stale; synchronize the Page projection and retry"
                    ),
                    true,
                ));
            }
            Err(error) => return Err(error),
        };
        let meta = super::page_projection::page_projection_file(
            connection,
            library_id,
            store_epoch,
            super::page_projection::PageProjectionFileRequest {
                commit_head,
                requesting_project_id: project_id,
                page_id: &page_id,
                kind: LibraryPageProjectionFileKind::MetaYaml,
                prepare: None,
            },
        )?;
        let metadata = meta
            .metadata
            .as_ref()
            .ok_or_else(|| internal("Search metadata projection omitted typed metadata"))?;
        let physical_page = sha256(page_id.as_bytes());
        let physical_root = format!("pages/{physical_page}");
        let ownership_path = ownership_path(connection, library_id, &page_id)?;
        let logical_root = logical_page_path(&ownership_path, &metadata.title_markdown, &page_id);
        let meta_file = snapshot_file(
            LibraryPageProjectionFileKind::MetaYaml,
            &format!("{physical_root}/meta.yaml"),
            &format!("{logical_root}/meta.yaml"),
            meta.content.as_bytes(),
        )?;
        let body_file = snapshot_file(
            LibraryPageProjectionFileKind::BodyNestedMarkdown,
            &format!("{physical_root}/body.nested.md"),
            &format!("{logical_root}/body.nested.md"),
            body.content.as_bytes(),
        )?;
        total_bytes = total_bytes
            .checked_add(meta.content.len())
            .and_then(|total| total.checked_add(body.content.len()))
            .ok_or_else(|| resource_exhausted("Search snapshot byte count overflowed"))?;
        if total_bytes > MAX_SNAPSHOT_BYTES {
            return Err(resource_exhausted(
                "Search snapshot projected bytes exceed their bound",
            ));
        }
        let evidence = page_evidence(connection, library_id, &page_id)?;
        pages.push(LibrarySearchSnapshotPage {
            page_id: page_id.clone(),
            title_markdown: metadata.title_markdown.clone(),
            database_id: evidence.database_id,
            data_source_id: evidence.data_source_id,
            ownership_path,
            metadata_revision: meta.metadata_revision,
            document_generation: meta.document_generation,
            document_head_seq: meta.document_head_seq,
            data_source_schema_revision: evidence.data_source_schema_revision,
            property_revisions: evidence.property_revisions,
            value_revisions: evidence.value_revisions,
            schedule_revision: evidence.schedule_revision,
            title_sha256: sha256(metadata.title_markdown.as_bytes()),
            meta: meta_file.clone(),
            body: body_file.clone(),
        });
        files.push(PreparedFile {
            relative_path: meta_file.physical_relative_path,
            kind: meta_file.kind,
            sha256: meta_file.sha256,
            bytes: meta.content.into_bytes(),
        });
        files.push(PreparedFile {
            relative_path: body_file.physical_relative_path,
            kind: body_file.kind,
            sha256: body_file.sha256,
            bytes: body.content.into_bytes(),
        });
    }

    Ok(PreparedSearchSnapshot {
        manifest: LibrarySearchSnapshotManifest {
            version: SNAPSHOT_VERSION,
            projection_version: PROJECTION_VERSION,
            library_id: library_id.to_owned(),
            project_id: project_id.map(str::to_owned),
            store_epoch: store_epoch.to_owned(),
            commit_head,
            scope,
            pages,
            warnings,
        },
        files,
    })
}

#[derive(Default)]
struct PageEvidence {
    database_id: Option<String>,
    data_source_id: Option<String>,
    data_source_schema_revision: Option<i64>,
    property_revisions: BTreeMap<String, i64>,
    value_revisions: BTreeMap<String, i64>,
    schedule_revision: Option<i64>,
}

fn page_evidence(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<PageEvidence, StoreError> {
    let (parent_kind, parent_id) = connection
        .query_row(
            "SELECT page.parent_kind, page.parent_id \
             FROM pages page JOIN blocks block ON block.id = page.block_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.library_id = page.library_id AND block.lifecycle <> 'deleted'",
            params![page_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| not_found("Search snapshot Page is unavailable"))?;
    let terminal_data_source = terminal_data_source(connection, library_id, page_id)?;
    let database_id = terminal_data_source
        .as_deref()
        .map(|data_source_id| database_for_data_source(connection, library_id, data_source_id))
        .transpose()?;
    let mut evidence = PageEvidence {
        database_id,
        data_source_id: terminal_data_source,
        schedule_revision: connection
            .query_row(
                "SELECT source_metadata_revision FROM scheduled_page_index \
                 WHERE page_block_id = ?1 AND lifecycle = 'active'",
                [page_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?,
        ..PageEvidence::default()
    };
    if parent_kind != "data_source" {
        return Ok(evidence);
    }
    evidence.data_source_schema_revision = connection
        .query_row(
            "SELECT schema_revision FROM data_sources \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![parent_id, library_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    evidence.property_revisions = connection
        .prepare(
            "SELECT id, schema_revision FROM data_source_properties \
             WHERE data_source_id = ?1 AND lifecycle = 'active' ORDER BY rank_key, id",
        )?
        .query_map([&parent_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    let membership_id = connection
        .query_row(
            "SELECT id FROM data_source_page_memberships \
             WHERE data_source_id = ?1 AND page_block_id = ?2 AND removed_at IS NULL",
            params![parent_id, page_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if let Some(membership_id) = membership_id {
        evidence.value_revisions = connection
            .prepare(
                "SELECT property_id, revision FROM data_source_property_values \
                 WHERE data_source_id = ?1 AND membership_id = ?2 ORDER BY property_id",
            )?
            .query_map(params![parent_id, membership_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })?
            .collect::<rusqlite::Result<BTreeMap<_, _>>>()?;
    }
    Ok(evidence)
}

fn require_scope(
    connection: &Connection,
    library_id: &str,
    scope: &LibrarySearchSnapshotScope,
) -> Result<(), StoreError> {
    match scope {
        LibrarySearchSnapshotScope::Page { page_id } => {
            validate_identity(page_id, "Search snapshot Page")?;
            super::require_page_read_access(connection, library_id, page_id)
        }
        LibrarySearchSnapshotScope::Database { database_id } => {
            require_database(connection, library_id, database_id)
        }
        LibrarySearchSnapshotScope::DataSource { data_source_id } => {
            validate_identity(data_source_id, "Search snapshot Data Source")?;
            let database_id = database_for_data_source(connection, library_id, data_source_id)?;
            require_database(connection, library_id, &database_id)
        }
    }
}

fn require_database(
    connection: &Connection,
    library_id: &str,
    database_id: &str,
) -> Result<(), StoreError> {
    validate_identity(database_id, "Search snapshot Database")?;
    let active = connection.query_row("SELECT 1 FROM database_containers WHERE block_id = ?1 AND library_id = ?2 AND lifecycle = 'active'", params![database_id, library_id], |_| Ok(())).optional()?;
    if active.is_none() {
        return Err(not_found("Search snapshot Database is unavailable"));
    }
    Ok(())
}

fn database_for_data_source(
    connection: &Connection,
    library_id: &str,
    data_source_id: &str,
) -> Result<String, StoreError> {
    connection
        .query_row(
            "SELECT home_database_block_id FROM data_sources \
             WHERE id = ?1 AND library_id = ?2 AND lifecycle = 'active'",
            params![data_source_id, library_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or_else(|| not_found("Search snapshot Data Source is unavailable"))
}

fn page_ids_in_scope(
    connection: &Connection,
    library_id: &str,
    scope: &LibrarySearchSnapshotScope,
) -> Result<Vec<String>, StoreError> {
    let (seed, identity) = match scope {
        LibrarySearchSnapshotScope::Page { page_id } => (
            "SELECT page.block_id, '|' || page.block_id || '|' FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.block_id = ?1 AND page.library_id = ?2 \
               AND block.lifecycle = 'active'",
            page_id,
        ),
        LibrarySearchSnapshotScope::DataSource { data_source_id } => (
            "SELECT page.block_id, '|' || page.block_id || '|' FROM pages page \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE page.parent_kind = 'data_source' AND page.parent_id = ?1 \
               AND page.library_id = ?2 AND block.lifecycle = 'active'",
            data_source_id,
        ),
        LibrarySearchSnapshotScope::Database { database_id } => (
            "SELECT page.block_id, '|' || page.block_id || '|' \
             FROM pages page JOIN data_sources source \
               ON page.parent_kind = 'data_source' AND page.parent_id = source.id \
             JOIN blocks block ON block.id = page.block_id AND block.library_id = page.library_id \
             WHERE source.home_database_block_id = ?1 AND page.library_id = ?2 \
               AND source.library_id = ?2 AND block.lifecycle = 'active' \
               AND source.lifecycle = 'active'",
            database_id,
        ),
    };
    let sql = format!(
        "WITH RECURSIVE scoped(page_id, path) AS ( \
           {seed} UNION ALL \
           SELECT child.block_id, scoped.path || child.block_id || '|' \
           FROM pages child JOIN blocks child_block \
             ON child_block.id = child.block_id AND child_block.library_id = child.library_id \
           JOIN scoped \
             ON child.parent_kind = 'page' AND child.parent_id = scoped.page_id \
           WHERE child.library_id = ?2 AND child_block.lifecycle = 'active' \
             AND instr(scoped.path, '|' || child.block_id || '|') = 0) \
         SELECT DISTINCT page_id FROM scoped ORDER BY page_id LIMIT ?3"
    );
    connection
        .prepare(&sql)?
        .query_map(
            params![
                identity,
                library_id,
                i64::try_from(MAX_SCOPE_PAGES + 1)
                    .map_err(|_| internal("Search snapshot Page limit overflowed"))?
            ],
            |row| row.get::<_, String>(0),
        )?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StoreError::from)
}

fn ownership_path(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Vec<LibrarySearchSnapshotOwner>, StoreError> {
    let rows = connection
        .prepare(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, depth, path) AS ( \
               SELECT block_id, parent_kind, parent_id, 0, '|' || block_id || '|' \
               FROM pages WHERE block_id = ?1 AND library_id = ?2 \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, \
                 ancestors.depth + 1, ancestors.path || parent.block_id || '|' \
               FROM pages parent JOIN ancestors \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               WHERE parent.library_id = ?2 \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0) \
             SELECT ancestors.page_id, materialization.title, ancestors.parent_kind, \
               ancestors.parent_id, ancestors.depth \
             FROM ancestors JOIN pages page ON page.block_id = ancestors.page_id \
             JOIN documents document ON document.id = page.document_id \
             LEFT JOIN document_materializations materialization \
               ON materialization.document_id = document.id \
               AND materialization.generation = document.generation \
               AND materialization.projected_seq = document.head_seq \
               AND materialization.schema_version = document.schema_version \
             ORDER BY ancestors.depth DESC",
        )?
        .query_map(params![page_id, library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let terminal = rows
        .first()
        .map(|row| (row.2.as_str(), row.3.as_str()))
        .ok_or_else(|| not_found("Search snapshot ownership path is unavailable"))?;
    let mut owners = match terminal.0 {
        "library" if terminal.1 == library_id => vec![LibrarySearchSnapshotOwner {
            kind: LibrarySearchSnapshotOwnerKind::Library,
            id: library_id.to_owned(),
            title: "Library".to_owned(),
        }],
        "data_source" => {
            let (source_name, database_id, database_name) = connection
                .query_row(
                    "SELECT source.name, container.block_id, container.name \
                     FROM data_sources source JOIN database_containers container \
                       ON container.block_id = source.home_database_block_id \
                     WHERE source.id = ?1 AND source.library_id = ?2",
                    params![terminal.1, library_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?
                .ok_or_else(|| not_found("Search snapshot ownership root is unavailable"))?;
            vec![
                LibrarySearchSnapshotOwner {
                    kind: LibrarySearchSnapshotOwnerKind::Database,
                    id: database_id,
                    title: database_name,
                },
                LibrarySearchSnapshotOwner {
                    kind: LibrarySearchSnapshotOwnerKind::DataSource,
                    id: terminal.1.to_owned(),
                    title: source_name,
                },
            ]
        }
        _ => return Err(corrupt("Search snapshot Page ownership path is invalid")),
    };
    for (id, title, _, _, _) in rows {
        if id == page_id {
            continue;
        }
        owners.push(LibrarySearchSnapshotOwner {
            kind: LibrarySearchSnapshotOwnerKind::Page,
            title: title.unwrap_or_else(|| id.clone()),
            id,
        });
    }
    Ok(owners)
}

fn terminal_data_source(
    connection: &Connection,
    library_id: &str,
    page_id: &str,
) -> Result<Option<String>, StoreError> {
    let terminal = connection
        .query_row(
            "WITH RECURSIVE ancestors(page_id, parent_kind, parent_id, path) AS ( \
               SELECT block_id, parent_kind, parent_id, '|' || block_id || '|' \
               FROM pages WHERE block_id = ?1 AND library_id = ?2 \
               UNION ALL \
               SELECT parent.block_id, parent.parent_kind, parent.parent_id, \
                 ancestors.path || parent.block_id || '|' \
               FROM pages parent JOIN ancestors \
                 ON ancestors.parent_kind = 'page' AND parent.block_id = ancestors.parent_id \
               WHERE parent.library_id = ?2 \
                 AND instr(ancestors.path, '|' || parent.block_id || '|') = 0) \
             SELECT parent_kind, parent_id FROM ancestors \
             WHERE parent_kind <> 'page' LIMIT 1",
            params![page_id, library_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| corrupt("Search snapshot Page ownership has no root"))?;
    match terminal.0.as_str() {
        "library" if terminal.1 == library_id => Ok(None),
        "data_source" => Ok(Some(terminal.1)),
        _ => Err(corrupt("Search snapshot Page ownership root is invalid")),
    }
}

fn snapshot_file(
    kind: LibraryPageProjectionFileKind,
    physical_relative_path: &str,
    logical_path: &str,
    bytes: &[u8],
) -> Result<LibrarySearchSnapshotFile, StoreError> {
    Ok(LibrarySearchSnapshotFile {
        kind,
        sha256: sha256(bytes),
        byte_length: u64::try_from(bytes.len())
            .map_err(|_| resource_exhausted("Search snapshot file length overflowed"))?,
        physical_relative_path: physical_relative_path.to_owned(),
        logical_path: logical_path.to_owned(),
    })
}

fn logical_page_path(
    owners: &[LibrarySearchSnapshotOwner],
    title_markdown: &str,
    page_id: &str,
) -> String {
    let mut components = owners
        .iter()
        .map(|owner| sanitize_logical_component(&owner.title))
        .collect::<Vec<_>>();
    components.push(format!(
        "{}~{}",
        sanitize_logical_component(title_markdown),
        page_id
    ));
    components.join("/")
}

fn sanitize_logical_component(value: &str) -> String {
    let mut output = String::new();
    let mut previous_space = false;
    for character in value.chars().take(80) {
        let character = if character == '/' || character == '\\' || character.is_control() {
            ' '
        } else {
            character
        };
        if character.is_whitespace() {
            if !previous_space {
                output.push(' ');
            }
            previous_space = true;
        } else {
            output.push(character);
            previous_space = false;
        }
    }
    let output = output.trim().trim_matches('.');
    if output.is_empty() {
        "Untitled".to_owned()
    } else {
        output.to_owned()
    }
}

fn ensure_owned_directory(path: &Path) -> Result<(), StoreError> {
    match fs::symlink_metadata(path) {
        Ok(_) => require_owned_directory(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => create_owned_directory(path),
        Err(error) => Err(io_error(error)),
    }
}

fn create_owned_directory(path: &Path) -> Result<(), StoreError> {
    fs::create_dir(path).map_err(io_error)?;
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(io_error)?;
    require_owned_directory(path)
}

fn require_owned_directory(path: &Path) -> Result<(), StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_dir() {
        return Err(invalid_profile(
            "Search snapshot storage contains a non-directory component",
        ));
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err(invalid_profile(
            "Search snapshot storage is accessible outside the current user",
        ));
    }
    Ok(())
}

fn validate_owned_metadata(metadata: &fs::Metadata, path: &Path) -> Result<(), StoreError> {
    if metadata.file_type().is_symlink() {
        return Err(invalid_profile(format!(
            "Search snapshot storage must not contain symlinks: {}",
            path.display()
        )));
    }
    if metadata.uid() != rustix::process::geteuid().as_raw() {
        return Err(invalid_profile(
            "Search snapshot storage is not owned by the current user",
        ));
    }
    Ok(())
}

fn validate_immutable_file(path: &Path, expected_sha256: &str) -> Result<bool, StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error(error)),
    };
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != READ_ONLY_FILE_MODE {
        return Ok(false);
    }
    let bytes = fs::read(path).map_err(io_error)?;
    Ok(sha256(&bytes) == expected_sha256)
}

fn write_immutable_file(path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true).mode(PRIVATE_FILE_MODE);
    let mut file = options.open(path).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::set_permissions(path, fs::Permissions::from_mode(READ_ONLY_FILE_MODE)).map_err(io_error)
}

fn link_immutable_file(
    source: &Path,
    destination: &Path,
    expected: &str,
) -> Result<(), StoreError> {
    if !validate_immutable_file(source, expected)? {
        return Err(invalid_profile(
            "Search snapshot cache entry failed validation before assembly",
        ));
    }
    fs::hard_link(source, destination).map_err(io_error)?;
    if !validate_immutable_file(destination, expected)? {
        let _ = fs::remove_file(destination);
        return Err(invalid_profile(
            "Search snapshot cache changed during assembly",
        ));
    }
    Ok(())
}

fn remove_owned_file(path: &Path) -> Result<(), StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_file() {
        return Err(invalid_profile(
            "Search snapshot cache entry is not a regular file",
        ));
    }
    fs::remove_file(path).map_err(io_error)
}

fn remove_owned_tree(path: &Path) -> Result<(), StoreError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(io_error(error)),
    };
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_dir() {
        return Err(invalid_profile("Search snapshot lease is not a directory"));
    }
    fs::set_permissions(path, fs::Permissions::from_mode(PRIVATE_DIRECTORY_MODE))
        .map_err(io_error)?;
    for entry in fs::read_dir(path).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let child = entry.path();
        let child_metadata = fs::symlink_metadata(&child).map_err(io_error)?;
        validate_owned_metadata(&child_metadata, &child)?;
        if child_metadata.is_dir() {
            remove_owned_tree(&child)?;
            continue;
        }
        if !child_metadata.is_file() {
            return Err(invalid_profile(
                "Search snapshot lease contains an unsupported entry",
            ));
        }
        fs::remove_file(child).map_err(io_error)?;
    }
    fs::remove_dir(path).map_err(io_error)
}

fn read_lease_marker(path: &Path) -> Result<LeaseMarker, StoreError> {
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    validate_owned_metadata(&metadata, path)?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o777 != READ_ONLY_FILE_MODE {
        return Err(invalid_profile(
            "Search snapshot manifest is missing or mutable",
        ));
    }
    let bytes = fs::read(path).map_err(io_error)?;
    serde_json::from_slice(&bytes)
        .map_err(|_| invalid_profile("Search snapshot manifest is invalid"))
}

fn validate_identity(value: &str, label: &str) -> Result<(), StoreError> {
    if value.is_empty() || value.len() > 512 || value.trim() != value {
        return Err(invalid(format!(
            "{label} must contain one bounded stable identity"
        )));
    }
    Ok(())
}

fn validate_lease_id(value: &str) -> Result<(), StoreError> {
    if value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(());
    }
    Err(invalid("Search snapshot lease identity is invalid"))
}

fn random_hex(bytes: usize) -> Result<String, StoreError> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value)
        .map_err(|_| internal("Search snapshot identity entropy is unavailable"))?;
    Ok(hex::encode(value))
}

fn now_unix_ms() -> Result<i64, StoreError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| internal("System clock is before the Unix epoch"))?
        .as_millis();
    i64::try_from(millis).map_err(|_| internal("System clock exceeds the supported range"))
}

fn io_error(error: std::io::Error) -> StoreError {
    StoreError::new(
        StoreErrorCode::Internal,
        format!("Search snapshot filesystem operation failed: {error}"),
        false,
    )
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidInput, message, false)
}

fn invalid_profile(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::InvalidProfile, message, false)
}

fn not_found(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::NotFound, message, false)
}

fn corrupt(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::StoreCorrupt, message, false)
}

fn resource_exhausted(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::ResourceExhausted, message, false)
}

fn internal(message: impl Into<String>) -> StoreError {
    StoreError::new(StoreErrorCode::Internal, message, false)
}

fn snapshot_context(error: StoreError, context: &str) -> StoreError {
    StoreError::new(
        error.code,
        format!("{context}: {}", error.message),
        error.retryable,
    )
}
