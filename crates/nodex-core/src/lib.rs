#![forbid(unsafe_code)]

pub mod administration;
pub mod automation;
pub mod database;
pub mod document;
pub mod domain;
pub mod infrastructure;
pub mod library;
mod module_writer_result;
pub mod query;
pub mod workspace;

pub use module_writer_result::ModuleWriterResult;

#[cfg(test)]
mod read_budget_gate;

pub struct CoreModules {
    pub library: library::LibraryModule,
    pub database: database::DatabaseModule,
    pub query: query::QueryModule,
    pub document: document::OwnedDocumentModule,
    pub workspace: workspace::ProjectWorkspaceModule,
    pub automation: automation::AutomationModule,
    pub administration: administration::StoreAdministrationModule,
}
