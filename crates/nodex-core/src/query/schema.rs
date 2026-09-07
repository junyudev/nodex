//! The public catalog describes product relations, never private Store schemas.
use nodex_core_contracts::sql::{SqlColumn, SqlTable};
use nodex_sqlite_query::{Affinity, Column, Table};

pub(super) const RELATIONS: &[&str] = &[
    "pages",
    "page_documents",
    "databases",
    "data_sources",
    "properties",
    "property_options",
    "views",
    "property_values",
    "page_relations",
    "view_rows",
    "search_hits",
    "library_children",
    "page_files",
    "files",
    "file_versions",
    "file_usages",
    "page_history",
];

pub(super) fn column(name: &str, storage: &str, nullable: bool, description: &str) -> SqlColumn {
    SqlColumn {
        name: name.into(),
        storage_type: storage.into(),
        nullable,
        description: description.into(),
        property_id: None,
        property_schema: None,
        options: Vec::new(),
    }
}

type RelationDefinition = (
    &'static str,
    &'static [&'static str],
    &'static [&'static str],
    Option<&'static str>,
    &'static [(&'static str, &'static str, bool)],
);

pub(super) fn describe(name: &str) -> Option<SqlTable> {
    let (description, keys, args, ordering, fields): RelationDefinition = match name {
        "pages" => (
            "One authorized active Page, including standalone Pages; no body is loaded.",
            &["page_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("page_key", "TEXT", true),
                ("title", "TEXT", false),
                ("data_source_id", "TEXT", true),
                ("created_at", "TEXT", false),
                ("updated_at", "TEXT", false),
                ("title_etag", "TEXT", false),
                ("file_manifest_revision", "INTEGER", false),
                ("intrinsic_properties", "TEXT", false),
            ],
        ),
        "page_documents" => (
            "One current Page body, loaded only when selected; body_etag guards this exact observation.",
            &["page_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("nested_markdown", "TEXT", false),
                ("body_etag", "TEXT", false),
            ],
        ),
        "databases" => (
            "One authorized active Database.",
            &["database_id"],
            &[],
            None,
            &[
                ("database_id", "TEXT", false),
                ("name", "TEXT", false),
                ("default_view_id", "TEXT", true),
                ("metadata_revision", "INTEGER", false),
                ("access_revision", "INTEGER", false),
                ("created_at", "TEXT", false),
                ("updated_at", "TEXT", false),
            ],
        ),
        "data_sources" => (
            "One active Source in an authorized Database. Bind its ID to query Property columns.",
            &["data_source_id"],
            &[],
            None,
            &[
                ("data_source_id", "TEXT", false),
                ("database_id", "TEXT", false),
                ("name", "TEXT", false),
                ("schema_revision", "INTEGER", false),
                ("created_at", "TEXT", false),
                ("updated_at", "TEXT", false),
            ],
        ),
        "properties" => (
            "One active Property with its domain schema and configuration revision.",
            &["data_source_id", "property_id"],
            &[],
            None,
            &[
                ("data_source_id", "TEXT", false),
                ("property_id", "TEXT", false),
                ("name", "TEXT", false),
                ("schema_json", "TEXT", false),
                ("revision", "INTEGER", false),
                ("system_role", "TEXT", true),
                ("option_count", "INTEGER", false),
            ],
        ),
        "property_options" => (
            "One select option; identity is scoped to its Source and Property.",
            &["data_source_id", "property_id", "option_id"],
            &[],
            None,
            &[
                ("data_source_id", "TEXT", false),
                ("property_id", "TEXT", false),
                ("option_id", "TEXT", false),
                ("name", "TEXT", false),
                ("color", "TEXT", true),
            ],
        ),
        "views" => (
            "One active saved View with its complete shared configuration.",
            &["view_id"],
            &[],
            None,
            &[
                ("view_id", "TEXT", false),
                ("database_id", "TEXT", false),
                ("data_source_id", "TEXT", false),
                ("name", "TEXT", false),
                ("layout", "TEXT", false),
                ("revision", "INTEGER", false),
                ("config_json", "TEXT", false),
                ("is_default", "INTEGER", false),
                ("created_at", "TEXT", false),
                ("updated_at", "TEXT", false),
            ],
        ),
        "property_values" => (
            "One active member Page/Property pair; unset values retain domain default revisions.",
            &["page_id", "data_source_id", "property_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("data_source_id", "TEXT", false),
                ("property_id", "TEXT", false),
                ("value_json", "TEXT", false),
                ("value_revision", "INTEGER", false),
                ("membership_revision", "INTEGER", false),
            ],
        ),
        "page_relations" => (
            "One visible Relation edge; restricted target identities are omitted, so visible counts are not total edge counts.",
            &["page_id", "data_source_id", "property_id", "target_page_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("data_source_id", "TEXT", false),
                ("property_id", "TEXT", false),
                ("target_page_id", "TEXT", false),
            ],
        ),
        "view_rows" => (
            "One Page occurrence in the complete saved View; a Page may occur more than once. COUNT(DISTINCT page_id) counts Pages.",
            &["occurrence_id"],
            &["view_id"],
            Some("ordinal"),
            &[
                ("occurrence_id", "TEXT", false),
                ("page_id", "TEXT", false),
                ("title", "TEXT", false),
                ("group_key", "TEXT", true),
                ("subgroup_key", "TEXT", true),
                ("parent_occurrence_id", "TEXT", true),
                ("ordinal", "INTEGER", false),
            ],
        ),
        "search_hits" => (
            "One of the top K authorized Page search hits. Outer WHERE filters those top K, not all matches; COUNT counts returned hits only.",
            &["page_id"],
            &["query", "k"],
            Some("ordinal"),
            &[
                ("page_id", "TEXT", false),
                ("title", "TEXT", false),
                ("snippet", "TEXT", false),
                ("ordinal", "INTEGER", false),
            ],
        ),
        "library_children" => (
            "One canonical navigation parent/child edge; unrelated to View hierarchy.",
            &["parent_kind", "parent_id", "child_kind", "child_id"],
            &[],
            Some("parent_kind, parent_id, ordinal"),
            &[
                ("parent_kind", "TEXT", false),
                ("parent_id", "TEXT", false),
                ("child_kind", "TEXT", false),
                ("child_id", "TEXT", false),
                ("title", "TEXT", false),
                ("ordinal", "INTEGER", false),
            ],
        ),
        "page_files" => (
            "One deduplicated current Page/File use. Page access grants current metadata, not independent File history.",
            &["page_id", "file_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("file_id", "TEXT", false),
                ("path", "TEXT", true),
                ("default_name", "TEXT", false),
                ("mime_type", "TEXT", false),
                ("byte_length", "INTEGER", false),
                ("version", "INTEGER", false),
                ("blob_etag", "TEXT", false),
                ("manifest_revision", "INTEGER", false),
                ("body_usage_revision", "INTEGER", false),
                ("body_count", "INTEGER", false),
            ],
        ),
        "files" => (
            "One independently authorized Library File, including trashed Files.",
            &["file_id"],
            &[],
            None,
            &[
                ("file_id", "TEXT", false),
                ("default_name", "TEXT", false),
                ("head_version", "INTEGER", false),
                ("revision", "INTEGER", false),
                ("lifecycle", "TEXT", false),
                ("mime_type", "TEXT", false),
                ("byte_length", "INTEGER", false),
                ("blob_etag", "TEXT", false),
                ("created_at", "TEXT", false),
                ("updated_at", "TEXT", false),
            ],
        ),
        "file_versions" => (
            "One retained File version; requires independent File access.",
            &["file_id", "version"],
            &[],
            None,
            &[
                ("file_id", "TEXT", false),
                ("version", "INTEGER", false),
                ("mime_type", "TEXT", false),
                ("byte_length", "INTEGER", false),
                ("blob_etag", "TEXT", false),
                ("actor_id", "TEXT", false),
                ("turn_id", "TEXT", true),
                ("operation_id", "TEXT", false),
                ("occurred_at", "TEXT", false),
            ],
        ),
        "file_usages" => (
            "One authorized visible File usage; unavailable targets are not exposed.",
            &["file_id", "target_kind", "target_id"],
            &[],
            None,
            &[
                ("file_id", "TEXT", false),
                ("target_kind", "TEXT", false),
                ("target_id", "TEXT", false),
                ("page_id", "TEXT", true),
                ("title", "TEXT", false),
                ("path", "TEXT", true),
                ("occurrence_count", "INTEGER", false),
                ("lifecycle", "TEXT", false),
            ],
        ),
        "page_history" => (
            "One retained public Page history event; unavailable historical data is not invented.",
            &["page_id", "event_id"],
            &[],
            None,
            &[
                ("page_id", "TEXT", false),
                ("event_id", "TEXT", false),
                ("occurred_at", "TEXT", false),
                ("event_json", "TEXT", false),
            ],
        ),
        _ => return None,
    };
    let examples = match name {
        "page_documents" => vec![
            "SELECT page_id, nested_markdown, body_etag FROM page_documents WHERE page_id = :id"
                .into(),
        ],
        "view_rows" => vec!["SELECT page_id, title FROM view_rows(:view) ORDER BY ordinal".into()],
        "search_hits" => vec![
            "SELECT page_id, title, snippet FROM search_hits(:query, 5) ORDER BY ordinal".into(),
        ],
        _ => vec![format!("SELECT * FROM {name} LIMIT 10")],
    };
    Some(SqlTable {
        table: name.into(),
        name: name.into(),
        data_source_id: None,
        description: description.into(),
        row_identity: keys.iter().map(|s| (*s).into()).collect(),
        arguments: args.iter().map(|s| (*s).into()).collect(),
        ordering: ordering.map(str::to_owned),
        examples,
        columns: fields
            .iter()
            .map(|(n, t, v)| column(n, t, *v, ""))
            .collect(),
    })
}

pub(super) fn virtual_table(table: &SqlTable) -> Table {
    let mut columns: Vec<Column> = table
        .columns
        .iter()
        .map(|c| Column {
            name: c.name.clone(),
            affinity: affinity(&c.storage_type),
            hidden: false,
        })
        .collect();
    let required_arguments = (columns.len()..columns.len() + table.arguments.len()).collect();
    for arg in &table.arguments {
        columns.push(Column {
            name: arg.clone(),
            affinity: if arg == "k" {
                Affinity::Integer
            } else {
                Affinity::Text
            },
            hidden: true,
        });
    }
    Table {
        name: table.table.clone(),
        columns,
        identity_column: if table.arguments.is_empty() {
            table.columns.iter().position(|c| {
                c.name == "page_id"
                    || (table.row_identity.len() == 1 && table.row_identity[0] == c.name)
            })
        } else {
            None
        },
        required_arguments,
        scan_cost: if table.table == "page_documents" {
            1e9
        } else {
            1e6
        },
        estimated_rows: 10_000,
    }
}
fn affinity(storage: &str) -> Affinity {
    match storage {
        "INTEGER" => Affinity::Integer,
        "REAL" => Affinity::Real,
        _ => Affinity::Text,
    }
}
