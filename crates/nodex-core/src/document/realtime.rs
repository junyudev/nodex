use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use nodex_core_contracts::document::{
    OwnedDocumentEvent, OwnedDocumentIntent, OwnedDocumentRead, OwnedDocumentReadValue,
};
use nodex_core_contracts::{
    BoundModuleContext, CommittedCoreModuleEvent, CoreError, CoreErrorCode, CoreErrorRecovery,
    CoreModuleEventPayload, ModuleApplyRequest, ModuleReadRequest, ModuleReadSnapshot,
    OWNED_DOCUMENT_CONTRACT_VERSION, StoreEpoch,
};

use crate::infrastructure::document_repository::DocumentSyncEngine;

use super::{DocumentAwareness, OwnedDocumentApplyOutcome, OwnedDocumentModule};

const MAX_DOCUMENT_SUBSCRIPTIONS: usize = 2_048;
const MAX_DOCUMENT_SUBSCRIPTIONS_PER_CONNECTION: usize = 64;
const MAX_AWARENESS_PUBLICATION_BYTES: usize = 4 * 1024;
const MAX_AWARENESS_CLIENTS_PER_UPDATE: usize = 16;
const MAX_AWARENESS_CLIENTS_PER_SUBSCRIPTION: usize = 8;
const MAX_AWARENESS_CLIENTS_PER_DOCUMENT: usize = 16;
const MAX_AWARENESS_SNAPSHOT_BYTES: usize = 96 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentSubscriptionEngine {
    Yjs,
    CanvasScene,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentSubscriptionAck {
    pub lease_id: u64,
    pub document_id: String,
    pub store_epoch: StoreEpoch,
    pub generation: i64,
    pub head_seq: i64,
    pub commit_head: i64,
    pub engine: DocumentSubscriptionEngine,
    pub awareness_update: Option<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DocumentRealtimeEvent {
    Awareness {
        document_id: String,
        store_epoch: StoreEpoch,
        generation: i64,
        client_session_id: String,
        update: Vec<u8>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct AwarenessPublication {
    pub event: DocumentRealtimeEvent,
    pub recipient_connections: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DocumentRealtimeActivity {
    pub subscriptions: usize,
    pub awareness_clients: usize,
}

struct Subscription {
    lease_id: u64,
    context: BoundModuleContext,
    document_id: String,
    client_session_id: String,
    store_epoch: StoreEpoch,
    generation: i64,
    head_seq: i64,
    engine: DocumentSubscriptionEngine,
    awareness_client_ids: BTreeSet<u64>,
}

#[derive(Default)]
struct RealtimeState {
    subscriptions: BTreeMap<(String, String), Subscription>,
    awareness_owners: BTreeMap<(String, u64), (String, String)>,
    awareness_documents: BTreeMap<String, DocumentAwareness>,
}

#[derive(Clone)]
pub struct OwnedDocumentRealtimeAdapter {
    module: OwnedDocumentModule,
    state: Arc<Mutex<RealtimeState>>,
    next_lease_id: Arc<std::sync::atomic::AtomicU64>,
}

impl OwnedDocumentRealtimeAdapter {
    pub fn new(module: OwnedDocumentModule) -> Self {
        Self {
            module,
            state: Arc::new(Mutex::new(RealtimeState::default())),
            next_lease_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        }
    }

    pub fn reset_for_store_replacement(&self) -> Result<(), CoreError> {
        let mut state = self.lock_state()?;
        *state = RealtimeState::default();
        Ok(())
    }

    pub fn activity(&self) -> Result<DocumentRealtimeActivity, CoreError> {
        let state = self.lock_state()?;
        Ok(DocumentRealtimeActivity {
            subscriptions: state.subscriptions.len(),
            awareness_clients: state.awareness_owners.len(),
        })
    }

    pub fn subscribe(
        &self,
        context: &BoundModuleContext,
        document_id: String,
        client_session_id: String,
    ) -> Result<DocumentSubscriptionAck, CoreError> {
        validate_identity(&document_id, "Document")?;
        validate_identity(&client_session_id, "client session")?;
        let boundary = self
            .module
            .authorize_realtime_subscription(context, &document_id)?;
        let engine = match boundary.engine {
            DocumentSyncEngine::Yjs => DocumentSubscriptionEngine::Yjs,
            DocumentSyncEngine::CanvasScene => DocumentSubscriptionEngine::CanvasScene,
        };
        let key = (context.connection_id.clone(), client_session_id.clone());
        let mut state = self.lock_state()?;
        if let Some(existing) = state.subscriptions.get(&key)
            && (existing.document_id != document_id
                || existing.context.project_id != context.project_id
                || existing.context.profile_id != context.profile_id)
        {
            return Err(unauthorized(
                "A client session cannot be rebound to a different Document boundary",
            ));
        }
        let existing = state.subscriptions.contains_key(&key);
        if !existing {
            let connection_subscriptions = state
                .subscriptions
                .keys()
                .filter(|(connection_id, _)| connection_id == &context.connection_id)
                .count();
            ensure_subscription_capacity(state.subscriptions.len(), connection_subscriptions)?;
        }
        let awareness_update = if engine == DocumentSubscriptionEngine::Yjs {
            let update = state
                .awareness_documents
                .entry(document_id.clone())
                .or_insert_with(|| DocumentAwareness::new(&document_id))
                .full_update_v1()
                .map_err(engine_error)?;
            if update.len() > MAX_AWARENESS_SNAPSHOT_BYTES {
                return Err(resource_exhausted(
                    "Document Awareness snapshot capacity is exhausted",
                ));
            }
            Some(update)
        } else {
            None
        };
        let lease_id = self
            .next_lease_id
            .fetch_update(
                std::sync::atomic::Ordering::Relaxed,
                std::sync::atomic::Ordering::Relaxed,
                |value| value.checked_add(1),
            )
            .map_err(|_| resource_exhausted("Document lease identity exhausted"))?;
        if let Some(subscription) = state.subscriptions.get_mut(&key) {
            subscription.lease_id = lease_id;
            subscription.store_epoch = boundary.store_epoch.clone();
            subscription.generation = boundary.generation;
            subscription.head_seq = boundary.head_seq;
        }
        if !existing {
            state.subscriptions.insert(
                key,
                Subscription {
                    lease_id,
                    context: context.clone(),
                    document_id: document_id.clone(),
                    client_session_id,
                    store_epoch: boundary.store_epoch.clone(),
                    generation: boundary.generation,
                    head_seq: boundary.head_seq,
                    engine,
                    awareness_client_ids: BTreeSet::new(),
                },
            );
        }
        Ok(DocumentSubscriptionAck {
            lease_id,
            document_id,
            store_epoch: boundary.store_epoch,
            generation: boundary.generation,
            head_seq: boundary.head_seq,
            commit_head: boundary.commit_head,
            engine,
            awareness_update,
        })
    }

    pub fn require_subscription(
        &self,
        connection_id: &str,
        client_session_id: &str,
        document_id: &str,
    ) -> Result<DocumentSubscriptionAck, CoreError> {
        let state = self.lock_state()?;
        let subscription = state
            .subscriptions
            .get(&(connection_id.to_owned(), client_session_id.to_owned()))
            .filter(|subscription| subscription.document_id == document_id)
            .ok_or_else(|| subscription_required("An exact Document subscription is required"))?;
        Ok(subscription_ack(subscription, 0))
    }

    pub fn sync_yjs(
        &self,
        context: &BoundModuleContext,
        client_session_id: &str,
        document_id: String,
        state_vector: Vec<u8>,
        history_after_head_seq: Option<i64>,
    ) -> Result<ModuleReadSnapshot<OwnedDocumentReadValue>, CoreError> {
        let subscription =
            self.require_subscription(&context.connection_id, client_session_id, &document_id)?;
        if subscription.engine != DocumentSubscriptionEngine::Yjs {
            return Err(invalid("Yjs sync requires a Yjs subscription"));
        }
        self.module.read(
            context,
            ModuleReadRequest {
                contract_version: OWNED_DOCUMENT_CONTRACT_VERSION,
                read: OwnedDocumentRead::SyncYjs {
                    document_id,
                    state_vector,
                    history_after_head_seq,
                },
            },
        )
    }

    pub fn sync_canvas(
        &self,
        context: &BoundModuleContext,
        client_session_id: &str,
        document_id: String,
    ) -> Result<super::CanvasSceneSyncSnapshot, CoreError> {
        let subscription =
            self.require_subscription(&context.connection_id, client_session_id, &document_id)?;
        if subscription.engine != DocumentSubscriptionEngine::CanvasScene {
            return Err(invalid("Canvas sync requires a Canvas subscription"));
        }
        self.module.sync_canvas(context, &document_id)
    }

    pub fn apply(
        &self,
        context: &BoundModuleContext,
        client_session_id: &str,
        request: ModuleApplyRequest<OwnedDocumentIntent>,
    ) -> Result<OwnedDocumentApplyOutcome, CoreError> {
        let document_id = intent_document_id(&request.intent)
            .ok_or_else(|| invalid("Realtime Adapter accepts only Document-bound mutations"))?;
        self.require_subscription(&context.connection_id, client_session_id, document_id)?;
        let outcome = self
            .module
            .apply_with_client_session(context, client_session_id, request)?;
        for event in &outcome.events {
            self.adopt_committed_boundary(event)?;
        }
        Ok(outcome)
    }

    pub fn publish_awareness(
        &self,
        connection_id: &str,
        client_session_id: &str,
        store_epoch: &StoreEpoch,
        generation: i64,
        update: &[u8],
    ) -> Result<Option<AwarenessPublication>, CoreError> {
        let key = (connection_id.to_owned(), client_session_id.to_owned());
        let mut state = self.lock_state()?;
        if update.len() > MAX_AWARENESS_PUBLICATION_BYTES {
            return Err(resource_exhausted(
                "Awareness publication exceeds its byte capacity",
            ));
        }
        let inspected = DocumentAwareness::inspect_update_v1(update).map_err(engine_error)?;
        if inspected.len() > MAX_AWARENESS_CLIENTS_PER_UPDATE {
            return Err(resource_exhausted(
                "Awareness publication contains too many client identities",
            ));
        }
        let document_id = state
            .subscriptions
            .get(&key)
            .ok_or_else(|| subscription_required("An exact Yjs subscription is required"))?
            .document_id
            .clone();
        for (client_id, _) in &inspected {
            if let Some(owner) = state
                .awareness_owners
                .get(&(document_id.clone(), *client_id))
                && owner != &key
            {
                return Err(unauthorized(
                    "Awareness client identity is already owned by another subscription",
                ));
            }
        }
        let mut subscription_clients = state
            .subscriptions
            .get(&key)
            .ok_or_else(|| subscription_required("An exact Yjs subscription is required"))?
            .awareness_client_ids
            .clone();
        let mut document_clients = state
            .awareness_owners
            .keys()
            .filter(|(candidate, _)| candidate == &document_id)
            .map(|(_, client_id)| *client_id)
            .collect::<BTreeSet<_>>();
        for (client_id, present) in &inspected {
            if *present {
                subscription_clients.insert(*client_id);
                document_clients.insert(*client_id);
            } else {
                subscription_clients.remove(client_id);
                document_clients.remove(client_id);
            }
        }
        ensure_awareness_capacity(subscription_clients.len(), document_clients.len())?;
        let (subscription_store_epoch, subscription_generation) = {
            let subscription = state
                .subscriptions
                .get(&key)
                .ok_or_else(|| subscription_required("An exact Yjs subscription is required"))?;
            if subscription.engine != DocumentSubscriptionEngine::Yjs {
                return Err(invalid("Canvas subscriptions do not accept Awareness"));
            }
            if &subscription.store_epoch != store_epoch || subscription.generation != generation {
                return Err(CoreError {
                    code: CoreErrorCode::GenerationConflict,
                    message: "Awareness belongs to a different Document identity boundary"
                        .to_owned(),
                    retryable: false,
                    recovery: CoreErrorRecovery::CurrentDocumentHead {
                        generation: subscription.generation,
                        head_seq: subscription.head_seq,
                    },
                });
            }
            (subscription.store_epoch.clone(), subscription.generation)
        };
        let change = state
            .awareness_documents
            .get_mut(&document_id)
            .ok_or_else(|| internal("Yjs Document Awareness is missing"))?
            .apply_update_v1(update)
            .map_err(engine_error)?;
        let Some(change) = change else {
            return Ok(None);
        };
        let changed_ids = change
            .added
            .iter()
            .chain(change.updated.iter())
            .chain(change.removed.iter())
            .copied()
            .collect::<BTreeSet<_>>();
        if let Some(subscription) = state.subscriptions.get_mut(&key) {
            for client_id in change.added.iter().chain(change.updated.iter()) {
                subscription.awareness_client_ids.insert(*client_id);
            }
            for client_id in &change.removed {
                subscription.awareness_client_ids.remove(client_id);
            }
        }
        for client_id in change.added.iter().chain(change.updated.iter()) {
            state
                .awareness_owners
                .insert((document_id.clone(), *client_id), key.clone());
        }
        for client_id in &change.removed {
            state
                .awareness_owners
                .remove(&(document_id.clone(), *client_id));
        }
        if changed_ids.is_empty() {
            return Ok(None);
        }
        let recipients = recipients_for_document(&state, &document_id, &key);
        Ok(Some(AwarenessPublication {
            event: DocumentRealtimeEvent::Awareness {
                document_id,
                store_epoch: subscription_store_epoch,
                generation: subscription_generation,
                client_session_id: client_session_id.to_owned(),
                update: update.to_vec(),
            },
            recipient_connections: recipients,
        }))
    }

    /// A late physical stream finalizer cannot revoke a newer lease of the same logical session.
    pub fn release_lease(
        &self,
        connection_id: &str,
        client_session_id: &str,
        lease_id: u64,
    ) -> Result<Option<AwarenessPublication>, CoreError> {
        let mut state = self.lock_state()?;
        let key = (connection_id.to_owned(), client_session_id.to_owned());
        if !state
            .subscriptions
            .get(&key)
            .is_some_and(|value| value.lease_id == lease_id)
        {
            return Ok(None);
        }
        remove_subscription(&mut state, &key)
    }

    pub fn unsubscribe(
        &self,
        connection_id: &str,
        client_session_id: &str,
    ) -> Result<Option<AwarenessPublication>, CoreError> {
        let mut state = self.lock_state()?;
        remove_subscription(
            &mut state,
            &(connection_id.to_owned(), client_session_id.to_owned()),
        )
    }

    pub fn disconnect(&self, connection_id: &str) -> Result<Vec<AwarenessPublication>, CoreError> {
        let mut state = self.lock_state()?;
        let keys = state
            .subscriptions
            .keys()
            .filter(|(candidate, _)| candidate == connection_id)
            .cloned()
            .collect::<Vec<_>>();
        let mut publications = Vec::new();
        for key in keys {
            if let Some(publication) = remove_subscription(&mut state, &key)? {
                publications.push(publication);
            }
        }
        Ok(publications)
    }

    pub fn revoke_document_access(&self, document_id: &str) -> Result<Vec<String>, CoreError> {
        let mut state = self.lock_state()?;
        let connections = state
            .subscriptions
            .iter()
            .filter(|(_, subscription)| subscription.document_id == document_id)
            .map(|((connection_id, _), _)| connection_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let keys = state
            .subscriptions
            .iter()
            .filter(|(_, subscription)| subscription.document_id == document_id)
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(subscription) = state.subscriptions.remove(&key) {
                for client_id in subscription.awareness_client_ids {
                    state
                        .awareness_owners
                        .remove(&(subscription.document_id.clone(), client_id));
                }
            }
        }
        state.awareness_documents.remove(document_id);
        Ok(connections)
    }

    fn adopt_committed_boundary(&self, event: &CommittedCoreModuleEvent) -> Result<(), CoreError> {
        let Some(document_id) = event_document_id(event) else {
            return Ok(());
        };
        let mut state = self.lock_state()?;
        for subscription in state.subscriptions.values_mut() {
            if subscription.document_id != document_id {
                continue;
            }
            subscription.store_epoch = event.store_epoch.clone();
            match &event.payload {
                CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentUpdated {
                    generation,
                    head_seq,
                    ..
                })
                | CoreModuleEventPayload::OwnedDocument(
                    OwnedDocumentEvent::DocumentResyncRequired {
                        generation,
                        head_seq,
                        ..
                    },
                )
                | CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::CanvasUpdated {
                    generation,
                    head_seq,
                    ..
                }) => {
                    subscription.generation = *generation;
                    subscription.head_seq = *head_seq;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, RealtimeState>, CoreError> {
        self.state
            .lock()
            .map_err(|_| internal("Document realtime state lock failed"))
    }
}

fn subscription_ack(subscription: &Subscription, commit_head: i64) -> DocumentSubscriptionAck {
    DocumentSubscriptionAck {
        lease_id: subscription.lease_id,
        document_id: subscription.document_id.clone(),
        store_epoch: subscription.store_epoch.clone(),
        generation: subscription.generation,
        head_seq: subscription.head_seq,
        commit_head,
        engine: subscription.engine,
        awareness_update: None,
    }
}

fn recipients_for_document(
    state: &RealtimeState,
    document_id: &str,
    sender: &(String, String),
) -> Vec<String> {
    state
        .subscriptions
        .iter()
        .filter(|(key, subscription)| *key != sender && subscription.document_id == document_id)
        .map(|((connection_id, _), _)| connection_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn remove_subscription(
    state: &mut RealtimeState,
    key: &(String, String),
) -> Result<Option<AwarenessPublication>, CoreError> {
    let Some(subscription) = state.subscriptions.remove(key) else {
        return Ok(None);
    };
    for client_id in &subscription.awareness_client_ids {
        state
            .awareness_owners
            .remove(&(subscription.document_id.clone(), *client_id));
    }
    let publication = if subscription.awareness_client_ids.is_empty() {
        None
    } else {
        let update = state
            .awareness_documents
            .get_mut(&subscription.document_id)
            .ok_or_else(|| internal("Yjs Document Awareness is missing"))?
            .remove_clients_v1(
                &subscription
                    .awareness_client_ids
                    .iter()
                    .copied()
                    .collect::<Vec<_>>(),
            )
            .map_err(engine_error)?;
        Some(AwarenessPublication {
            event: DocumentRealtimeEvent::Awareness {
                document_id: subscription.document_id.clone(),
                store_epoch: subscription.store_epoch,
                generation: subscription.generation,
                client_session_id: subscription.client_session_id,
                update,
            },
            recipient_connections: recipients_for_document(state, &subscription.document_id, key),
        })
    };
    if !state
        .subscriptions
        .values()
        .any(|candidate| candidate.document_id == subscription.document_id)
    {
        state.awareness_documents.remove(&subscription.document_id);
    }
    Ok(publication)
}

fn intent_document_id(intent: &OwnedDocumentIntent) -> Option<&str> {
    match intent {
        OwnedDocumentIntent::ApplyYjsUpdate { document_id, .. }
        | OwnedDocumentIntent::ApplySemanticMutation { document_id, .. }
        | OwnedDocumentIntent::ApplyOperationBatch { document_id, .. }
        | OwnedDocumentIntent::ReplaceFromNfm { document_id, .. }
        | OwnedDocumentIntent::ApplyCanvasMutation { document_id, .. }
        | OwnedDocumentIntent::CompactCanvasTombstones { document_id, .. }
        | OwnedDocumentIntent::CreateCheckpoint { document_id, .. }
        | OwnedDocumentIntent::RestoreVersion { document_id, .. } => Some(document_id),
        OwnedDocumentIntent::ExecutePreparedAgentSemanticMutation { mutation, .. } => {
            Some(&mutation.document_id)
        }
        OwnedDocumentIntent::CaptureRecovery { .. }
        | OwnedDocumentIntent::ResolveRecovery { .. }
        | OwnedDocumentIntent::PrepareOwner { .. }
        | OwnedDocumentIntent::ApplyOwnerCommand { .. } => None,
    }
}

fn event_document_id(event: &CommittedCoreModuleEvent) -> Option<&str> {
    match &event.payload {
        CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentUpdated {
            document_id,
            ..
        })
        | CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentResyncRequired {
            document_id,
            ..
        })
        | CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::CanvasUpdated {
            document_id,
            ..
        })
        | CoreModuleEventPayload::OwnedDocument(OwnedDocumentEvent::DocumentInvalidated {
            document_id,
            ..
        }) => Some(document_id),
        _ => None,
    }
}

fn validate_identity(value: &str, label: &str) -> Result<(), CoreError> {
    if !value.is_empty() && value.len() <= 512 && value.trim() == value {
        return Ok(());
    }
    Err(invalid(format!("{label} identity is invalid")))
}

fn ensure_subscription_capacity(total: usize, connection: usize) -> Result<(), CoreError> {
    if total >= MAX_DOCUMENT_SUBSCRIPTIONS {
        return Err(resource_exhausted(
            "Document subscription capacity is exhausted",
        ));
    }
    if connection >= MAX_DOCUMENT_SUBSCRIPTIONS_PER_CONNECTION {
        return Err(resource_exhausted(
            "Connection Document subscription capacity is exhausted",
        ));
    }
    Ok(())
}

fn ensure_awareness_capacity(subscription: usize, document: usize) -> Result<(), CoreError> {
    if subscription > MAX_AWARENESS_CLIENTS_PER_SUBSCRIPTION {
        return Err(resource_exhausted(
            "Subscription Awareness client capacity is exhausted",
        ));
    }
    if document > MAX_AWARENESS_CLIENTS_PER_DOCUMENT {
        return Err(resource_exhausted(
            "Document Awareness client capacity is exhausted",
        ));
    }
    Ok(())
}

fn engine_error(error: super::YrsEngineError) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: error.to_string(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError {
        code: CoreErrorCode::InvalidInput,
        message: message.into(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn unauthorized(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: message.to_owned(),
        retryable: false,
        recovery: CoreErrorRecovery::None,
    }
}

fn subscription_required(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::Unauthorized,
        message: message.to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::ReconnectDocumentSubscription,
    }
}

fn internal(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::CoreUnavailable,
        message: message.to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

fn resource_exhausted(message: &str) -> CoreError {
    CoreError {
        code: CoreErrorCode::ResourceExhausted,
        message: message.to_owned(),
        retryable: true,
        recovery: CoreErrorRecovery::None,
    }
}

#[cfg(test)]
mod capacity_tests {
    use super::*;

    #[test]
    fn subscription_and_awareness_capacity_boundaries_are_explicit() {
        assert!(
            ensure_subscription_capacity(
                MAX_DOCUMENT_SUBSCRIPTIONS - 1,
                MAX_DOCUMENT_SUBSCRIPTIONS_PER_CONNECTION - 1,
            )
            .is_ok()
        );
        assert_eq!(
            ensure_subscription_capacity(MAX_DOCUMENT_SUBSCRIPTIONS, 0)
                .expect_err("global subscription capacity")
                .code,
            CoreErrorCode::ResourceExhausted
        );
        assert_eq!(
            ensure_subscription_capacity(0, MAX_DOCUMENT_SUBSCRIPTIONS_PER_CONNECTION)
                .expect_err("connection subscription capacity")
                .code,
            CoreErrorCode::ResourceExhausted
        );
        assert!(
            ensure_awareness_capacity(
                MAX_AWARENESS_CLIENTS_PER_SUBSCRIPTION,
                MAX_AWARENESS_CLIENTS_PER_DOCUMENT,
            )
            .is_ok()
        );
        assert_eq!(
            ensure_awareness_capacity(MAX_AWARENESS_CLIENTS_PER_SUBSCRIPTION + 1, 0)
                .expect_err("subscription Awareness capacity")
                .code,
            CoreErrorCode::ResourceExhausted
        );
    }
}
